/* eslint-disable react/naming-convention-context-name */
import type { ClipboardContent } from "@synapse/plugin-sdk"
import type { CapabilityRequest } from "./capability-gate"
import type { PluginBridgeAdapters } from "./plugin-bridge"
import type { PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { rootIdForPattern } from "@synapse/plugin-manifest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CapabilityDenied } from "./capability-gate"
import { PluginBridge } from "./plugin-bridge"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-bridge-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("pluginBridge capability ensure", () => {
  it("clipboard.readText() invokes ensure with read context and proceeds when allowed", async () => {
    const ensure = vi.fn(async () => {})
    const read = vi.fn<() => Promise<ClipboardContent | undefined>>(() =>
      Promise.resolve({ type: "text", text: "hello" })
    )
    const bridge = bridgeWithGate(
      { ensure, declared: ["clipboard:read"] },
      { clipboard: { read, write: async () => {} } }
    )
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["clipboard:read"] }),
      { actor: "user", trigger: "command:test.run" }
    )

    await expect(pluginCtx.clipboard.readText()).resolves.toBe("hello")
    expect(ensure).toHaveBeenCalledWith({
      capability: "clipboard:read",
      actor: "user",
      trigger: "command:test.run",
      operation: "read",
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("rejects with CapabilityDenied and does not call the adapter when denied", async () => {
    const ensure = vi.fn(async () => {
      throw new CapabilityDenied("com.synapse.test", "clipboard:read", "grant refused")
    })
    const read = vi.fn<() => Promise<ClipboardContent | undefined>>(() =>
      Promise.resolve({ type: "text", text: "hello" })
    )
    const bridge = bridgeWithGate(
      { ensure, declared: ["clipboard:read"] },
      { clipboard: { read, write: async () => {} } }
    )
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["clipboard:read"] })
    )

    await expect(pluginCtx.clipboard.readText()).rejects.toBeInstanceOf(CapabilityDenied)
    expect(read).not.toHaveBeenCalled()
  })

  it("clipboard.watch invokes ensure with clipboard:watch", async () => {
    vi.useFakeTimers()
    const ensure = vi.fn(async () => {})
    const read = vi.fn<() => Promise<ClipboardContent | undefined>>(() =>
      Promise.resolve({ type: "text", text: "hello" })
    )
    const listener = vi.fn()
    const bridge = bridgeWithGate(
      { ensure, declared: ["clipboard:watch"] },
      { clipboard: { read, write: async () => {} }, clipboardPollMs: 10 }
    )
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["clipboard:watch"] }),
      { actor: "user", trigger: "command:watch" }
    )

    const unwatch = pluginCtx.clipboard.watch(listener)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(ensure).toHaveBeenCalledWith({
        capability: "clipboard:watch",
        actor: "user",
        trigger: "command:watch",
        operation: "watch",
      })
      await vi.advanceTimersByTimeAsync(10)
      expect(listener).toHaveBeenCalledWith({ type: "text", text: "hello" })
    } finally {
      unwatch()
      vi.useRealTimers()
    }
  })

  it("denies undeclared capabilities via ensure", async () => {
    const bridge = bridgeWithGate({ ensure: vi.fn(async () => {}), declared: [] })
    const pluginCtx = bridge.createContext("com.synapse.test", manifest({ permissions: [] }))

    await expect(pluginCtx.storage.set("key", "value")).rejects.toBeInstanceOf(CapabilityDenied)
  })
})

