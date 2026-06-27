import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { GrantStore, grantStoreFilePath } from "./grant-store"
import { grantTriggerUses, revokeTriggerUses } from "./trigger-grants"

const identity = {
  pluginId: "com.example.clip",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:user",
  capabilityDeclarationHash: "abc",
}

describe("grantTriggerUses", () => {
  it("grants fs:watch from fs.watch trigger scope", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-fs-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    await grantTriggerUses(store, identity, [
      {
        id: "watch-dls",
        type: "fs.watch",
        handler: "triggers.onDownloads",
        scope: { paths: ["~/Downloads/**"] },
        uses: [{ capability: "fs:read", budget: { maxCalls: 20, period: "1h" } }],
      },
    ])
    expect(await store.isGranted(identity, "fs:watch")).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("grants hotkey:global from hotkey trigger scope", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-hotkey-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    await grantTriggerUses(store, identity, [
      {
        id: "quick",
        type: "hotkey",
        handler: "triggers.onQuick",
        scope: { accelerator: "CommandOrControl+Shift+K" },
        uses: [{ capability: "notification", budget: { maxCalls: 10, period: "1h" } }],
      },
    ])
    expect(
      await store.isGranted(identity, "hotkey:global", {
        accelerator: "CommandOrControl+Shift+K",
      })
    ).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("grants non-auto capabilities listed in trigger uses", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    await grantTriggerUses(store, identity, [
      {
        id: "clip",
        type: "clipboard",
        handler: "triggers.onClip",
        uses: [
          { capability: "clipboard:read", budget: { maxCalls: 20, period: "1h" } },
          { capability: "fs:write", budget: { maxCalls: 5, period: "1h" } },
        ],
      },
    ])
    expect(await store.isGranted(identity, "clipboard:read")).toBe(true)
    expect(await store.isGranted(identity, "fs:write")).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("skips auto-tier capabilities such as notification", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    await grantTriggerUses(store, identity, [
      {
        id: "tick",
        type: "timer",
        schedule: { intervalMs: 60_000 },
        handler: "triggers.onTick",
        uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
      },
    ])
    expect(await store.list(identity)).toHaveLength(0)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("revokes non-auto trigger uses on disable", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    const triggers = [
      {
        id: "clip",
        type: "clipboard" as const,
        handler: "triggers.onClip",
        uses: [{ capability: "clipboard:read", budget: { maxCalls: 20, period: "1h" as const } }],
      },
    ]
    await grantTriggerUses(store, identity, triggers)
    expect(await store.isGranted(identity, "clipboard:read")).toBe(true)
    await revokeTriggerUses(store, identity, triggers)
    expect(await store.isGranted(identity, "clipboard:read")).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
