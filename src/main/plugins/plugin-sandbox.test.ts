import type { DiscoveredPlugin, PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PluginBridge } from "./plugin-bridge"
import { PluginSandbox, PluginSandboxError } from "./plugin-sandbox"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "deskit-sandbox-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("pluginSandbox", () => {
  it("loads a CommonJS plugin and invokes command hooks", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run(input) {
        return { type: "list", items: [{ id: "run", title: input.commandId, actions: [] }] }
      },
      onSearchChange(text) {
        return { type: "toast", level: "info", message: text }
      },
      onAction(actionId, payload) {
        return { type: "toast", level: "success", message: actionId + ":" + payload.value }
      }
    }
  }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "test.run", phase: "run" })
    ).resolves.toMatchObject({ type: "list" })
    await expect(
      sandbox.invokeCommand({
        pluginId: entry.pluginId,
        commandId: "test.run",
        phase: "onSearchChange",
        payload: "abc",
      })
    ).resolves.toEqual({ type: "toast", level: "info", message: "abc" })
    await expect(
      sandbox.invokeCommand({
        pluginId: entry.pluginId,
        commandId: "test.run",
        phase: "onAction",
        payload: { actionId: "save", payload: { value: "42" } },
      })
    ).resolves.toEqual({ type: "toast", level: "success", message: "save:42" })
  })

  it("does not expose Node globals inside the sandbox", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        return {
          type: "toast",
          level: "info",
          message: [typeof require, typeof process, typeof Buffer].join("/")
        }
      }
    }
  }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "test.run", phase: "run" })
    ).resolves.toEqual({ type: "toast", level: "info", message: "undefined/undefined/undefined" })
  })

  it("times out commands that never resolve", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        return new Promise(() => {})
      }
    }
  }
}
`)
    const sandbox = sandboxForTest(5)
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "test.run", phase: "run" })
    ).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("times out plugin top-level code during load", async () => {
    const entry = await writePlugin("while (true) {}")
    const sandbox = sandboxForTest(100, 5)

    await expect(sandbox.loadPlugin(entry)).rejects.toThrow("timed out")
  })
})

function sandboxForTest(invokeTimeoutMs = 100, loadTimeoutMs = 100): PluginSandbox {
  const bridge = new PluginBridge({
    userDataDir: dir,
    adapters: {
      clipboard: { read: async () => undefined, write: async () => {} },
      notifications: { show: async () => {} },
      system: {
        openUrl: async () => {},
        openPath: async () => {},
        captureScreen: async () => ({ path: "capture.png" }),
      },
    },
    storageFlushMs: 0,
  })
  return new PluginSandbox({ bridge, invokeTimeoutMs, loadTimeoutMs })
}

async function writePlugin(code: string): Promise<DiscoveredPlugin> {
  const rootDir = path.join(dir, "plugin")
  await fs.mkdir(path.join(rootDir, "dist"), { recursive: true })
  await fs.writeFile(path.join(rootDir, "dist", "index.js"), code, "utf-8")
  return {
    pluginId: "com.deskit.test",
    rootDir,
    source: { kind: "dev", priority: 1 },
    status: "valid",
    manifest: manifest(),
  }
}

function manifest(): PluginManifest {
  return {
    id: "com.deskit.test",
    name: "Test",
    displayName: "Test",
    description: "test",
    version: "0.1.0",
    author: "DesKit",
    engines: { deskit: "^0.1.0" },
    main: "dist/index.js",
    contributes: { commands: [{ id: "test.run", title: "Run", mode: "view" }] },
    permissions: [],
  }
}
