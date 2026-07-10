import type { McpClientFactory } from "./mcp-client-manager"
import { createHttpMcpClient } from "./mcp-http-client"
import { createStdioMcpClient } from "./mcp-stdio-client"

// Picks the transport implementation for a configured server. McpClientManager
// takes one McpClientFactory; this dispatches by `config.transport` so adding a
// transport is just another branch here.

export const createMcpClient: McpClientFactory = (config, getExecutionWorkspaces) =>
  config.transport === "http"
    ? createHttpMcpClient(config, getExecutionWorkspaces)
    : createStdioMcpClient(config, getExecutionWorkspaces)
