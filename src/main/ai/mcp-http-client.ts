import type {
  McpCallResult,
  McpClientFactory,
  McpClientPort,
  McpToolDefinition,
} from "./mcp-client-manager"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Production MCP client over HTTP. Prefers the modern Streamable HTTP transport
// and falls back to the legacy SSE transport for servers that don't speak it.
// Runs in the main process (Node fetch), so the renderer CSP does not apply.
// Optional `headers` (e.g. Authorization) are sent on every request — they are
// stored verbatim in the config, so the UI warns against putting secrets there.

export const createHttpMcpClient: McpClientFactory = (config): McpClientPort => {
  if (!config.url) throw new Error(`MCP server "${config.id}" has no url for http.`)
  const url = new URL(config.url)
  const requestInit: RequestInit | undefined = config.headers
    ? { headers: config.headers }
    : undefined

  const info = { name: "synapse", version: "0.3.0" }
  let client = new Client(info, { capabilities: {} })

  return {
    connect: async () => {
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit }))
      } catch {
        // Some servers only implement the older HTTP+SSE transport. Retry with
        // a fresh client so no partial Streamable-HTTP state leaks across.
        client = new Client(info, { capabilities: {} })
        await client.connect(new SSEClientTransport(url, { requestInit }))
      }
    },
    listTools: async () => {
      const { tools } = await client.listTools()
      return { tools: tools as McpToolDefinition[] }
    },
    callTool: (params, options) =>
      client.callTool(params, undefined, { signal: options?.signal }) as Promise<McpCallResult>,
    close: () => client.close(),
  }
}
