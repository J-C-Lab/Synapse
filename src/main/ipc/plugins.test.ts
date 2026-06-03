import type { IpcMainInvokeEvent } from "electron"
import type { PluginHost } from "../plugins/plugin-host"
import { describe, expect, it, vi } from "vitest"
import { PermissionDenied } from "../plugins/permissions"
import { PluginHostNotImplementedError, PluginInstallError } from "../plugins/plugin-host"
import { PluginCrashedError } from "../plugins/plugin-registry"
import { createPluginIpcHandlers, invokePluginIpcHandler } from "./plugins"

function fakeHost(): PluginHost {
  return {
    list: vi.fn(() => [{ pluginId: "com.synapse.test" }]),
    get: vi.fn((pluginId: string) => ({ pluginId })),
    setEnabled: vi.fn(async (pluginId: string, enabled: boolean) => ({ pluginId, enabled })),
    setPreference: vi.fn(async () => {}),
    installFolder: vi.fn(async () => {
      throw new PluginHostNotImplementedError("Folder plugin installation is planned later")
    }),
    installPackage: vi.fn(async (zipPath: string) => ({ pluginId: "com.synapse.package", zipPath })),
    uninstall: vi.fn(async () => {
      throw new PluginHostNotImplementedError("Plugin uninstall is planned later")
    }),
    reload: vi.fn(async (pluginId?: string) => (pluginId ? { pluginId } : undefined)),
    searchCommands: vi.fn((query: string) => [{ commandId: "test.run", query }]),
    invoke: vi.fn(async (payload: unknown) => ({ type: "toast", payload })),
    disposeCommand: vi.fn(async () => {}),
    listMarketplacePlugins: vi.fn(async () => [{ id: "com.synapse.marketplace" }]),
    installMarketplacePlugin: vi.fn(async (id: string, version?: string) => ({ id, version })),
    registry: { on: vi.fn() },
  } as unknown as PluginHost
}

