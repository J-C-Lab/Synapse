/* eslint-disable react/naming-convention-context-name */
import type { ClipboardContent } from "@synapse/plugin-sdk"
import type { PluginBridgeAdapters } from "./plugin-bridge"
import type { PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PermissionDenied } from "./permissions"
import { PluginBridge } from "./plugin-bridge"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-bridge-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("pluginBridge", () => {
  it("denies undeclared permissions", async () => {
    const bridge = new PluginBridge({
      userDataDir: dir,
      adapters: adapters(),
      storageFlushMs: 0,
    })
    const pluginCtx = bridge.createContext("com.synapse.test", manifest({ permissions: [] }))

    await expect(pluginCtx.storage.set("key", "value")).rejects.toBeInstanceOf(PermissionDenied)
  })

  it("persists per-plugin storage as JSON", async () => {
    const bridge = new PluginBridge({
      userDataDir: dir,
      adapters: adapters(),
      storageFlushMs: 0,
    })
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["storage:plugin"] })
    )

    await pluginCtx.storage.set("name", "Synapse")
    await pluginCtx.storage.set("count", 2)
    expect(await pluginCtx.storage.get("name")).toBe("Synapse")
    expect(await pluginCtx.storage.list()).toEqual(expect.arrayContaining(["name", "count"]))

    const raw = await fs.readFile(bridge.storageFilePath("com.synapse.test"), "utf-8")
    expect(JSON.parse(raw)).toEqual({ name: "Synapse", count: 2 })
  })

  it("routes clipboard helpers through the adapter", async () => {
    const read = vi.fn<() => Promise<ClipboardContent | undefined>>(() =>
      Promise.resolve({ type: "text", text: "hello" })
    )
    const write = vi.fn<(content: ClipboardContent) => Promise<void>>(() => Promise.resolve())
    const bridge = new PluginBridge({
      userDataDir: dir,
      adapters: adapters({ clipboard: { read, write } }),
      storageFlushMs: 0,
    })
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["clipboard:read", "clipboard:write"] })
    )

    await expect(pluginCtx.clipboard.readText()).resolves.toBe("hello")
    await pluginCtx.clipboard.write({ type: "file", paths: ["C:/tmp/a.txt"] })

    expect(read).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ type: "file", paths: ["C:/tmp/a.txt"] })
  })

  it("keeps clipboard watchers alive when adapter reads fail", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const read = vi
      .fn<() => Promise<ClipboardContent | undefined>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce({ type: "text", text: "hello" })
    const listener = vi.fn()
    const bridge = new PluginBridge({
      userDataDir: dir,
      adapters: adapters({ clipboard: { read, write: async () => {} } }),
      storageFlushMs: 0,
      clipboardPollMs: 10,
    })
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["clipboard:read"] })
    )

    const unwatch = pluginCtx.clipboard.watch(listener)
    try {
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(10)
    } finally {
      unwatch()
      vi.useRealTimers()
      warn.mockRestore()
    }

    expect(listener).toHaveBeenCalledWith({ type: "text", text: "hello" })
  })
})

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "com.synapse.test",
    name: "Test",
    displayName: "Test",
    description: "test",
    version: "0.1.0",
    author: "Synapse",
    engines: { synapse: "^0.1.0" },
    main: "dist/index.js",
    contributes: { commands: [{ id: "test.run", title: "Run", mode: "view" }] },
    permissions: ["storage:plugin"],
    ...overrides,
  }
}

function adapters(overrides: Partial<PluginBridgeAdapters> = {}): PluginBridgeAdapters {
  return {
    clipboard: {
      read: async () => undefined,
      write: async () => {},
    },
    notifications: { show: async () => {} },
    system: {
      openUrl: async () => {},
      openPath: async () => {},
      captureScreen: async () => ({ path: "capture.png" }),
    },
    ...overrides,
  }
}
