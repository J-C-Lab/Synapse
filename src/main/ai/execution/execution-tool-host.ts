import type { JsonSchema } from "@synapse/plugin-manifest"
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { ExecutionLogStore } from "./execution-log-store"
import type { WorkspaceRoot } from "./types"
import { classifyCommand } from "./command-policy"
import { runCommand, truncatePreview } from "./command-runner"
import { listFiles, readFile, searchFiles } from "./file-tools"
import { applyPatch } from "./patch-tools"
import { WorkspacePolicy } from "./workspace-policy"

export const EXECUTION_FQ_PREFIX = "execution:"
const EXECUTION_PLUGIN_ID = "execution:core"

export interface ExecutionWorkspaceProvider {
  listWorkspaces: () => WorkspaceRoot[]
}

export interface ExecutionToolHostSourceOptions {
  workspaces: ExecutionWorkspaceProvider
  log: ExecutionLogStore
  now?: () => number
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): JsonSchema => ({ type: "object", properties, required })

const TOOL_DESCRIPTORS: RegisteredToolDescriptor[] = [
  {
    fqName: `${EXECUTION_PLUGIN_ID}/list_files`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "list_files",
      title: "List files",
      description: "List files and directories inside an authorized workspace.",
      inputSchema: objectSchema(
        {
          workspaceId: { type: "string" },
          path: { type: "string", description: "Relative directory path (default .)." },
        },
        ["workspaceId"]
      ),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/read_file`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "read_file",
      title: "Read file",
      description: "Read a bounded text file inside an authorized workspace.",
      inputSchema: objectSchema({ workspaceId: { type: "string" }, path: { type: "string" } }, [
        "workspaceId",
        "path",
      ]),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/search_files`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "search_files",
      title: "Search files",
      description: "Search text inside an authorized workspace.",
      inputSchema: objectSchema(
        {
          workspaceId: { type: "string" },
          query: { type: "string" },
          path: { type: "string" },
        },
        ["workspaceId", "query"]
      ),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/apply_patch`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "apply_patch",
      title: "Apply patch",
      description: "Apply a unified patch inside an authorized workspace.",
      inputSchema: objectSchema({ workspaceId: { type: "string" }, patch: { type: "string" } }, [
        "workspaceId",
        "patch",
      ]),
      annotations: { destructiveHint: true },
    },
  },
  {
    fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
    pluginId: EXECUTION_PLUGIN_ID,
    manifestTool: {
      name: "run_command",
      title: "Run command",
      description: "Run a local command inside an authorized workspace.",
      inputSchema: objectSchema(
        {
          workspaceId: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
        },
        ["workspaceId", "command"]
      ),
      annotations: { destructiveHint: true },
    },
  },
]

export class ExecutionToolHostSource implements ToolHostSource {
  constructor(private readonly options: ExecutionToolHostSourceOptions) {}

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(EXECUTION_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    const roots = this.options.workspaces.listWorkspaces()
    return roots.length > 0 ? TOOL_DESCRIPTORS : []
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const policy = await this.policy()
    const toolName = fqName.slice(`${EXECUTION_PLUGIN_ID}/`.length)
    const startedAt = this.now()
    try {
      let result: ToolResult
      switch (toolName) {
        case "list_files":
          result = await listFiles(policy, input)
          break
        case "read_file":
          result = await readFile(policy, input)
          break
        case "search_files":
          result = await searchFiles(policy, input)
          break
        case "apply_patch":
          result = await applyPatch(policy, input)
          await this.audit({
            fqName,
            input,
            conversationId: options.caller.conversationId,
            decision: auditDecision(options),
            startedAt,
            result,
          })
          break
        case "run_command":
          result = await this.runCommand(policy, input, options)
          break
        default:
          return errorResult(`Unknown execution tool: ${toolName}`)
      }
      if (toolName !== "run_command" && toolName !== "apply_patch") {
        await this.audit({
          fqName,
          input,
          conversationId: options.caller.conversationId,
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
        decision: "allow",
        startedAt,
        errorPreview: message,
      })
      return errorResult(message)
    }
  }

  private async runCommand(
    policy: WorkspacePolicy,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const args = asRecord(input)
    const command = typeof args.command === "string" ? args.command : ""
    const classification = classifyCommand(command)
    if (classification.decision === "deny") {
      await this.audit({
        fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
        input,
        conversationId: options.caller.conversationId,
        decision: "deny",
        startedAt: this.now(),
        errorPreview: classification.reason,
      })
      return errorResult(classification.reason)
    }

    const startedAt = this.now()
    const result = await runCommand(
      policy,
      {
        workspaceId: requireString(args.workspaceId, "workspaceId"),
        command,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      },
      options.signal
    )
    const stdout = truncatePreview(result.stdout)
    const stderr = truncatePreview(result.stderr)
    const payload = {
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdoutTruncated: result.stdoutTruncated || stdout.truncated,
      stderrTruncated: result.stderrTruncated || stderr.truncated,
    }
    const toolResult = json(payload)
    await this.audit({
      fqName: `${EXECUTION_PLUGIN_ID}/run_command`,
      input,
      conversationId: options.caller.conversationId,
      decision: auditDecision(options),
      startedAt,
      result: toolResult,
      errorPreview: result.exitCode === 0 ? "" : `exit code ${result.exitCode ?? "unknown"}`,
    })
    return toolResult
  }

  private async policy(): Promise<WorkspacePolicy> {
    const roots = this.options.workspaces.listWorkspaces()
    if (roots.length === 0) throw new Error("No authorized workspace is configured")
    return new WorkspacePolicy(roots)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async audit(params: {
    fqName: string
    input: unknown
    conversationId?: string
    decision: "allow" | "ask" | "deny" | "approved"
    startedAt: number
    result?: ToolResult
    errorPreview?: string
  }): Promise<void> {
    const args = asRecord(params.input)
    const command = typeof args.command === "string" ? args.command : ""
    const preview = params.result ? renderResult(params.result) : ""
    const endedAt = this.now()
    await this.options.log.append({
      id: crypto.randomUUID(),
      conversationId: params.conversationId,
      toolName: params.fqName,
      workspaceId: typeof args.workspaceId === "string" ? args.workspaceId : undefined,
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      normalizedPaths: typeof args.path === "string" ? [args.path] : [],
      decision: params.decision,
      startedAt: params.startedAt,
      endedAt,
      inputPreview: (command || JSON.stringify(args)).slice(0, 2000),
      outputPreview: preview.slice(0, 2000),
      errorPreview: params.errorPreview ?? "",
    })
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`)
  return value
}

function auditDecision(options: ToolInvocationOptions): "allow" | "approved" {
  return options.executionAuditDecision === "approved" ? "approved" : "allow"
}
