import type { PluginModule, View } from "@deskit/plugin-sdk"
import type {
  DiscoveredPlugin,
  PluginInvokeRequest,
  PluginManifest,
  PluginSandboxModule,
  PluginSandboxRuntime,
} from "./types"
import { describe, expect, it, vi } from "vitest"
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
  })

  it("marks plugins crashed when command invocation throws", async () => {
    const sandbox = fakeSandbox()
    sandbox.invokeCommand = vi.fn<PluginSandboxRuntime["invokeCommand"]>(() => {
      throw new Error("boom")
    })
    const registry = new PluginRegistry({ sandbox })
    await registry.load([discovered()])

    await expect(
      registry.invoke({ pluginId: "com.deskit.test", commandId: "test.run", phase: "run" })
    ).rejects.toThrow("boom")
    expect(registry.get("com.deskit.test")?.status).toBe("crashed")
  })
})

function fakeSandbox(pluginModule: PluginModule = moduleWithCommand()): PluginSandboxRuntime {
  return {
    loadPlugin: vi.fn(async (entry: DiscoveredPlugin): Promise<PluginSandboxModule> => {
      return { pluginId: entry.pluginId, manifest: entry.manifest!, module: pluginModule }
    }),
    unloadPlugin: vi.fn(async () => {}),
    invokeCommand: vi.fn(async (_request: PluginInvokeRequest): Promise<View> => {
      return { type: "toast", level: "success", message: "ok" }
    }),
    disposeCommand: vi.fn(async () => {}),
  }
}

function moduleWithCommand(): PluginModule {
  return {
    commands: {
      "test.run": {
        run() {
          return { type: "toast", level: "success", message: "ok" }
        },
      },
    },
  }
}

function discovered(): DiscoveredPlugin {
  const pluginManifest = manifest()
  return {
    pluginId: pluginManifest.id,
    rootDir: "plugin",
    source: { kind: "dev", priority: 1 },
    status: "valid",
    manifest: pluginManifest,
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
    contributes: {
      commands: [
        {
          id: "test.run",
          title: { en: "Run Test", "zh-CN": "运行测试" },
          mode: "view",
          keywords: ["run"],
        },
      ],
    },
    permissions: [],
  }
}