describe("pluginBridge storage and clipboard", () => {
  it("persists per-plugin storage as JSON", async () => {
    const ensure = vi.fn(async () => {})
    const bridge = bridgeWithGate({ ensure, declared: ["storage:plugin"] })
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

  it("records the opened url in the capability operation for audit", async () => {
    const ensure = vi.fn<(request: CapabilityRequest) => Promise<void>>(async () => {})
    const openUrl = vi.fn(async () => {})
    const bridge = bridgeWithGate(
      { ensure, declared: ["system:open-url"] },
      { system: { openUrl, openPath: async () => {}, captureScreen: async () => ({ path: "" }) } }
    )
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["system:open-url"] })
    )

    await pluginCtx.system.openUrl("https://api.github.com/repos/x/y")

    expect(openUrl).toHaveBeenCalledWith("https://api.github.com/repos/x/y")
    // Unscoped capability: the URL must ride in `operation` (the audit pipeline
    // sanitizes it to an origin), never as `requestedScope` (gate would deny).
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "system:open-url",
        operation: "open https://api.github.com/repos/x/y",
      })
    )
    expect(ensure.mock.calls[0]?.[0]).not.toHaveProperty("requestedScope")
  })

  it("records the storage key in the capability operation for audit", async () => {
    const ensure = vi.fn<(request: CapabilityRequest) => Promise<void>>(async () => {})
    const bridge = bridgeWithGate({ ensure, declared: ["storage:plugin"] })
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["storage:plugin"] })
    )

    await pluginCtx.storage.set("session-token", "x")

    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "storage:plugin", operation: "set session-token" })
    )
    expect(ensure.mock.calls[0]?.[0]).not.toHaveProperty("requestedScope")
  })

  it("routes clipboard helpers through the adapter", async () => {
    const ensure = vi.fn(async () => {})
    const read = vi.fn<() => Promise<ClipboardContent | undefined>>(() =>
      Promise.resolve({ type: "text", text: "hello" })
    )
    const write = vi.fn<(content: ClipboardContent) => Promise<void>>(() => Promise.resolve())
    const bridge = bridgeWithGate(
      { ensure, declared: ["clipboard:read", "clipboard:write"] },
      { clipboard: { read, write } }
    )
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
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const ensure = vi.fn(async () => {})
    const read = vi
      .fn<() => Promise<ClipboardContent | undefined>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce({ type: "text", text: "hello" })
    const listener = vi.fn()
    const bridge = bridgeWithGate(
      { ensure, declared: ["clipboard:watch"] },
      { clipboard: { read, write: async () => {} }, clipboardPollMs: 10 }
    )
    const pluginCtx = bridge.createContext(
      "com.synapse.test",
      manifest({ permissions: ["clipboard:watch"] })
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

describe("pluginBridge fs:write", () => {
  it("fs.move requires fs:write, journals before moving, and returns a journalId", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-home-"))
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      await fs.mkdir(path.join(home, "Downloads"), { recursive: true })
      await fs.writeFile(path.join(home, "Downloads", "src.txt"), "x", "utf8")
      const rootId = rootIdForPattern("~/Downloads/**")
      const ensure = vi.fn(async () => {})
      const bridge = bridgeWithGate({ ensure, declared: ["fs:write"] })
      const pluginCtx = bridge.createContext("com.synapse.test", fsManifest())

      const { journalId } = await pluginCtx.fs.move(rootId, "src.txt", rootId, "images/src.txt")

      expect(journalId).toMatch(/.+/)
      expect(await fs.readFile(path.join(home, "Downloads", "images", "src.txt"), "utf8")).toBe("x")
      await expect(fs.access(path.join(home, "Downloads", "src.txt"))).rejects.toThrow()
      expect(ensure).toHaveBeenCalledWith(
        expect.objectContaining({ capability: "fs:write", operation: "move", reversible: true })
      )

      const journal = JSON.parse(
        await fs.readFile(path.join(dir, "plugins", "move-journal.json"), "utf8")
      ) as Array<{ journalId: string; fromRel: string; toRel: string }>
      expect(journal).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ journalId, fromRel: "src.txt", toRel: "images/src.txt" }),
        ])
      )
    } finally {
      process.env.HOME = previousHome
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it("fs.writeText overwriting an existing file is gated as not reversible", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-home-"))
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      await fs.mkdir(path.join(home, "Downloads"), { recursive: true })
      await fs.writeFile(path.join(home, "Downloads", "a.txt"), "old", "utf8")
      const rootId = rootIdForPattern("~/Downloads/**")
      const ensure = vi.fn(async () => {})
      const bridge = bridgeWithGate({ ensure, declared: ["fs:write"] })
      const pluginCtx = bridge.createContext("com.synapse.test", fsManifest())

      await expect(pluginCtx.fs.writeText(rootId, "a.txt", "x")).rejects.toThrow(/exists/i)

      expect(ensure).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "fs:write",
          operation: "writeText",
          reversible: false,
        })
      )
    } finally {
      process.env.HOME = previousHome
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

function bridgeWithGate(
  gate: {
    ensure: (request: CapabilityRequest) => Promise<void>
    declared: string[]
  },
  overrides: Partial<PluginBridgeAdapters> & { clipboardPollMs?: number } = {}
): PluginBridge {
  const { clipboardPollMs, ...adapterOverrides } = overrides
  return new PluginBridge({
    userDataDir: dir,
    adapters: adapters(adapterOverrides),
    storageFlushMs: 0,
    clipboardPollMs,
    createGate: () => ({
      assertDeclared: (capability) => {
        if (!gate.declared.includes(capability)) {
          throw new CapabilityDenied("com.synapse.test", capability, "not declared")
        }
      },
      ensure: async (request: CapabilityRequest) => {
        if (!gate.declared.includes(request.capability)) {
          throw new CapabilityDenied("com.synapse.test", request.capability, "not declared")
        }
        await gate.ensure(request)
      },
    }),
  })
}

function manifest(
  overrides: Partial<Omit<PluginManifest, "capabilities">> & { permissions?: string[] } = {}
): PluginManifest {
  const { permissions = ["storage:plugin"], ...rest } = overrides
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
    ...rest,
  }
}

function fsManifest(): PluginManifest {
  return {
    ...manifest({ permissions: [] }),
    capabilities: [{ id: "fs:write", scope: { paths: ["~/Downloads/**"] } }],
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
