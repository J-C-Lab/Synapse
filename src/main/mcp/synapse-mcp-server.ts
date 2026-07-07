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
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
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
  /** Backs `resources/list` + `resources/read` over long-term memory. Omit to disable resources entirely. */
  memory?: MemoryResourcePort
  /** Whether global-visibility memories are listed/readable for this external caller. Default false (§4a). */
  memoryIncludeGlobal?: boolean
  /** Hard cap on `resources/list` (no cursor pagination in this phase, §4b). Default 200. */
  memoryListLimit?: number
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

  listTools(): ListToolsResult {
    return {
      tools: this.refresh()
        .filter((entry) => this.shouldExpose(entry.descriptor))
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
    if (!this.shouldExpose(entry.descriptor)) {
      return errorResult(`Synapse MCP policy does not expose tool: ${entry.descriptor.fqName}`)
    }

    const runId = randomUUID()
    const startedAt = Date.now()
    const principal = { kind: "external-mcp" as const, clientId: this.options.clientId }
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
    if (!this.options.memory) return { resources: [] }
    const scope = this.resourceScope()
    const entries = await this.options.memory.list(this.options.memoryListLimit ?? 200, scope)

    const runId = randomUUID()
    const startedAt = Date.now()
    const principal = { kind: "external-mcp" as const, clientId: this.options.clientId }
    this.recordTrace("resources/list", runId, principal, startedAt, true)

    return {
      resources: entries.map((entry) => ({
        uri: toResourceUri(entry.id),
        name: summarize(entry.text),
        mimeType: "text/plain",
        ...(entry.tags.length > 0 ? { description: entry.tags.join(", ") } : {}),
      })),
    }
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const runId = randomUUID()
    const startedAt = Date.now()
    const principal = { kind: "external-mcp" as const, clientId: this.options.clientId }
    const id = parseResourceId(uri)
    const entry =
      id && this.options.memory
        ? await this.options.memory.get(id, this.resourceScope())
        : undefined

    if (!entry) {
      this.recordTrace(`resources/read:${uri}`, runId, principal, startedAt, false)
      throw new Error(`Unknown Synapse resource: ${uri}`)
    }

    this.recordTrace(`resources/read:${uri}`, runId, principal, startedAt, true)
    return { contents: [{ uri, mimeType: "text/plain", text: entry.text }] }
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

  private shouldExpose(descriptor: RegisteredToolDescriptor): boolean {
    if (this.options.exposurePolicy === "all") return true
    return decideApproval(descriptor.manifestTool.annotations) === "allow"
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
  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    service.readResource(request.params.uri)
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

const MEMORY_RESOURCE_PREFIX = "synapse://memory/"

function toResourceUri(id: string): string {
  return `${MEMORY_RESOURCE_PREFIX}${encodeURIComponent(id)}`
}

function parseResourceId(uri: string): string | undefined {
  if (!uri.startsWith(MEMORY_RESOURCE_PREFIX)) return undefined
  const id = uri.slice(MEMORY_RESOURCE_PREFIX.length)
  return id ? decodeURIComponent(id) : undefined
}

function summarize(text: string, maxChars = 60): string {
  const trimmed = text.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed
}