describe("plugin ipc handlers", () => {
  it("lists plugins through the host", () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    expect(handlers.list()).toEqual([{ pluginId: "com.synapse.test" }])
    expect(host.list).toHaveBeenCalledOnce()
  })

  it("validates and forwards set-enabled payloads", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await expect(
      handlers.setEnabled({ pluginId: "com.synapse.test", enabled: false })
    ).resolves.toEqual({ pluginId: "com.synapse.test", enabled: false })
    expect(host.setEnabled).toHaveBeenCalledWith("com.synapse.test", false)
  })

  it("rejects malformed set-enabled payloads", async () => {
    const handlers = createPluginIpcHandlers(fakeHost())

    expect(() => handlers.setEnabled({ pluginId: "com.synapse.test" })).toThrow(
      "enabled must be a boolean"
    )
  })

  it("validates and forwards set-preference payloads", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await handlers.setPreference({ pluginId: "com.synapse.test", key: "unit", value: "ms" })

    expect(host.setPreference).toHaveBeenCalledWith("com.synapse.test", "unit", "ms")
  })

  it("parses plugin invoke payloads", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await handlers.invoke({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
      payload: { initialQuery: "42" },
    })

    expect(host.invoke).toHaveBeenCalledWith({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
      payload: { initialQuery: "42" },
    })
  })

  it("rejects unknown invoke phases", async () => {
    const handlers = createPluginIpcHandlers(fakeHost())

    expect(() =>
      handlers.invoke({ pluginId: "com.synapse.test", commandId: "test.run", phase: "bad" })
    ).toThrow("phase must be run, onSearchChange, or onAction")
  })

  it("lists marketplace entries through the host", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await expect(handlers.marketplaceList()).resolves.toEqual([{ id: "com.synapse.marketplace" }])
    expect(host.listMarketplacePlugins).toHaveBeenCalledOnce()
  })

  it("validates and forwards package install paths", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await expect(handlers.installPackage("C:/tmp/plugin.syn")).resolves.toEqual({
      pluginId: "com.synapse.package",
      zipPath: "C:/tmp/plugin.syn",
    })
    expect(host.installPackage).toHaveBeenCalledWith("C:/tmp/plugin.syn")
  })

  it("imports from a picked file", async () => {
    const host = fakeHost()
    const pickPackageFile = vi.fn(async () => "C:/tmp/picked.syn")
    const handlers = createPluginIpcHandlers(host, { pickPackageFile })

    await expect(handlers.importFromFile()).resolves.toEqual({
      pluginId: "com.synapse.package",
      zipPath: "C:/tmp/picked.syn",
    })
    expect(host.installPackage).toHaveBeenCalledWith("C:/tmp/picked.syn")
  })

  it("returns null when the import picker is cancelled", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host, { pickPackageFile: vi.fn(async () => null) })

    await expect(handlers.importFromFile()).resolves.toBeNull()
    expect(host.installPackage).not.toHaveBeenCalled()
  })

  it("reports not-implemented when no picker is wired", async () => {
    const handlers = createPluginIpcHandlers(fakeHost())
    await expect(handlers.importFromFile()).rejects.toBeInstanceOf(PluginHostNotImplementedError)
  })

  it("validates and forwards marketplace install payloads", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await expect(
      handlers.marketplaceInstall({ id: "com.synapse.marketplace", version: "1.0.0" })
    ).resolves.toEqual({ id: "com.synapse.marketplace", version: "1.0.0" })
    expect(host.installMarketplacePlugin).toHaveBeenCalledWith("com.synapse.marketplace", "1.0.0")
  })

  it("wraps successful ipc calls in IpcResult", async () => {
    const result = await invokePluginIpcHandler(
      "plugin:list",
      fakeEvent("app://app/index.html"),
      () => [{ pluginId: "com.synapse.test" }],
      () => true
    )

    expect(result).toEqual({ ok: true, data: [{ pluginId: "com.synapse.test" }] })
  })

  it("maps malformed payloads to IPC_INVALID_PAYLOAD", async () => {
    const handlers = createPluginIpcHandlers(fakeHost())
    const result = await invokePluginIpcHandler(
      "plugin:set-enabled",
      fakeEvent("app://app/index.html"),
      () => handlers.setEnabled({ pluginId: "com.synapse.test" }),
      () => true
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "IPC_INVALID_PAYLOAD",
        message: "enabled must be a boolean",
      },
    })
  })

  it("maps not-implemented stubs to PLUGIN_NOT_IMPLEMENTED", async () => {
    const handlers = createPluginIpcHandlers(fakeHost())
    const result = await invokePluginIpcHandler(
      "plugin:install-folder",
      fakeEvent("app://app/index.html"),
      () => handlers.installFolder("/tmp/plugin"),
      () => true
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLUGIN_NOT_IMPLEMENTED",
        message: "This plugin feature is not implemented yet.",
      },
    })
  })

  it("maps install errors to PLUGIN_INSTALL_ERROR", async () => {
    const result = await invokePluginIpcHandler(
      "marketplace:install",
      fakeEvent("app://app/index.html"),
      () => {
        throw new PluginInstallError("Checksum mismatch.", {
          pluginId: "com.synapse.test",
          expectedSha256: "a",
          actualSha256: "b",
        })
      },
      () => true
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLUGIN_INSTALL_ERROR",
        message: "Checksum mismatch.",
        details: {
          pluginId: "com.synapse.test",
          expectedSha256: "a",
          actualSha256: "b",
        },
      },
    })
  })

  it("rejects untrusted senders without calling the handler", async () => {
    const handler = vi.fn()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await invokePluginIpcHandler(
      "plugin:list",
      fakeEvent("https://example.com"),
      handler,
      () => false
    )

    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("[plugin-ipc] rejected untrusted sender", {
      channel: "plugin:list",
      senderUrl: "https://example.com",
    })
    expect(result).toEqual({
      ok: false,
      error: {
        code: "IPC_FORBIDDEN",
        message: "Untrusted IPC sender.",
        details: { channel: "plugin:list" },
      },
    })
    warn.mockRestore()
  })

  it("maps installFolder host stub to PLUGIN_NOT_IMPLEMENTED", async () => {
    const handlers = createPluginIpcHandlers(fakeHost())
    const result = await invokePluginIpcHandler(
      "plugin:install-folder",
      fakeEvent("app://app/index.html"),
      () => handlers.installFolder("/tmp/plugin"),
      () => true
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLUGIN_NOT_IMPLEMENTED",
        message: "This plugin feature is not implemented yet.",
      },
    })
  })

  it("maps PluginCrashedError to PLUGIN_CRASHED with pluginId", async () => {
    const result = await invokePluginIpcHandler(
      "plugin:invoke",
      fakeEvent("app://app/index.html"),
      () => {
        throw new PluginCrashedError("com.synapse.test", new TypeError("plugin code blew up"))
      },
      () => true
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLUGIN_CRASHED",
        message: "Plugin crashed.",
        details: { pluginId: "com.synapse.test" },
      },
    })
  })

  it("maps PermissionDenied to PLUGIN_PERMISSION_DENIED with details", async () => {
    const result = await invokePluginIpcHandler(
      "plugin:invoke",
      fakeEvent("app://app/index.html"),
      () => {
        throw new PermissionDenied("com.synapse.test", "clipboard:write")
      },
      () => true
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLUGIN_PERMISSION_DENIED",
        message: "Plugin permission denied.",
        details: { pluginId: "com.synapse.test", permission: "clipboard:write" },
      },
    })
  })

  it("does not misclassify a plugin-thrown TypeError as IPC_INVALID_PAYLOAD", async () => {
    // Plugin code can throw TypeError too — registry wraps it in
    // PluginCrashedError so the IPC mapper picks the crashed branch
    // instead of the invalid-payload branch.
    const result = await invokePluginIpcHandler(
      "plugin:invoke",
      fakeEvent("app://app/index.html"),
      () => {
        throw new PluginCrashedError(
          "com.synapse.test",
          new TypeError("plugin called undefined.foo")
        )
      },
      () => true
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("PLUGIN_CRASHED")
  })
})

function fakeEvent(url: string): IpcMainInvokeEvent {
  return {
    senderFrame: { url },
    sender: { getURL: () => url },
  } as unknown as IpcMainInvokeEvent
}
