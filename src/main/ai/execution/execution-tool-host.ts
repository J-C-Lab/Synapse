import type { JsonSchema } from "@synapse/plugin-manifest"
import type { ToolCaller, ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { AgentArtifactStore, ArtifactOwnerContext } from "../artifacts/artifact-types"
import type { ToolHostSource } from "../composite-tool-host"
import type { CommandArtifactCapture, CommandRunResult } from "./command-runner"
import type { ExecutionBackend, ExecutionBackendDescriptor } from "./execution-backend"
import type { ExecutionLogStore } from "./execution-log-store"
import type { WorkspaceRootRecord } from "./types"
import { classifyCommand } from "./command-policy"
import { truncatePreview } from "./command-runner"
import { createLocalPolicyExecutionBackend } from "./execution-backend"
import { listFiles, readFile, searchFiles } from "./file-tools"
import { applyPatch } from "./patch-tools"
import { WorkspacePolicy } from "./workspace-policy"

export const EXECUTION_FQ_PREFIX = "execution:"
const EXECUTION_PLUGIN_ID = "execution:core"

export interface ExecutionWorkspaceRootProvider {
  listAll: () => Promise<WorkspaceRootRecord[]>
  listForWorkspace: (workspaceId: string) => Promise<WorkspaceRootRecord[]>
}

export interface ExecutionToolHostSourceOptions {
  workspaceRoots: ExecutionWorkspaceRootProvider
  log: ExecutionLogStore
  /** Global master switch for local execution tools. When false, tools are
   *  hidden and invocations are denied even if roots exist. */
  isAllowed?: () => boolean
  now?: () => number
  /** Dispatch seam for run_command — defaults to the local, non-isolated
   *  policy backend. Command policy, workspace containment, approval, and
   *  audit all stay in front of this call. */
  backend?: ExecutionBackend
  /** When present, run_command captures stdout/stderr as durable artifacts
   *  instead of the legacy in-memory preview — but only for calls whose
   *  caller carries a runId (see buildArtifactCapture below). Optional so
   *  existing tests/callers that don't wire a store keep the legacy
   *  behavior unchanged. */
  artifactStore?: AgentArtifactStore
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): JsonSchema => ({ type: "object", properties, required })

const TOOL_DESCRIPTORS: RegisteredToolDescriptor[] = [
  {
    fqName: `${EXECUTION_PLUGIN_ID}/list_files`,
    pluginId: EXECUTION_PLUGIN_ID,
    provenance: "host",
    manifestTool: {
      name: "list_files",
      title: "List files",
      description: "List files and directories inside an authorized workspace root.",
      inputSchema: objectSchema(
        {
          rootId: { type: "string" },
          path: { type: "string", description: "Relative directory path (default .)." },
        },
        ["rootId"]
      ),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/read_file`,
    pluginId: EXECUTION_PLUGIN_ID,
    provenance: "host",
    manifestTool: {
      name: "read_file",
      title: "Read file",
      description: "Read a bounded text file inside an authorized workspace root.",
      inputSchema: objectSchema({ rootId: { type: "string" }, path: { type: "string" } }, [
        "rootId",
        "path",
      ]),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/search_files`,
    pluginId: EXECUTION_PLUGIN_ID,
    provenance: "host",
    manifestTool: {
      name: "search_files",
      title: "Search files",
      description: "Search text inside an authorized workspace root.",
      inputSchema: objectSchema(
        {
          rootId: { type: "string" },
          query: { type: "string" },
          path: { type: "string" },
        },
        ["rootId", "query"]
      ),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/apply_patch`,
    pluginId: EXECUTION_PLUGIN_ID,
    provenance: "host",
    manifestTool: {
      name: "apply_patch",
      title: "Apply patch",
      description: "Apply a unified patch inside an authorized workspace root.",
      inputSchema: objectSchema({ rootId: { type: "string" }, patch: { type: "string" } }, [
        "rootId",
        "patch",
      ]),
      annotations: { destructiveHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
    pluginId: EXECUTION_PLUGIN_ID,
    provenance: "host",
    manifestTool: {
      name: "run_command",
      title: "Run command",
      description: "Run a local command inside an authorized workspace root.",
      inputSchema: objectSchema(
        {
          rootId: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
        },
        ["rootId", "command"]
      ),
      annotations: { destructiveHint: true },
    },
  },
]

export class ExecutionToolHostSource implements ToolHostSource {
  private anyRootsExist = false
  private readonly backend: ExecutionBackend

  constructor(private readonly options: ExecutionToolHostSourceOptions) {
    this.backend = options.backend ?? createLocalPolicyExecutionBackend()
  }

  /** Refreshes the in-memory "does any root exist anywhere" gate `listTools()`
   *  reads synchronously. Call once at startup and again after any root is
   *  created or removed. */
  async refresh(): Promise<void> {
    this.anyRootsExist = (await this.options.workspaceRoots.listAll()).length > 0
  }

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(EXECUTION_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    if (!this.options.isAllowed?.()) return []
    return this.anyRootsExist ? TOOL_DESCRIPTORS : []
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    if (!this.options.isAllowed?.()) {
      const message = "agent shell is disabled"
      await this.audit({
        fqName,
        input,
        conversationId: options.caller.conversationId,
        workspaceId: options.caller.workspaceId,
        decision: "deny",
        startedAt: this.now(),
        errorPreview: message,
      })
      return errorResult(message)
    }

    const toolName = fqName.slice(`${EXECUTION_PLUGIN_ID}/`.length)
    const startedAt = this.now()
    const args = asRecord(input)
    const callerWorkspaceId = options.caller.workspaceId ?? ""
    const roots = await this.options.workspaceRoots.listForWorkspace(callerWorkspaceId)
    const requestedRootId = typeof args.rootId === "string" ? args.rootId : undefined
    const rootId = requestedRootId ?? roots.find((r) => r.role === "primary")?.id
    const root = roots.find((r) => r.id === rootId)
    if (!root) {
      const message = "root not available to this workspace"
      await this.audit({
        fqName,
        input,
        conversationId: options.caller.conversationId,
        workspaceId: options.caller.workspaceId,
        rootId: requestedRootId,
        decision: "deny",
        startedAt,
        errorPreview: message,
      })
      return errorResult(message)
    }
    const policy = new WorkspacePolicy(roots)
    const scopedInput = { ...args, rootId: root.id }

    try {
      let result: ToolResult
      switch (toolName) {
        case "list_files":
          result = await listFiles(policy, scopedInput)
          break
        case "read_file":
          result = await readFile(policy, scopedInput)
          break
        case "search_files":
          result = await searchFiles(policy, scopedInput)
          break
        case "apply_patch":
          result = await applyPatch(policy, scopedInput)
          await this.audit({
            fqName,
            input,
            conversationId: options.caller.conversationId,
            workspaceId: options.caller.workspaceId,
            rootId: root.id,
            decision: auditDecision(options),
            startedAt,
            result,
          })
          break
        case "run_command":
          result = await this.runCommand(policy, scopedInput, root.id, options)
          break
        default:
          return errorResult(`Unknown execution tool: ${toolName}`)
      }
      if (toolName !== "run_command" && toolName !== "apply_patch") {
        await this.audit({
          fqName,
          input,
          conversationId: options.caller.conversationId,
          workspaceId: options.caller.workspaceId,
          rootId: root.id,
          decision: auditDecision(options),
          startedAt,
          result,
        })
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.audit({
        fqName,
        input,
        conversationId: options.caller.conversationId,
        workspaceId: options.caller.workspaceId,
        rootId: root.id,
        decision: "allow",
        startedAt,
        errorPreview: message,
      })
      return errorResult(message)
    }
  }

  private async runCommand(
    policy: WorkspacePolicy,
    input: Record<string, unknown>,
    rootId: string,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const command = typeof input.command === "string" ? input.command : ""
    const classification = classifyCommand(command)
    if (classification.decision === "deny") {
      await this.audit({
        fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
        input,
        conversationId: options.caller.conversationId,
        workspaceId: options.caller.workspaceId,
        rootId,
        decision: "deny",
        startedAt: this.now(),
        errorPreview: classification.reason,
      })
      return errorResult(classification.reason)
    }

    const startedAt = this.now()
    const artifacts = this.buildArtifactCapture(options.caller)
    const result = await this.backend.invoke(
      {
        invocationId: crypto.randomUUID(),
        rootId,
        command,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        signal: options.signal,
        artifacts,
      },
      policy
    )
    const { payload, outputLimitExceeded, artifactIds } = buildRunCommandPayload(result)
    const toolResult = json(payload)
    const errorPreview = outputLimitExceeded
      ? "output_limit_exceeded"
      : result.exitCode === 0
        ? ""
        : `exit code ${result.exitCode ?? "unknown"}`
    await this.audit({
      fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
      input,
      conversationId: options.caller.conversationId,
      workspaceId: options.caller.workspaceId,
      rootId,
      decision: auditDecision(options),
      startedAt,
      result: toolResult,
      errorPreview,
      backendDescriptor: this.backend.descriptor,
      artifactIds,
    })
    return toolResult
  }

  /** Derives the ArtifactOwnerContext a command's stdout/stderr captures
   *  under, or `undefined` to fall back to the legacy in-memory capture.
   *
   *  Two conditions must both hold for artifact capture to apply:
   *  - the host was actually wired with an artifactStore (options.artifactStore)
   *  - the caller carries a runId — a command invoked with no run context
   *    (direct user invocation, external MCP) has no run to scope a durable
   *    artifact under; the artifact store is fundamentally
   *    `<baseDir>/<runId>/...`-scoped, so there is no synthetic id to
   *    invent here that wouldn't misrepresent the call's real identity.
   *
   *  rootRunId: subagent runs never nest (see spawn_subagent's own
   *  same-invariant guard in subagent-tool-source.ts), so the run tree is
   *  at most two levels deep — a root run, and optionally its direct
   *  subagent children. `caller.parentRunId`, when set, therefore already
   *  IS the root run id; otherwise `caller.runId` is already root-level. */
  private buildArtifactCapture(caller: ToolCaller): CommandArtifactCapture | undefined {
    if (!this.options.artifactStore || !caller.runId) return undefined
    const owner: ArtifactOwnerContext = {
      runId: caller.runId,
      rootRunId: caller.parentRunId ?? caller.runId,
      parentRunId: caller.parentRunId,
      conversationId: caller.conversationId,
      workspaceId: caller.workspaceId,
      // ToolCaller's own doc comment: "Absent ⇒ treated as { kind: 'local-user' }".
      principal: caller.principal ?? { kind: "local-user" },
    }
    return { store: this.options.artifactStore, owner }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async audit(params: {
    fqName: string
    input: unknown
    conversationId?: string
    workspaceId?: string
    rootId?: string
    decision: "allow" | "ask" | "deny" | "approved"
    startedAt: number
    result?: ToolResult
    errorPreview?: string
    backendDescriptor?: ExecutionBackendDescriptor
    artifactIds?: { stdout?: string; stderr?: string }
  }): Promise<void> {
    const args = asRecord(params.input)
    const command = typeof args.command === "string" ? args.command : ""
    const preview = params.result ? renderResult(params.result) : ""
    const endedAt = this.now()
    await this.options.log.append({
      id: crypto.randomUUID(),
      conversationId: params.conversationId,
      toolName: params.fqName,
      workspaceId: params.workspaceId,
      rootId: params.rootId,
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      normalizedPaths: typeof args.path === "string" ? [args.path] : [],
      decision: params.decision,
      startedAt: params.startedAt,
      endedAt,
      inputPreview: (command || JSON.stringify(args)).slice(0, 2000),
      // Always a bounded preview string, never the full/raw captured
      // output — the full bytes (when artifact-captured) live only in the
      // artifact store, addressed by stdoutArtifactId/stderrArtifactId
      // below, never inlined into the audit log.
      outputPreview: preview.slice(0, 2000),
      errorPreview: params.errorPreview ?? "",
      backendId: params.backendDescriptor?.backendId,
      backendIsolation: params.backendDescriptor?.isolation,
      backendReplayGuarantee: params.backendDescriptor?.replayGuarantee,
      stdoutArtifactId: params.artifactIds?.stdout,
      stderrArtifactId: params.artifactIds?.stderr,
    })
  }
}

function auditDecision(options: ToolInvocationOptions): "allow" | "approved" {
  return options.executionAuditDecision === "approved" ? "approved" : "allow"
}

/** Builds run_command's tool-facing JSON payload from a CommandRunResult,
 *  branching on which capture path actually ran:
 *
 *  - artifact-backed (result.stdout/result.stderr present): both streams'
 *    artifact URIs, bounded head+tail previews, and complete/
 *    truncationReason are surfaced directly — run_command carries its own
 *    bespoke artifact-ref shape rather than a generic single
 *    ChatContentBlock.tool_result.artifact field (that generalization is
 *    Task 19's job for tool-results broadly). When either stream was cut
 *    short for a hard-limit reason, `error: "output_limit_exceeded"` is
 *    added so the payload can never silently read as a clean, complete
 *    result.
 *  - legacy (result.legacyStdout/result.legacyStderr present): unchanged
 *    shape from before this task. */
function buildRunCommandPayload(result: CommandRunResult): {
  payload: Record<string, unknown>
  outputLimitExceeded: boolean
  artifactIds?: { stdout?: string; stderr?: string }
} {
  if (result.stdout && result.stderr) {
    const outputLimitExceeded = !result.stdout.artifact.complete || !result.stderr.artifact.complete
    const payload: Record<string, unknown> = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdout: {
        headPreview: result.stdout.headPreview,
        tailPreview: result.stdout.tailPreview,
        artifactUri: result.stdout.artifact.uri,
        artifactId: result.stdout.artifact.artifactId,
        capturedBytes: result.stdout.artifact.capturedBytes,
        complete: result.stdout.artifact.complete,
        truncationReason: result.stdout.artifact.truncationReason,
      },
      stderr: {
        headPreview: result.stderr.headPreview,
        tailPreview: result.stderr.tailPreview,
        artifactUri: result.stderr.artifact.uri,
        artifactId: result.stderr.artifact.artifactId,
        capturedBytes: result.stderr.artifact.capturedBytes,
        complete: result.stderr.artifact.complete,
        truncationReason: result.stderr.artifact.truncationReason,
      },
    }
    if (outputLimitExceeded) payload.error = "output_limit_exceeded"
    return {
      payload,
      outputLimitExceeded,
      artifactIds: {
        stdout: result.stdout.artifact.artifactId,
        stderr: result.stderr.artifact.artifactId,
      },
    }
  }

  const stdout = truncatePreview(result.legacyStdout ?? "")
  const stderr = truncatePreview(result.legacyStderr ?? "")
  return {
    payload: {
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdoutTruncated: result.stdoutTruncated || stdout.truncated,
      stderrTruncated: result.stderrTruncated || stderr.truncated,
    },
    outputLimitExceeded: false,
  }
}

function renderResult(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
    .join("\n")
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
