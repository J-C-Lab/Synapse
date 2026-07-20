import type {
  CallToolResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js"
import type { JsonSchema } from "@synapse/plugin-manifest"
import type { ToolResult } from "@synapse/plugin-sdk"
import type { MemoryQueryScope } from "../ai/memory/memory-scope"
import type { MemoryEntry } from "../ai/memory/memory-store"
import type { RunProvenance } from "../ai/run-provenance"
import type { ToolHostPort } from "../ai/tool-registry"
import type { WorkspaceStore } from "../ai/workspace/workspace-store"
import type { GrantIdentity } from "../plugins/grant-store"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { McpDurableRunPort } from "./mcp-durable-run"
import type { McpWorkspaceBinding } from "./mcp-workspace-binding"
import type { WorkspaceInstructionsResourcePort } from "./workspace-instructions-resource"
import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { decideApproval } from "../ai/approval-gate"
import { projectModelVisibleTool, sanitizeTitle, warnOnce } from "../ai/guardrails/tool-metadata"
import { buildMcpRun, toToolCaller } from "../ai/run-provenance"
import { modelToolName, uniqueName } from "../ai/tool-registry"
import { logger } from "../logging"
import { assertWorkspaceAdmitted, McpUnboundError } from "./mcp-workspace-admission"
import { WORKSPACE_INSTRUCTIONS_PREFIX } from "./workspace-instructions-resource"

const MEMORY_RESOURCE_PREFIX = "synapse://memory/"

function toMemoryResourceUri(id: string): string {
  return `${MEMORY_RESOURCE_PREFIX}${encodeURIComponent(id)}`
}

function parseResourceId(uri: string): string | undefined {
  if (!uri.startsWith(MEMORY_RESOURCE_PREFIX)) return undefined
  const id = uri.slice(MEMORY_RESOURCE_PREFIX.length)
  if (!id) return undefined
  try {
    return decodeURIComponent(id)
  } catch {
    return undefined
  }
}

export type McpToolExposurePolicy = "readOnlyOnly" | "all"

/** Minimal read surface `SynapseMcpToolService` needs to serve memory as MCP resources. */
export interface MemoryResourcePort {
  list: (limit: number, scope: MemoryQueryScope) => Promise<MemoryEntry[]>
  get: (id: string, scope: MemoryQueryScope) => Promise<MemoryEntry | undefined>
}

export interface SynapseMcpToolServiceOptions {
  exposurePolicy?: McpToolExposurePolicy
  /** Default workspace every external call is bound to. */
  workspaceId?: string
  /** Identifies the external MCP client (from `initialize`), for the principal. */
  clientId?: string
  /** Backs `resources/list` + `resources/read` over long-term memory. Omit to disable this resource kind entirely. */
  memory?: MemoryResourcePort
  /** Backs `resources/list` + `resources/read` over workspace-instructions
   *  (AGENTS.md/CLAUDE.md). Omit to disable this resource kind entirely. */
  workspaceInstructions?: WorkspaceInstructionsResourcePort
  /** Whether global-visibility memories are listed/readable for this external caller. Default false (§4a). */
  memoryIncludeGlobal?: boolean
  /** Hard cap on `resources/list` (no cursor pagination in this phase, §4b). Default 200. */
  memoryListLimit?: number
  /** Backs the per-plugin non-read-only exposure toggle. Omit to disable
   *  entirely (every non-read-only tool stays unexposed — today's behavior). */
  exposure?: { isNonReadOnlyExposed: (identity: GrantIdentity) => Promise<boolean> }
  /** Synchronous identity lookup — both hosts keep their plugin registry in
   *  memory, so this never needs to be async. Returns undefined for an
   *  unknown pluginId (denies exposure). */
  identityForPlugin?: (pluginId: string) => GrantIdentity | undefined
  /** The external caller's workspace binding, resolved once via
   *  resolveMcpWorkspaceBinding() and threaded through unchanged for the
   *  service's lifetime. Absent defaults to unbound (fail-closed) — every
   *  construction site must make this an explicit choice, not an accident. */
  workspaceBinding?: McpWorkspaceBinding
  /** Read access for the admission check. Absent defaults to "nothing
   *  resolves" (fail-closed, matches the unbound default above). */
  workspaces?: Pick<WorkspaceStore, "get">
  /** Called at most once per service instance, the first time an unbound
   *  binding is actually rejected — lets the caller log the migration
   *  message to stderr without flooding it on every poll. */
  onUnboundWarning?: () => void
  /** Production stdio wiring supplies this shared checkpoint/finalization
   * adapter. Unit-only in-memory services may omit it when they do not need
   * persistence, but runSynapseMcpStdioServer rejects that configuration. */
  durableRuns?: McpDurableRunPort
  /** Injectable clock for durable MCP trace timing. */
  now?: () => number
}

export interface SynapseMcpServerOptions extends SynapseMcpToolServiceOptions {
  name?: string
  version?: string
}

interface McpToolEntry {
  safeName: string
  descriptor: RegisteredToolDescriptor
}

type McpObjectSchema = ListToolsResult["tools"][number]["inputSchema"]

export class SynapseMcpToolService {
  private safeToEntry = new Map<string, McpToolEntry>()
  private exclusionWarnings = new Map<string, string>()
  private unboundWarned = false

  constructor(
    private readonly host: ToolHostPort,
    private readonly options: SynapseMcpToolServiceOptions = {}
  ) {}

  private async admit(): Promise<void> {
    try {
      await assertWorkspaceAdmitted(
        this.options.workspaceBinding ?? { kind: "unbound" },
        this.options.workspaces ?? { get: async () => undefined }
      )
    } catch (err) {
      if (err instanceof McpUnboundError && !this.unboundWarned) {
        this.unboundWarned = true
        this.options.onUnboundWarning?.()
      }
      throw err
    }
  }

  async listTools(): Promise<ListToolsResult> {
    // Discovery is intentionally not a run: MCP clients poll tools/list
    // frequently, and there is no host invocation or terminal operation to
    // audit. Recording it would turn polling into unbounded checkpoints.
    await this.admit()
    const entries = this.refresh()
    const included = await Promise.all(
      entries.map(async (entry) =>
        (await this.shouldExpose(entry.descriptor)) ? entry : undefined
      )
    )
    const tools: ListToolsResult["tools"] = []
    for (const entry of included) {
      if (!entry) continue
      const tool = entry.descriptor.manifestTool
      const projected = projectModelVisibleTool({
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        provenance: entry.descriptor.provenance,
      })
      if (!projected.ok) {
        warnOnce(this.exclusionWarnings, entry.descriptor.fqName, projected.reason, (msg) =>
          logger.warn(msg)
        )
        continue
      }
      tools.push({
        name: entry.safeName,
        title: sanitizeTitle(localizedString(tool.title), entry.descriptor.provenance),
        description: projected.description,
        inputSchema: mcpObjectSchema(projected.inputSchema),
        outputSchema: projected.outputSchema ? mcpObjectSchema(projected.outputSchema) : undefined,
        annotations: mcpAnnotations(tool.annotations),
      })
    }
    return { tools }
  }

  async callTool(
    safeName: string,
    input: unknown,
    options: Pick<ToolInvocationOptions, "signal" | "progress"> = {}
  ): Promise<CallToolResult> {
    await this.admit()
    let entry = this.safeToEntry.get(safeName)
    if (!entry) {
      this.refresh()
      entry = this.safeToEntry.get(safeName)
    }
    if (!entry) {
      return this.observe(`mcp:unknown-tool:${safeName}`, async () =>
        errorResult(`Unknown Synapse tool: ${safeName}`)
      )
    }

    // The checkpoint is created immediately before this function can cross
    // into the host. The descriptor's canonical fqName is frozen there, so
    // an interrupted host invocation cannot later degrade to a generic trace.
    const operation = entry.descriptor.fqName
    return this.observe(
      operation,
      async (provenance) => {
        if (!(await this.shouldExpose(entry.descriptor))) {
          return errorResult(`Synapse MCP policy does not expose tool: ${entry.descriptor.fqName}`)
        }

        const tool = entry.descriptor.manifestTool
        const projected = projectModelVisibleTool({
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          provenance: entry.descriptor.provenance,
        })
        if (!projected.ok) {
          return errorResult(
            `Synapse MCP policy does not expose tool: ${entry.descriptor.fqName} (${projected.reason})`
          )
        }

        try {
          return toMcpResult(
            await this.host.invokeTool(entry.descriptor.fqName, input, {
              caller: toToolCaller(provenance),
              signal: options.signal,
              progress: options.progress,
            })
          )
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err))
        }
      },
      (result) => !result.isError
    )
  }

  async listResources(): Promise<ListResourcesResult> {
    return this.observe("resources/list", async () => {
      await this.admit()
      const [memoryResources, workspaceInstructionResources] = await Promise.all([
        this.listMemoryResources(),
        this.listWorkspaceInstructionResources(),
      ])
      return { resources: [...memoryResources, ...workspaceInstructionResources] }
    })
  }

  private async listMemoryResources(): Promise<ListResourcesResult["resources"]> {
    if (!this.options.memory) return []
    const scope = this.resourceScope()
    const entries = await this.options.memory.list(this.options.memoryListLimit ?? 200, scope)
    return entries.map((entry) => ({
      uri: toMemoryResourceUri(entry.id),
      name: summarize(entry.text),
      mimeType: "text/plain",
      ...(entry.tags.length > 0 ? { description: entry.tags.join(", ") } : {}),
    }))
  }

  private async listWorkspaceInstructionResources(): Promise<ListResourcesResult["resources"]> {
    if (!this.options.workspaceInstructions || !this.options.workspaceId) return []
    const descriptors = await this.options.workspaceInstructions.list(this.options.workspaceId)
    return descriptors.map((d) => ({ uri: d.uri, name: d.fileName, mimeType: "text/plain" }))
  }

  async readResource(
    uri: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<ReadResourceResult> {
    return this.observe(`resources/read:${uri}`, async () => {
      await this.admit()
      if (uri.startsWith(MEMORY_RESOURCE_PREFIX)) return this.readMemoryResource(uri)
      if (uri.startsWith(WORKSPACE_INSTRUCTIONS_PREFIX)) {
        return this.readWorkspaceInstructionsResource(uri, options.signal)
      }
      throw new Error(`Unknown Synapse resource: ${uri}`)
    })
  }

  private async readMemoryResource(uri: string): Promise<ReadResourceResult> {
    const id = parseResourceId(uri)
    const entry =
      id && this.options.memory
        ? await this.options.memory.get(id, this.resourceScope())
        : undefined

    if (!entry) {
      throw new Error(`Unknown Synapse resource: ${uri}`)
    }

    return { contents: [{ uri, mimeType: "text/plain", text: entry.text }] }
  }

  private async readWorkspaceInstructionsResource(
    uri: string,
    signal: AbortSignal | undefined
  ): Promise<ReadResourceResult> {
    const content =
      this.options.workspaceInstructions && this.options.workspaceId
        ? await this.options.workspaceInstructions.read({
            workspaceId: this.options.workspaceId,
            uri,
            clientId: this.options.clientId,
            signal,
          })
        : undefined

    if (!content) {
      throw new Error(`Unknown Synapse resource: ${uri}`)
    }
    return { contents: [{ uri, mimeType: "text/plain", text: content.text }] }
  }

  private resourceScope(): MemoryQueryScope {
    return {
      workspaceId: this.options.workspaceId,
      includeGlobal: this.options.memoryIncludeGlobal ?? false,
    }
  }

  private async observe<T>(
    operation: string,
    execute: (provenance: Extract<RunProvenance, { origin: "mcp" }>) => Promise<T>,
    succeeded: (result: T) => boolean = () => true
  ): Promise<T> {
    const provenance = buildMcpRun({
      runId: randomUUID(),
      workspaceId: this.options.workspaceId,
      clientId: this.options.clientId,
    })
    const startedAt = (this.options.now ?? Date.now)()
    const durable = this.options.durableRuns
    if (!durable) return execute(provenance)

    await durable.begin({ provenance, operation })
    try {
      const result = await execute(provenance)
      const ok = succeeded(result)
      await durable.finalize({
        provenance,
        startedAt,
        endedAt: (this.options.now ?? Date.now)(),
        ok,
        ...(ok ? {} : { error: "tool-error" as const }),
      })
      return result
    } catch (err) {
      await durable.finalize({
        provenance,
        startedAt,
        endedAt: (this.options.now ?? Date.now)(),
        ok: false,
        error: "exception",
      })
      throw err
    }
  }

  private refresh(): McpToolEntry[] {
    this.safeToEntry.clear()
    const used = new Set<string>()
    return this.host.listTools().map((descriptor) => {
      const safeName = uniqueName(modelToolName(descriptor), used)
      used.add(safeName)
      const entry = { safeName, descriptor }
      this.safeToEntry.set(safeName, entry)
      return entry
    })
  }

  private async shouldExpose(descriptor: RegisteredToolDescriptor): Promise<boolean> {
    if (this.options.exposurePolicy === "all") return true
    if (decideApproval(descriptor.manifestTool.annotations) === "allow") return true
    const identity = this.options.identityForPlugin?.(descriptor.pluginId)
    if (!identity || !this.options.exposure) return false
    return this.options.exposure.isNonReadOnlyExposed(identity)
  }
}

