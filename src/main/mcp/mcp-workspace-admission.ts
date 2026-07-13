import type { WorkspaceStore } from "../ai/workspace/workspace-store"
import type { McpWorkspaceBinding } from "./mcp-workspace-binding"

export class McpUnboundError extends Error {
  constructor() {
    super(
      "This Synapse MCP configuration is missing SYNAPSE_MCP_WORKSPACE.\n" +
        "Open Synapse → Settings → Workspaces → Connect an MCP client,\n" +
        "copy the generated configuration, then restart your MCP client."
    )
    this.name = "McpUnboundError"
  }
}

export class McpWorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `Workspace "${workspaceId}" was not found. Re-copy the configuration from Synapse → Settings → Workspaces.`
    )
    this.name = "McpWorkspaceNotFoundError"
  }
}

export class McpWorkspaceArchivedError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `Workspace "${workspaceId}" is archived. Unarchive it in Synapse, or update SYNAPSE_MCP_WORKSPACE to a different workspace.`
    )
    this.name = "McpWorkspaceArchivedError"
  }
}

export async function assertWorkspaceAdmitted(
  binding: McpWorkspaceBinding,
  workspaces: Pick<WorkspaceStore, "get">
): Promise<void> {
  if (binding.kind === "unbound") throw new McpUnboundError()
  const workspace = await workspaces.get(binding.workspaceId)
  if (!workspace) throw new McpWorkspaceNotFoundError(binding.workspaceId)
  if (workspace.archived) throw new McpWorkspaceArchivedError(binding.workspaceId)
}
