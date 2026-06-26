import type { GrantStore } from "./grant-store"
import type { PluginManifest, PluginRegistryEntry } from "./types"
import * as path from "node:path"
import { getCapability } from "@synapse/plugin-manifest"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"
import { buildGrantIdentity } from "./capability-governance"

/** Capabilities to grandfather for one installed plugin (declared set + legacy rules). */
export function grandfatheredCapabilities(manifest: PluginManifest): string[] {
  const capabilities = new Set(manifest.capabilities.map((c) => c.id))
  if (
    manifest.contributes.activationEvents?.includes("clipboard:change") &&
    !capabilities.has("clipboard:watch")
  ) {
    capabilities.add("clipboard:watch")
  }
  // Never synthesize a scoped grant: a grandfathered grant carries no scope, and
  // a scopeless scope-enforced grant (e.g. network:https) is forbidden.
  return [...capabilities].filter((id) => getCapability(id)?.scopeEnforced !== true)
}

/**
 * Persistent "governance epoch" marker. Grandfathering must run exactly once —
 * on the first boot after governance lands — so it covers only the plugins that
 * predate governance. Once the marker is set, every later install (and any
 * user revoke) goes through the tiered/JIT flow and is never re-granted.
 */
export interface MigrationMarker {
  done: () => Promise<boolean>
  markDone: (at: number) => Promise<void>
}

export function migrationMarkerFilePath(userDataDir: string): string {
  return path.join(userDataDir, "plugins", "capability-migration.json")
}

export function createMigrationMarker(userDataDir: string): MigrationMarker {
  const file = migrationMarkerFilePath(userDataDir)
  return {
    async done() {
      const raw = await readJsonFile(file)
      return Boolean(
        raw &&
        typeof raw === "object" &&
        typeof (raw as { grandfatheredAt?: unknown }).grandfatheredAt === "number"
      )
    },
    async markDone(at) {
      await writeJsonFile(file, { grandfatheredAt: at })
    },
  }
}

/**
 * One-time grandfather of pre-governance installs. Guarded by {@link MigrationMarker}:
 * runs at most once ever, writing install-time grants for every declared
 * capability on the active plugins present at that moment so their existing
 * behavior is preserved. Legacy plugins that watched the clipboard under
 * `clipboard:read` alone also receive `clipboard:watch` when their manifest
 * still lists `clipboard:change` (spec §9).
 *
 * After the marker is set this is a no-op: new installs go through the tiered
 * JIT flow, and a user's revoke is permanent (never re-granted on restart).
 */
export async function migrateGrants(
  plugins: readonly PluginRegistryEntry[],
  grants: Pick<GrantStore, "isGranted" | "grant" | "grantAutoIfAllowed">,
  marker: MigrationMarker,
  now: () => number = Date.now
): Promise<void> {
  if (await marker.done()) return

  for (const entry of plugins) {
    if (entry.status !== "active" || !entry.manifest) continue

    const identity = buildGrantIdentity(entry.pluginId, entry.manifest, entry.source.kind)
    for (const capability of grandfatheredCapabilities(entry.manifest)) {
      if (await grants.isGranted(identity, capability)) continue
      await grants.grantAutoIfAllowed(identity, capability)
    }
  }

  await marker.markDone(now())
}
