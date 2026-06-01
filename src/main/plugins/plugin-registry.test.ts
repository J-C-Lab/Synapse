import type { PluginModule, View } from "@deskit/plugin-sdk"
import type {
  DiscoveredPlugin,
  PluginInvokeRequest,
  PluginManifest,
  PluginSandboxModule,
  PluginSandboxRuntime,
} from "./types"
import { describe, expect, it, vi } from "vitest"
import { PermissionDenied } from "./permissions"
import { PluginRegistry } from "./plugin-registry"

describe("pluginRegistry", () => {
  it("loads valid plugins, indexes manifest commands and emits changes", async () => {
    const sandbox = fakeSandbox()
    const registry = new PluginRegistry({ sandbox, now: () => 1 })
    const changed = vi.fn()
    registry.on("changed", changed)

    await registry.load([discovered()])

    expect(registry.get("com.deskit.test")?.status).toBe("active")
    expect(registry.searchCommands("run")).toHaveLength(1)
    expect(changed).toHaveBeenCalledOnce()
  })

  it("indexes duplicate command ids per plugin", async () => {
    const sandbox = fakeSandbox()
    const registry = new PluginRegistry({ sandbox, now: () => 1 })

    await registry.load([
      discovered({ id: "com.deskit.one", commandId: "shared.run" }),
      discovered({ id: "com.deskit.two", commandId: "shared.run" }),
    ])

    expect(registry.searchCommands("run").map((result) => result.pluginId)).toEqual([
      "com.deskit.one",
      "com.deskit.two",
    ])
  })

  it("continues reload when unloading an old plugin fails", async () => {
    const sandbox = fakeSandbox()
    const registry = new PluginRegistry({ sandbox, now: () => 1 })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await registry.load([discovered({ id: "com.deskit.old" })])
    sandbox.unloadPlugin = vi.fn(async () => {
      throw new Error("stuck")
    })

    try {
      await registry.load([discovered({ id: "com.deskit.new" })])
    } finally {
      warn.mockRestore()
    }

    expect(registry.get("com.deskit.old")).toBeUndefined()
    expect(registry.get("com.deskit.new")?.status).toBe("active")
  })

  it("disables and re-enables plugins", async () => {
    const sandbox = fakeSandbox()
    const registry = new PluginRegistry({ sandbox, now: () => 1 })
    await registry.load([discovered()])

    await registry.setEnabled("com.deskit.test", false)
    expect(registry.get("com.deskit.test")?.status).toBe("disabled")
    expect(registry.searchCommands("run")).toHaveLength(0)
    expect(sandbox.unloadPlugin).toHaveBeenCalledWith("com.deskit.test")

    await registry.setEnabled("com.deskit.test", true)
    expect(registry.get("com.deskit.test")?.status).toBe("active")
    expect(registry.searchCommands("run")).toHaveLength(1)
  })

  it("marks plugins crashed when exported commands do not match the manifest", async () => {
    const sandbox = fakeSandbox({ commands: {} })
    const registry = new PluginRegistry({ sandbox })

    await registry.load([discovered()])

    expect(registry.get("com.deskit.test")?.status).toBe("crashed")
    expect(registry.searchCommands("run")).toHaveLength(0)
    expect(sandbox.unloadPlugin).toHaveBeenCalledWith("com.deskit.test")
  })

  it("marks plugins crashed and rethrows a typed sentinel when command invocation throws", async () => {
    const sandbox = fakeSandbox()
    sandbox.invokeCommand = vi.fn<PluginSandboxRuntime["invokeCommand"]>(() => {
      throw new Error("boom")
    })
    const registry = new PluginRegistry({ sandbox })
    await registry.load([discovered()])

    await expect(
      registry.invoke({ pluginId: "com.deskit.test", commandId: "test.run", phase: "run" })
    ).rejects.toMatchObject({
      name: "PluginCrashedError",
      pluginId: "com.deskit.test",
    })
    expect(registry.get("com.deskit.test")?.status).toBe("crashed")
  })

  it("passes PermissionDenied through invoke without crashing the plugin", async () => {
    const sandbox = fakeSandbox()
    sandbox.invokeCommand = vi.fn<PluginSandboxRuntime["invokeCommand"]>(() => {
      throw new PermissionDenied("com.deskit.test", "clipboard:write")
    })
    const registry = new PluginRegistry({ sandbox })
    await registry.load([discovered()])

    await expect(
      registry.invoke({ pluginId: "com.deskit.test", commandId: "test.run", phase: "run" })
    ).rejects.toBeInstanceOf(PermissionDenied)
    // Permission denials are policy decisions — the plugin must stay active.
    expect(registry.get("com.deskit.test")?.status).toBe("active")
  })

  it("dispatches clipboard changes to active listeners", async () => {
    const sandbox = fakeSandbox({
      commands: {
        "clipboard.history": {
          run() {
            return { type: "toast", level: "success", message: "ok" }
          },
        },
      },
      events: { onClipboardChange: async () => {} },
    })
    const registry = new PluginRegistry({ sandbox })
    await registry.load([
      discovered({
        id: "com.deskit.clipboard",
        commandId: "clipboard.history",
        activationEvents: ["clipboard:change"],
      }),
    ])
    expect(registry.hasClipboardChangeListeners()).toBe(true)

    await registry.dispatchClipboardChange({ type: "text", text: "hello" })

    expect(sandbox.dispatchEvent).toHaveBeenCalledWith({
      pluginId: "com.deskit.clipboard",
      event: "clipboard:change",
      payload: { content: { type: "text", text: "hello" } },
    })
  })

  it("marks clipboard listeners crashed when clipboard read permission is missing", async () => {
    const sandbox = fakeSandbox({
      commands: {
        "clipboard.history": {
          run() {
            return { type: "toast", level: "success", message: "ok" }
          },
        },
      },
      events: { onClipboardChange: async () => {} },
    })
    const registry = new PluginRegistry({ sandbox })

    await registry.load([
      discovered({
        id: "com.deskit.clipboard",
        commandId: "clipboard.history",
        activationEvents: ["clipboard:change"],
        permissions: [],
      }),
    ])

    expect(registry.get("com.deskit.clipboard")?.status).toBe("crashed")
    expect(registry.hasClipboardChangeListeners()).toBe(false)
    expect(sandbox.unloadPlugin).toHaveBeenCalledWith("com.deskit.clipboard")
  })

  it("marks clipboard listeners crashed when handler is not exported", async () => {
    const sandbox = fakeSandbox({
      commands: {
        "clipboard.history": {
          run() {
            return { type: "toast", level: "success", message: "ok" }
          },
        },
      },
    })
    const registry = new PluginRegistry({ sandbox })

    await registry.load([
      discovered({
        id: "com.deskit.clipboard",
        commandId: "clipboard.history",
        activationEvents: ["clipboard:change"],
      }),
    ])

    expect(registry.get("com.deskit.clipboard")?.status).toBe("crashed")
    expect(registry.hasClipboardChangeListeners()).toBe(false)
    expect(sandbox.unloadPlugin).toHaveBeenCalledWith("com.deskit.clipboard")
  })
})

