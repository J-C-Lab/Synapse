import type { WorkspaceStore } from "../ai/workspace/workspace-store"

export interface McpOnboardingAvailability {
  available: boolean
  reason?: "dev-build" | "archived" | "unknown-workspace"
}

/** The single, shared check both the renderer's availability display AND
 *  the generate-config/test-connection handlers themselves call — so the
 *  UI's enabled/disabled state and the actual server-side enforcement can
 *  never disagree about what "available" means. */
export async function checkMcpOnboardingAvailability(
  workspaceId: string,
  isPackaged: boolean,
  workspaces: Pick<WorkspaceStore, "get">
): Promise<McpOnboardingAvailability> {
  if (!isPackaged) return { available: false, reason: "dev-build" }
  const workspace = await workspaces.get(workspaceId)
  if (!workspace) return { available: false, reason: "unknown-workspace" }
  if (workspace.archived) return { available: false, reason: "archived" }
  return { available: true }
}