export function createSynapseMcpServer(
  host: ToolHostPort,
  options: SynapseMcpServerOptions = {}
): Server {
  const service = new SynapseMcpToolService(host, options)
  const server = new Server(
    { name: options.name ?? "synapse", version: options.version ?? "0.3.0" },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      instructions:
        "Synapse exposes enabled plugin tools and, when configured, long-term memory as read-only resources. By default, only read-only tools are listed over stdio MCP.",
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, () => service.listTools())
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    return service.callTool(request.params.name, request.params.arguments ?? {}, {
      signal: extra.signal,
    })
  })
  server.setRequestHandler(ListResourcesRequestSchema, () => service.listResources())
  server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
    service.readResource(request.params.uri, { signal: extra.signal })
  )

  return server
}

export async function runSynapseMcpStdioServer(
  host: ToolHostPort,
  options: SynapseMcpServerOptions = {}
): Promise<Server> {
  if (!options.durableRuns) {
    throw new Error("Synapse MCP stdio requires a durable run finalization adapter")
  }
  const server = createSynapseMcpServer(host, options)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return server
}

function toMcpResult(result: ToolResult): CallToolResult {
  const out: CallToolResult = {
    content: result.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text }
      if (block.type === "json") return { type: "text", text: JSON.stringify(block.json) }
      return { type: "text", text: `[image: ${block.path}]` }
    }),
    isError: result.isError,
  }

  if (isRecord(result.structured)) out.structuredContent = result.structured
  return out
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

function mcpAnnotations(
  annotations: RegisteredToolDescriptor["manifestTool"]["annotations"]
): ToolAnnotations | undefined {
  if (!annotations) return undefined
  return {
    readOnlyHint: annotations.readOnlyHint,
    destructiveHint: annotations.destructiveHint,
    idempotentHint: annotations.idempotentHint,
  }
}

function localizedString(
  value: RegisteredToolDescriptor["manifestTool"]["title"]
): string | undefined {
  if (!value) return undefined
  if (typeof value === "string") return value
  return value.en ?? Object.values(value)[0]
}

function mcpObjectSchema(schema: JsonSchema): McpObjectSchema {
  const out: McpObjectSchema = { type: "object" }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" || key === "properties" || key === "required") continue
    out[key] = value
  }
  if (schema.required) out.required = schema.required
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).filter((entry): entry is [string, object] =>
        isRecord(entry[1])
      )
    )
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function summarize(text: string, maxChars = 60): string {
  const trimmed = text.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed
}
