import type {
  McpCallResult,
  McpClientFactory,
  McpClientPort,
  McpToolDefinition,
} from "./mcp-client-manager"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { attachRootsCapability, notifyRootsChangedIfEnabled } from "./mcp-roots"

// Production MCP client: spawns the configured executable and speaks MCP over
// its stdio. Kept apart from McpClientManager so the SDK/child-process surface
// is the only thing this file pulls in — the manager stays unit-testable with
// an injected fake client.

export const createStdioMcpClient: McpClientFactory = (
  config,
  getExecutionWorkspaces
): McpClientPort => {
  if (!config.command) throw new Error(`MCP server "${config.id}" has no command for stdio.`)
  const client = new Client({ name: "synapse", version: "0.3.0" }, { capabilities: {} })
  attachRootsCapability(client, config, getExecutionWorkspaces)
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    // Merge over the safe default env so the child still finds PATH etc.; an
    // explicit env passed to the SDK would otherwise replace the defaults.
    env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined,
    cwd: config.cwd,
    stderr: "inherit",
  })

  return {
    connect: () => client.connect(transport),
    listTools: async () => {
      const { tools } = await client.listTools()
      return { tools: tools as McpToolDefinition[] }
    },
    callTool: (params, options) =>
      client.callTool(params, undefined, { signal: options?.signal }) as Promise<McpCallResult>,
    close: () => client.close(),
    notifyRootsChanged: () => notifyRootsChangedIfEnabled(client, config),
  }
}
