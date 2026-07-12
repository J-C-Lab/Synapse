import type { PluginBridgeAdapters } from "./plugin-bridge"
import type { PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Replace the real fetcher factory with one that hands back a tracked fake, so
// we can assert the bridge's network:https revoke teardown aborts every fetcher
// it registered — without standing up a real HTTPS round-trip.
const abortAll = vi.fn()
const fetch = vi.fn(async () => {
  throw new Error("not used")
})
vi.mock("./network-fetcher", () => ({
  createNetworkFetcher: () => ({ fetch, abortAll }),
}))

const { PluginBridge } = await import("./plugin-bridge")

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-bridge-revoke-"))
  abortAll.mockClear()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function makeBridge(): InstanceType<typeof PluginBridge> {
  const adapters: PluginBridgeAdapters = {
    clipboard: { read: async () => undefined, write: async () => {} },
    notifications: { show: async () => {} },
    system: {
      openUrl: async () => {},
      openPath: async () => {},
      captureScreen: async () => ({ path: "" }),
    },
  }
  return new PluginBridge({
    userDataDir: dir,
    adapters,
    storageFlushMs: 0,
    createGate: () => ({ assertDeclared: () => {}, ensure: async () => {} }),
  })
}

function manifest(permissions: string[]): PluginManifest {
  return {
    manifestVersion: 2,
    id: "com.synapse.test",
    name: "Test",
    displayName: "Test",
    description: "test",
    version: "0.1.0",
    author: "Synapse",
    engines: { synapse: "^0.1.0" },
    main: "dist/index.js",
    contributes: { commands: [{ id: "test.run", title: "Run", mode: "view" }] },
    capabilities: permissions.map((id) => ({ id })),
  }
}

describe("pluginBridge.revokeCapability network teardown", () => {
  it("aborts every tracked fetcher when network:https is revoked", () => {
    const bridge = makeBridge()
    // createContext builds the capability surface and registers a fetcher.
    bridge.createContext("com.synapse.test", manifest(["network:https"]), {
      source: "runless",
      actor: "user",
      trigger: "command:test.run",
    })

    bridge.revokeCapability("com.synapse.test", "network:https")

    expect(abortAll).toHaveBeenCalledTimes(1)
  })

  it("does NOT abort fetchers when an unrelated capability is revoked", () => {
    const bridge = makeBridge()
    bridge.createContext("com.synapse.test", manifest(["network:https"]), {
      source: "runless",
      actor: "user",
      trigger: "command:test.run",
    })

    bridge.revokeCapability("com.synapse.test", "clipboard:watch")

    expect(abortAll).not.toHaveBeenCalled()
  })
})
