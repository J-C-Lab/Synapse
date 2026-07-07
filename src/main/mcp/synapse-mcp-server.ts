import type {
  CallToolResult,
  ListToolsResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js"
import type { JsonSchema } from "@synapse/plugin-manifest"
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RunTrace } from "../ai/run-trace-store"
import type { ToolHostPort } from "../ai/tool-registry"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { decideApproval } from "../ai/approval-gate"
import { sanitizeToolName, uniqueName } from "../ai/tool-registry"

export type McpToolExposurePolicy = "readOnlyOnly" | "all"

export interface SynapseMcpToolServiceOptions {
  exposurePolicy?: McpToolExposurePolicy
  /** Writes a per-call RunTrace when set (the substrate's trace port). */
  recordRun?: (trace: RunTrace) => void
  /** Default workspace every external call is bound to. */
  workspaceId?: string
  /** Identifies the external MCP client (from `initialize`), for the principal. */
  clientId?: string
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
      this.recordRun(entry, runId, principal, startedAt, !result.isError)
      return result
    } catch (err) {
      this.recordRun(entry, runId, principal, startedAt, false)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }

  private recordRun(
    entry: McpToolEntry,
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
      toolCalls: [{ name: entry.descriptor.fqName, startedAt, ms: endedAt - startedAt, ok }],
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
      capabilities: { tools: { listChanged: true } },
      instructions:
        "Synapse exposes enabled plugin tools. By default, only read-only tools are listed over stdio MCP.",
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, () => service.listTools())
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    return service.callTool(request.params.name, request.params.arguments ?? {}, {
      signal: extra.signal,
    })
  })

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
