import type { DiscoveredPlugin, PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CapabilityDenied } from "./capability-gate"
import { PluginBridge } from "./plugin-bridge"
import { PluginInvocationTimeoutError, PluginSandbox, PluginSandboxError } from "./plugin-sandbox"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-sandbox-"))
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

  it("exposes no network/egress globals inside the sandbox", async () => {
    // The sandbox is an allowlist (vm.createContext over curated globals); no
    // network primitive is injected. Network access is only via ctx.network,
    // a host function — never a vm global. This guards against regressions that
    // would re-open an egress hole.
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        return {
          type: "toast",
          level: "info",
          message: JSON.stringify({
            fetch: typeof fetch,
            globalFetch: typeof globalThis.fetch,
            XMLHttpRequest: typeof XMLHttpRequest,
            WebSocket: typeof WebSocket,
            EventSource: typeof EventSource,
            Worker: typeof Worker,
            SharedWorker: typeof SharedWorker,
            require: typeof require,
            process: typeof process,
            global: typeof global,
            navigator: typeof navigator
          })
        }
      }
    }
  }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    const result = (await sandbox.invokeCommand({
      pluginId: entry.pluginId,
      commandId: "test.run",
      phase: "run",
    })) as { message: string }
    expect(JSON.parse(result.message)).toEqual({
      fetch: "undefined",
      globalFetch: "undefined",
      XMLHttpRequest: "undefined",
      WebSocket: "undefined",
      EventSource: "undefined",
      Worker: "undefined",
      SharedWorker: "undefined",
      require: "undefined",
      process: "undefined",
      global: "undefined",
      navigator: "undefined",
    })
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
    ).rejects.toBeInstanceOf(PluginInvocationTimeoutError)
  })

  it("gives command run a longer budget than search/action hooks", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        return new Promise((resolve) => setTimeout(() => resolve({ type: "toast", message: "ok" }), 40))
      },
      onSearchChange() {
        return new Promise(() => {})
      }
    }
  }
}
`)
    const sandbox = sandboxForTest(20, 2000, 2000, 100)
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeCommand({
        pluginId: entry.pluginId,
        commandId: "test.run",
        phase: "onSearchChange",
        payload: "q",
      })
    ).rejects.toBeInstanceOf(PluginInvocationTimeoutError)

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "test.run", phase: "run" })
    ).resolves.toEqual({ type: "toast", message: "ok" })
  })

  it("times out synchronous command loops", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        while (true) {}
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

  it("dispatches clipboard change events to plugin handlers", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        return { type: "toast", level: "info", message: "ok" }
      }
    }
  },
  events: {
    async onClipboardChange(event, ctx) {
      const entries = (await ctx.storage.get("entries")) ?? []
      await ctx.storage.set("entries", entries.concat(event.content.text))
    }
  }
}
`)
    entry.manifest!.capabilities = [{ id: "storage:plugin" }]
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)
    await sandbox.dispatchEvent({
      pluginId: entry.pluginId,
      event: "clipboard:change",
      payload: { content: { type: "text", text: "hello" } },
    })

    const raw = await fs.readFile(path.join(dir, "plugin-data", "com.synapse.test.json"), "utf-8")
    const stored = JSON.parse(raw) as unknown
    expect(stored).toEqual({ entries: ["hello"] })
  })

  it("dispatchTrigger runs the manifest-named export with the safe event", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  triggers: {
    async onTick(event, ctx) {
      const prev = (await ctx.storage.get("calls")) ?? []
      await ctx.storage.set("calls", prev.concat([event]))
    }
  }
}
`)
    entry.manifest!.capabilities = [{ id: "storage:plugin" }]
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)
    await sandbox.dispatchTrigger({
      pluginId: entry.pluginId,
      triggerId: "t",
      trigger: "timer:t",
      handler: "triggers.onTick",
      invocationId: "inv-1",
      event: { firedAt: 5 },
      signal: new AbortController().signal,
    })
    const raw = await fs.readFile(path.join(dir, "plugin-data", "com.synapse.test.json"), "utf-8")
    expect(JSON.parse(raw)).toEqual({ calls: [{ firedAt: 5 }] })
  })

  it("dispatchTrigger is a no-op when the named handler is missing", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  triggers: {}
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)
    await expect(
      sandbox.dispatchTrigger({
        pluginId: entry.pluginId,
        triggerId: "t",
        trigger: "timer:t",
        handler: "triggers.onMissing",
        invocationId: "inv-1",
        event: {},
        signal: new AbortController().signal,
      })
    ).resolves.toBeUndefined()
  })

  it("invokes a tool and returns its result, exposing the caller in ctx", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: {
    echo(input, ctx) {
      return { content: [{ type: "json", json: { input, caller: ctx.caller.kind } }] }
    }
  }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    const result = await sandbox.invokeTool({
      pluginId: entry.pluginId,
      toolName: "echo",
      input: { value: 1 },
      options: { caller: { kind: "agent", conversationId: "c1" } },
    })

    expect(result).toEqual({
      content: [{ type: "json", json: { input: { value: 1 }, caller: "agent" } }],
    })
  })

  it("surfaces a thrown handler error as an error result", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: { boom() { throw new Error("nope") } }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    const result = await sandbox.invokeTool({
      pluginId: entry.pluginId,
      toolName: "boom",
      input: {},
      options: { caller: { kind: "agent" } },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: "text", text: "nope" })
  })

  it("times out a tool that never resolves", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: { hang() { return new Promise(() => {}) } }
}
`)
    // Only the tool-invoke budget (5ms) is under test; keep load/invoke generous
    // so the load step does not flake under CPU load.
    const sandbox = sandboxForTest(2000, 2000, 5)
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "hang",
        input: {},
        options: { caller: { kind: "agent" } },
      })
    ).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("honours an already-aborted caller signal", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: { hang() { return new Promise(() => {}) } }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "hang",
        input: {},
        options: { caller: { kind: "agent" }, signal: AbortSignal.abort() },
      })
    ).rejects.toBeTruthy()
  })

  it("rejects when the tool is not exported", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "missing",
        input: {},
        options: { caller: { kind: "agent" } },
      })
    ).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("gates the tool context to the tool's declared permissions", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: {
    async write(_input, ctx) {
      await ctx.clipboard.writeText("hi")
      return { content: [{ type: "text", text: "wrote" }] }
    }
  }
}
`)
    // Plugin is granted clipboard:write, but the tool declares no capabilities,
    // so its context must be gated down and deny the write.
    entry.manifest!.capabilities = [{ id: "clipboard:write" }]
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "write",
        input: {},
        capabilities: [],
        options: { caller: { kind: "agent" } },
      })
    ).rejects.toBeInstanceOf(CapabilityDenied)
  })
})

// Default budgets are generous so normal (non-timeout) cases stay reliable when
// the test run saturates the CPU; the timeout-behavior tests pass explicit
// small values to trigger the timeouts they assert.
function sandboxForTest(
  invokeTimeoutMs = 2000,
  loadTimeoutMs = 2000,
  toolInvokeTimeoutMs = 2000,
  commandRunTimeoutMs = 2000
): PluginSandbox {
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
  return new PluginSandbox({
    bridge,
    invokeTimeoutMs,
    loadTimeoutMs,
    toolInvokeTimeoutMs,
    commandRunTimeoutMs,
  })
}

async function writePlugin(code: string): Promise<DiscoveredPlugin> {
  const rootDir = path.join(dir, "plugin")
  await fs.mkdir(path.join(rootDir, "dist"), { recursive: true })
  await fs.writeFile(path.join(rootDir, "dist", "index.js"), code, "utf-8")
  return {
    pluginId: "com.synapse.test",
    rootDir,
    source: { kind: "dev", priority: 1 },
    status: "valid",
    manifest: manifest(),
  }
}

function manifest(): PluginManifest {
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
    capabilities: [],
  }
}
