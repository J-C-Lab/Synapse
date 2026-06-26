import type { createMigrationMarker } from "./grant-migration"
import type { PluginManifest, PluginRegistryEntry } from "./types"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildGrantIdentity } from "./capability-governance"
import { migrateGrants } from "./grant-migration"
import { GrantStore } from "./grant-store"

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-migrate-"))
  file = path.join(dir, "grants.json")
})

/** A fresh in-memory epoch marker (each test starts un-migrated). */
function marker(): ReturnType<typeof createMigrationMarker> {
  let at: number | undefined
  return {
    done: async () => at !== undefined,
    markDone: async (value) => {
      at = value
    },
  }
}

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("migrateGrants", () => {
  it("grandfathers each declared capability under the plugin identity with grantedBy install", async () => {
    const store = new GrantStore(file, () => 1000)
    const manifest = manifestWith({
      capabilities: [{ id: "storage:plugin" }, { id: "clipboard:read" }, { id: "notification" }],
    })
    const entry = activeEntry(manifest)

    await migrateGrants([entry], store, marker())

    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    expect(await store.isGranted(identity, "storage:plugin")).toBe(true)
    expect(await store.isGranted(identity, "clipboard:read")).toBe(true)
    expect(await store.isGranted(identity, "notification")).toBe(true)
    const records = await store.list(identity)
    expect(records).toHaveLength(3)
    expect(records.every((record) => record.grantedBy === "install")).toBe(true)
    expect(records.every((record) => record.grantedAt === 1000)).toBe(true)
  })

  it("also grants clipboard:watch for legacy clipboard:change plugins that only declared clipboard:read", async () => {
    const store = new GrantStore(file)
    const manifest = manifestWith({
      capabilities: [{ id: "clipboard:read" }, { id: "storage:plugin" }],
      activationEvents: ["clipboard:change"],
    })
    const entry = activeEntry(manifest)

    await migrateGrants([entry], store, marker())

    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    expect(await store.isGranted(identity, "clipboard:watch")).toBe(true)
    expect(await store.isGranted(identity, "clipboard:read")).toBe(true)
  })

  it("does not add clipboard:watch when there is no clipboard:change activation", async () => {
    const store = new GrantStore(file)
    const manifest = manifestWith({ capabilities: [{ id: "clipboard:read" }] })
    const entry = activeEntry(manifest)

    await migrateGrants([entry], store, marker())

    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    expect(await store.isGranted(identity, "clipboard:read")).toBe(true)
    expect(await store.isGranted(identity, "clipboard:watch")).toBe(false)
  })

  it("is idempotent — a second run adds nothing", async () => {
    const store = new GrantStore(file, () => 1000)
    const manifest = manifestWith({ capabilities: [{ id: "storage:plugin" }] })
    const entry = activeEntry(manifest)
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    const epoch = marker()

    await migrateGrants([entry], store, epoch)
    const afterFirst = await store.list(identity)

    await migrateGrants([entry], store, epoch)
    const afterSecond = await store.list(identity)

    expect(afterSecond).toEqual(afterFirst)
  })

  it("never re-grants a capability the user revoked after the epoch (revoke is permanent)", async () => {
    const store = new GrantStore(file)
    const manifest = manifestWith({
      capabilities: [{ id: "clipboard:read" }, { id: "storage:plugin" }],
    })
    const entry = activeEntry(manifest)
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    const epoch = marker()

    await migrateGrants([entry], store, epoch)
    await store.revoke(identity, "clipboard:read", "user")
    expect(await store.isGranted(identity, "clipboard:read")).toBe(false)

    // A later boot must NOT resurrect the revoked grant.
    await migrateGrants([entry], store, epoch)
    expect(await store.isGranted(identity, "clipboard:read")).toBe(false)
  })

  it("does not grandfather a plugin installed after the epoch (new installs go through JIT)", async () => {
    const store = new GrantStore(file)
    const epoch = marker()
    const oldPlugin = activeEntry(manifestWith({ capabilities: [{ id: "clipboard:read" }] }))

    // Epoch boot: only the pre-governance plugin exists.
    await migrateGrants([oldPlugin], store, epoch)

    // A new plugin appears on a later boot — it must not be auto-granted.
    const newManifest = manifestWith({
      id: "com.synapse.new",
      capabilities: [{ id: "storage:plugin" }],
    })
    const newPlugin = activeEntry(newManifest)
    await migrateGrants([oldPlugin, newPlugin], store, epoch)

    const newIdentity = buildGrantIdentity(newPlugin.pluginId, newManifest, newPlugin.source.kind)
    expect(await store.isGranted(newIdentity, "storage:plugin")).toBe(false)
  })

  it("marks the epoch even when no plugins are present, so later installs stay on JIT", async () => {
    const store = new GrantStore(file)
    const epoch = marker()

    await migrateGrants([], store, epoch)
    expect(await epoch.done()).toBe(true)

    const newManifest = manifestWith({
      id: "com.synapse.fresh",
      capabilities: [{ id: "storage:plugin" }],
    })
    const newPlugin = activeEntry(newManifest)
    await migrateGrants([newPlugin], store, epoch)

    const identity = buildGrantIdentity(newPlugin.pluginId, newManifest, newPlugin.source.kind)
    expect(await store.isGranted(identity, "storage:plugin")).toBe(false)
  })

  it("leaves an existing user grant intact", async () => {
    const store = new GrantStore(file, () => 1000)
    const manifest = manifestWith({ capabilities: [{ id: "clipboard:read" }] })
    const entry = activeEntry(manifest)
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    await store.grant(identity, "clipboard:read", "user", undefined)

    await migrateGrants([entry], store, marker())

    const records = await store.list(identity)
    expect(records).toHaveLength(1)
    expect(records[0]?.grantedBy).toBe("user")
  })

  it("skips non-active plugins", async () => {
    const store = new GrantStore(file)
    const manifest = manifestWith({ capabilities: [{ id: "storage:plugin" }] })
    const entry = activeEntry(manifest, "disabled")

    await migrateGrants([entry], store, marker())

    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    expect(await store.list(identity)).toHaveLength(0)
  })

  it("never grandfathers a scope-enforced capability (no synthesized scoped grant)", async () => {
    const store = new GrantStore(file)
    const manifest = manifestWith({
      capabilities: [{ id: "storage:plugin" }, { id: "network:https" }],
    })
    const entry = activeEntry(manifest)
    await migrateGrants([entry], store, marker())
    const identity = buildGrantIdentity(entry.pluginId, manifest, entry.source.kind)
    expect(await store.isGranted(identity, "storage:plugin")).toBe(true)
    expect(await store.isGranted(identity, "network:https")).toBe(false)
  })
})

function manifestWith(
  overrides: Partial<PluginManifest> & {
    capabilities: { id: string }[]
    activationEvents?: PluginManifest["contributes"]["activationEvents"]
  }
): PluginManifest {
  return {
    manifestVersion: 2 as const,
    id: overrides.id ?? "com.synapse.legacy",
    name: "legacy",
    displayName: "Legacy",
    description: "legacy",
    version: "0.1.0",
    author: "Synapse",
    engines: { synapse: "^0.2.0" },
    main: "dist/index.js",
    contributes: {
      commands: [{ id: "run", title: "Run", mode: "view" }],
      activationEvents: overrides.activationEvents,
    },
    capabilities: overrides.capabilities,
  }
}

function activeEntry(
  manifest: PluginManifest,
  status: PluginRegistryEntry["status"] = "active"
): PluginRegistryEntry {
  return {
    pluginId: manifest.id,
    rootDir: path.join(dir, "plugin"),
    source: { kind: "user", priority: 2 },
    status,
    manifest,
  }
}
