import type { WorkspaceRootStore } from "./workspace-root-store"
import * as path from "node:path"

/**
 * One-time migration from the retiring flat `agentShellRoots` setting into
 * the `default` workspace's roots. Idempotent: if `default` already has any
 * roots, does nothing (covers both "already migrated" and "user has since
 * added roots manually" — either way, don't stomp on it).
 */
export async function migrateAgentShellRoots(
  store: WorkspaceRootStore,
  legacyRoots: readonly string[],
  allowAgentShell: boolean
): Promise<void> {
  if (!allowAgentShell || legacyRoots.length === 0) return
  const existing = await store.listForWorkspace("default")
  if (existing.length > 0) return

  for (const [index, root] of legacyRoots.entries()) {
    const name = path.basename(root) || root
    await store.create("default", name, root, index === 0 ? "primary" : "additional")
  }
}
