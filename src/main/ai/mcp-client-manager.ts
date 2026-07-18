import type { JsonSchema, ManifestTool, ToolAnnotations } from "@synapse/plugin-manifest"
import type { ToolContentBlock, ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ToolHostSource } from "./composite-tool-host"
import type { WorkspaceRoot } from "./execution/types"
import type { McpServerConfig } from "./mcp-server-config-store"
import { logger } from "../logging"
import { projectModelVisibleTool } from "./guardrails/tool-metadata"
import { boundNonStreamingToolResult } from "./tool-result-boundary"

// MCP client side (P5, inbound): connect to external MCP servers over stdio and
// surface their tools to the built-in agent. Each server's tools enter the
// shared registry under the `mcp:<serverId>/<tool>` namespace, then go through
// the same provider-name sanitization and approval flow as plugin tools.
//
// External servers are not trusted: their annotations are advisory only. We
// keep the uniform approval rule (read-only auto-runs, everything else asks) —
// enabling a server is itself a deliberate trust decision, and the user can
// remember an allow-decision per conversation or permanently.
//
// The transport/SDK is injected through `McpClientFactory` so the manager is
// testable without spawning child processes (mirrors AnthropicMessagesClient).

export const MCP_FQ_PREFIX = "mcp:"

/** Tool shape as returned by an MCP server's `tools/list`. */
export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
  }
}

/** One content block of an MCP `tools/call` result. */
export interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
  resource?: { text?: string; uri?: string }
  [key: string]: unknown
}

export interface McpCallResult {
  content?: McpContentBlock[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

/** Minimal slice of the MCP SDK Client the manager drives. */
export interface McpClientPort {
  connect: () => Promise<void>
  listTools: () => Promise<{ tools: McpToolDefinition[] }>
  callTool: (
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal }
  ) => Promise<McpCallResult>
  close: () => Promise<void>
  /** Present only for a connection that advertised the roots capability. */
  notifyRootsChanged?: () => Promise<void>
  /** MCP initialize response identity, when the transport exposes it. */
  serverVersion?: () => string | undefined
}

export type McpClientFactory = (
  config: McpServerConfig,
  getExecutionWorkspaces: () => Promise<WorkspaceRoot[]>
) => McpClientPort

export type McpConnectionState = "connecting" | "connected" | "disconnected" | "error"

export interface McpServerStatus {
  id: string
  name?: string
  enabled: boolean
  state: McpConnectionState
  toolCount: number
  error?: string
}

interface Connection {
  config: McpServerConfig
  client?: McpClientPort
  state: McpConnectionState
  error?: string
  tools: RegisteredToolDescriptor[]
}

export class McpClientManager implements ToolHostSource {
  private readonly connections = new Map<string, Connection>()

  constructor(
    private readonly createClient: McpClientFactory,
    private readonly getExecutionWorkspaces: () => Promise<WorkspaceRoot[]> = async () => []
  ) {}

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(MCP_FQ_PREFIX)
  }

  /** Tools of all currently connected servers, as registry descriptors. */
  listTools(): RegisteredToolDescriptor[] {
    const out: RegisteredToolDescriptor[] = []
    for (const conn of this.connections.values()) {
      if (conn.state === "connected") out.push(...conn.tools)
    }
    return out
  }

  /** Per-server connection state for the UI. */
  status(): McpServerStatus[] {
    return [...this.connections.values()].map((conn) => ({
      id: conn.config.id,
      name: conn.config.name,
      enabled: conn.config.enabled !== false,
      state: conn.state,
      toolCount: conn.tools.length,
      error: conn.error,
    }))
  }

  /** Replace all connections and connect every enabled server. */
  async start(configs: McpServerConfig[]): Promise<void> {
    await this.dispose()
    await Promise.all(configs.map((config) => this.connect(config)))
  }

  /** Tear down any prior connection for this id, then connect it afresh. */
  async restart(config: McpServerConfig): Promise<void> {
    await this.stop(config.id)
    await this.connect(config)
  }

  /** Disconnect and forget one server. */
  async stop(id: string): Promise<void> {
    const conn = this.connections.get(id)
    if (!conn) return
    this.connections.delete(id)
    await safeClose(conn.client)
  }

  async dispose(): Promise<void> {
    const conns = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(conns.map((conn) => safeClose(conn.client)))
  }

