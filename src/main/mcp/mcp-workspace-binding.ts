export type McpWorkspaceBinding = { kind: "bound"; workspaceId: string } | { kind: "unbound" }

export function resolveMcpWorkspaceBinding(env: NodeJS.ProcessEnv): McpWorkspaceBinding {
  const workspaceId = env.SYNAPSE_MCP_WORKSPACE?.trim()
  return workspaceId ? { kind: "bound", workspaceId } : { kind: "unbound" }
}
