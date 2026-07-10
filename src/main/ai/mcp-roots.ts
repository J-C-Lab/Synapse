import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { WorkspaceRoot } from "./execution/types"
import type { McpServerConfig } from "./mcp-server-config-store"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// Shared by mcp-stdio-client.ts and mcp-http-client.ts so both transports
// advertise roots identically. registerCapabilities()/setRequestHandler() must
// run before client.connect() — the SDK only allows registering capabilities
// pre-connect — so callers must invoke this right after constructing the
// Client and before connecting its transport.

/**
 * Registers the `roots` capability and a `roots/list` handler on `client` if
 * `config.exposedExecutionRootIds` is non-empty. The handler resolves ids
 * against `getExecutionWorkspaces()` live, at request time — not a snapshot
 * taken here — so it reflects the current workspace-root store even if it
 * changes after this connection was established.
 */
export function attachRootsCapability(
  client: Client,
  config: McpServerConfig,
  getExecutionWorkspaces: () => Promise<WorkspaceRoot[]>
): void {
  const ids = config.exposedExecutionRootIds
  if (!ids || ids.length === 0) return

  client.registerCapabilities({ roots: { listChanged: true } })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: (await getExecutionWorkspaces())
      .filter((workspace) => ids.includes(workspace.id))
      .map((workspace) => ({ uri: `file://${workspace.root}`, name: workspace.id })),
  }))
}

/** Sends `notifications/roots/list_changed`, but only for a connection that
 *  actually advertised roots (silently a no-op otherwise). */
export function notifyRootsChangedIfEnabled(
  client: Client,
  config: McpServerConfig
): Promise<void> {
  if (!config.exposedExecutionRootIds || config.exposedExecutionRootIds.length === 0) {
    return Promise.resolve()
  }
  return client.notification({ method: "notifications/roots/list_changed" })
}