function fakeSandbox(pluginModule?: PluginModule): PluginSandboxRuntime {
  return {
    loadPlugin: vi.fn(async (entry: DiscoveredPlugin): Promise<PluginSandboxModule> => {
      return {
        pluginId: entry.pluginId,
        manifest: entry.manifest!,
        module: pluginModule ?? moduleFromManifest(entry.manifest!),
      }
    }),
    unloadPlugin: vi.fn(async () => {}),
    invokeCommand: vi.fn(async (_request: PluginInvokeRequest): Promise<View> => {
      return { type: "toast", level: "success", message: "ok" }
    }),
    disposeCommand: vi.fn(async () => {}),
    dispatchEvent: vi.fn<PluginSandboxRuntime["dispatchEvent"]>(async () => {}),
  }
}

function moduleFromManifest(pluginManifest: PluginManifest): PluginModule {
  return {
    commands: Object.fromEntries(
      pluginManifest.contributes.commands.map((command) => [
        command.id,
        {
          run() {
            return { type: "toast", level: "success", message: "ok" }
          },
        },
      ])
    ),
  }
}

function discovered(
  overrides: {
    id?: string
    commandId?: string
    title?: string
    activationEvents?: PluginManifest["contributes"]["activationEvents"]
    permissions?: string[]
  } = {}
): DiscoveredPlugin {
  const pluginManifest = manifest(overrides)
  return {
    pluginId: pluginManifest.id,
    rootDir: "plugin",
    source: { kind: "dev", priority: 1 },
    status: "valid",
    manifest: pluginManifest,
  }
}

function manifest(
  overrides: {
    id?: string
    commandId?: string
    title?: string
    activationEvents?: PluginManifest["contributes"]["activationEvents"]
    permissions?: string[]
  } = {}
): PluginManifest {
  const id = overrides.id ?? "com.deskit.test"
  const commandId = overrides.commandId ?? "test.run"
  const title = overrides.title ?? "Run Test"
  return {
    id,
    name: "Test",
    displayName: "Test",
    description: "test",
    version: "0.1.0",
    author: "DesKit",
    engines: { deskit: "^0.1.0" },
    main: "dist/index.js",
    contributes: {
      activationEvents: overrides.activationEvents,
      commands: [
        {
          id: commandId,
          title: { en: title, "zh-CN": "运行测试" },
          mode: "view",
          keywords: ["run"],
        },
      ],
    },
    permissions:
      overrides.permissions ??
      (overrides.activationEvents?.includes("clipboard:change") ? ["clipboard:read"] : []),
  }
}
