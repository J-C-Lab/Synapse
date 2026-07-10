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
import type { RunTrace } from "../ai/run-trace-store"
import type { ToolHostPort } from "../ai/tool-registry"
import type { GrantIdentity } from "../plugins/grant-store"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
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
import { sanitizeToolName, uniqueName } from "../ai/tool-registry"
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
  /** Writes a per-call RunTrace when set (the substrate's trace port). */
  recordRun?: (trace: RunTrace) => void
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

  constructor(
    private readonly host: ToolHostPort,
    private readonly options: SynapseMcpToolServiceOptions = {}
  ) {}

  async listTools(): Promise<ListToolsResult> {
    const entries = this.refresh()
    const included = await Promise.all(
      entries.map(async (entry) =>
        (await this.shouldExpose(entry.descriptor)) ? entry : undefined
      )
    )
    return {
      tools: included
        .filter((entry): entry is McpToolEntry => entry !== undefined)
        .map((entry) => {
          const tool = entry.descriptor.manifestTool
          return {
            name: entry.safeName,
            title: localizedString(tool.title),
            description: tool.description,
            inputSchema: mcpObjectSchema(tool.inputSchema),
            outputSchema: tool.outputSchema ? mcpObjectSchema(tool.outputSchema) : undefined,
            annotations: mcpAnnotations(tool.annotations),
          }
        }),
    }
  }

  async callTool(
    safeName: string,
    input: unknown,
    options: Pick<ToolInvocationOptions, "signal" | "progress"> = {}
  ): Promise<CallToolResult> {
    let entry = this.safeToEntry.get(safeName)
    if (!entry) {
      this.refresh()
      entry = this.safeToEntry.get(safeName)
    }

    if (!entry) {
      return errorResult(`Unknown Synapse tool: ${safeName}`)
    }
    if (!(await this.shouldExpose(entry.descriptor))) {
      return errorResult(`Synapse MCP policy does not expose tool: ${entry.descriptor.fqName}`)
    }

    const runId = randomUUID()
    const startedAt = Date.now()
    const principal = this.principal()
    try {
      const result = toMcpResult(
        await this.host.invokeTool(entry.descriptor.fqName, input, {
          caller: {
            kind: "mcp",
            runId,
            principal,
            workspaceId: this.options.workspaceId,
          },
          signal: options.signal,
          progress: options.progress,
        })
      )
      this.recordTrace(entry.descriptor.fqName, runId, principal, startedAt, !result.isError)
      return result
    } catch (err) {
      this.recordTrace(entry.descriptor.fqName, runId, principal, startedAt, false)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }

  async listResources(): Promise<ListResourcesResult> {
    const runId = randomUUID()
    const startedAt = Date.now()
    const [memoryResources, workspaceInstructionResources] = await Promise.all([
      this.listMemoryResources(),
      this.listWorkspaceInstructionResources(),
    ])
    this.recordTrace("resources/list", runId, this.principal(), startedAt, true)
    return { resources: [...memoryResources, ...workspaceInstructionResources] }
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
    if (uri.startsWith(MEMORY_RESOURCE_PREFIX)) return this.readMemoryResource(uri)
    if (uri.startsWith(WORKSPACE_INSTRUCTIONS_PREFIX)) {
      return this.readWorkspaceInstructionsResource(uri, options.signal)
    }
    throw new Error(`Unknown Synapse resource: ${uri}`)
  }

  private async readMemoryResource(uri: string): Promise<ReadResourceResult> {
    const runId = randomUUID()
    const startedAt = Date.now()
    const id = parseResourceId(uri)
    const entry =
      id && this.options.memory
        ? await this.options.memory.get(id, this.resourceScope())
        : undefined

    if (!entry) {
      this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, false)
      throw new Error(`Unknown Synapse resource: ${uri}`)
    }

    this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, true)
    return { contents: [{ uri, mimeType: "text/plain", text: entry.text }] }
  }

  private async readWorkspaceInstructionsResource(
    uri: string,
    signal: AbortSignal | undefined
  ): Promise<ReadResourceResult> {
    const runId = randomUUID()
    const startedAt = Date.now()
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
      this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, false)
      throw new Error(`Unknown Synapse resource: ${uri}`)
    }
    this.recordTrace(`resources/read:${uri}`, runId, this.principal(), startedAt, true)
    return { contents: [{ uri, mimeType: "text/plain", text: content.text }] }
  }

  private principal(): { kind: "external-mcp"; clientId?: string } {
    return { kind: "external-mcp", clientId: this.options.clientId }
  }

  private resourceScope(): MemoryQueryScope {
    return {
      workspaceId: this.options.workspaceId,
      includeGlobal: this.options.memoryIncludeGlobal ?? false,
    }
  }

  private recordTrace(
    name: string,
    runId: string,
    principal: { kind: "external-mcp"; clientId?: string },
    startedAt: number,
    ok: boolean
  ): void {
    if (!this.options.recordRun) return
    const endedAt = Date.now()
    this.options.recordRun({
      runId,
      origin: "mcp",
      principal,
      workspaceId: this.options.workspaceId,
      startedAt,
      endedAt,
      outcome: ok ? "end_turn" : "error",
      toolCalls: [{ name, startedAt, ms: endedAt - startedAt, ok }],
    })
  }

  private refresh(): McpToolEntry[] {
    this.safeToEntry.clear()
    const used = new Set<string>()
    return this.host.listTools().map((descriptor) => {
      const safeName = uniqueName(sanitizeToolName(descriptor.fqName), used)
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