  /** Pushes roots/list_changed to every connected, roots-enabled server. */
  async notifyAllRootsChanged(): Promise<void> {
    await Promise.all(
      [...this.connections.values()]
        .filter((conn) => conn.state === "connected" && conn.client?.notifyRootsChanged)
        .map((conn) => conn.client!.notifyRootsChanged!())
    )
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const { serverId, toolName } = parseFqName(fqName)
    const conn = this.connections.get(serverId)
    if (!conn || conn.state !== "connected" || !conn.client) {
      throw new Error(`MCP server not connected: ${serverId}`)
    }

    const result = await conn.client.callTool(
      { name: toolName, arguments: toArguments(input) },
      { signal: options.signal }
    )
    return boundNonStreamingToolResult(toToolResult(result))
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const conn: Connection = { config, state: "connecting", tools: [] }
    this.connections.set(config.id, conn)

    if (config.enabled === false) {
      conn.state = "disconnected"
      return
    }

    try {
      const client = this.createClient(config, this.getExecutionWorkspaces)
      await client.connect()
      const { tools } = await client.listTools()
      conn.client = client
      const ownerVersion = client.serverVersion?.() ?? "unversioned"
      conn.tools = tools.map((tool) => toDescriptor(config.id, tool, ownerVersion))
      conn.state = "connected"
      for (const descriptor of conn.tools) {
        const projected = projectModelVisibleTool({
          description: descriptor.manifestTool.description,
          inputSchema: descriptor.manifestTool.inputSchema,
          outputSchema: descriptor.manifestTool.outputSchema,
          provenance: "mcp-client",
        })
        if (!projected.ok) {
          logger.warn(`tool ${descriptor.fqName} excluded from model exposure: ${projected.reason}`)
        }
      }
    } catch (err) {
      conn.state = "error"
      conn.error = err instanceof Error ? err.message : String(err)
      await safeClose(conn.client)
      conn.client = undefined
      conn.tools = []
    }
  }
}

function parseFqName(fqName: string): { serverId: string; toolName: string } {
  const rest = fqName.slice(MCP_FQ_PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash < 0) throw new Error(`Malformed MCP tool name: ${fqName}`)
  return { serverId: rest.slice(0, slash), toolName: rest.slice(slash + 1) }
}

function toArguments(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

function toDescriptor(
  serverId: string,
  tool: McpToolDefinition,
  ownerVersion: string
): RegisteredToolDescriptor {
  return {
    fqName: `${MCP_FQ_PREFIX}${serverId}/${tool.name}`,
    pluginId: `${MCP_FQ_PREFIX}${serverId}`,
    manifestTool: toManifestTool(tool),
    provenance: "mcp-client",
    ownerVersion,
    replayGuarantee: "none",
  }
}

function toManifestTool(tool: McpToolDefinition): ManifestTool {
  const manifestTool: ManifestTool = {
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: normalizeSchema(tool.inputSchema),
  }
  if (tool.annotations?.title) manifestTool.title = tool.annotations.title
  if (tool.outputSchema) manifestTool.outputSchema = normalizeSchema(tool.outputSchema)
  const annotations = toAnnotations(tool.annotations)
  if (annotations) manifestTool.annotations = annotations
  return manifestTool
}

function toAnnotations(annotations: McpToolDefinition["annotations"]): ToolAnnotations | undefined {
  if (!annotations) return undefined
  const out: ToolAnnotations = {}
  if (typeof annotations.readOnlyHint === "boolean") out.readOnlyHint = annotations.readOnlyHint
  if (typeof annotations.destructiveHint === "boolean") {
    out.destructiveHint = annotations.destructiveHint
  }
  if (typeof annotations.idempotentHint === "boolean") {
    out.idempotentHint = annotations.idempotentHint
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeSchema(schema: Record<string, unknown>): JsonSchema {
  if (schema && typeof schema === "object" && schema.type === "object") {
    return schema as JsonSchema
  }
  // External servers may omit `type`; coerce to a permissive object schema so
  // the registry and providers (which require `type: "object"`) stay happy.
  return { ...schema, type: "object" }
}

function toToolResult(result: McpCallResult): ToolResult {
  const content: ToolContentBlock[] = (result.content ?? []).map(toContentBlock)
  const out: ToolResult = {
    content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
    isError: result.isError,
  }
  if (result.structuredContent) out.structured = result.structuredContent
  return out
}

function toContentBlock(block: McpContentBlock): ToolContentBlock {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text }
  }
  if (block.type === "resource" && typeof block.resource?.text === "string") {
    return { type: "text", text: block.resource.text }
  }
  if (block.type === "image" || block.type === "audio") {
    return { type: "text", text: `[${block.type}: ${block.mimeType ?? "binary"}]` }
  }
  return { type: "text", text: JSON.stringify(block) }
}

async function safeClose(client: McpClientPort | undefined): Promise<void> {
  if (!client) return
  try {
    await client.close()
  } catch {
    // Best-effort teardown; a failed close must not break reconfiguration.
  }
}
