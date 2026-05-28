import type { PluginHost } from "../plugins/plugin-host"
import { describe, expect, it, vi } from "vitest"
import { createPluginIpcHandlers } from "./plugins"

function fakeHost(): PluginHost {
  return {
    list: vi.fn(() => [{ pluginId: "com.deskit.test" }]),
    get: vi.fn((pluginId: string) => ({ pluginId })),
    setEnabled: vi.fn(async (pluginId: string, enabled: boolean) => ({ pluginId, enabled })),
    setPreference: vi.fn(async () => {}),
    installFolder: vi.fn(async (folderPath: string) => ({
      pluginId: "com.deskit.test",
      folderPath,
    })),
    uninstall: vi.fn(async () => {}),
    reload: vi.fn(async (pluginId?: string) => (pluginId ? { pluginId } : undefined)),
    searchCommands: vi.fn((query: string) => [{ commandId: "test.run", query }]),
    invoke: vi.fn(async (payload: unknown) => ({ type: "toast", payload })),
    disposeCommand: vi.fn(async () => {}),
    registry: { on: vi.fn() },
  } as unknown as PluginHost
}

describe("plugin ipc handlers", () => {
  it("lists plugins through the host", () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    expect(handlers.list()).toEqual([{ pluginId: "com.deskit.test" }])
    expect(host.list).toHaveBeenCalledOnce()
  })

  it("validates and forwards set-enabled payloads", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await expect(
      handlers.setEnabled({ pluginId: "com.deskit.test", enabled: false })
    ).resolves.toEqual({ pluginId: "com.deskit.test", enabled: false })
    expect(host.setEnabled).toHaveBeenCalledWith("com.deskit.test", false)
  })

  it("rejects malformed set-enabled payloads", async () => {
    const handlers = createPluginIpcHandlers(fakeHost())

    expect(() => handlers.setEnabled({ pluginId: "com.deskit.test" })).toThrow(
      "enabled must be a boolean"
    )
  })

  it("validates and forwards set-preference payloads", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await handlers.setPreference({ pluginId: "com.deskit.test", key: "unit", value: "ms" })

    expect(host.setPreference).toHaveBeenCalledWith("com.deskit.test", "unit", "ms")
  })

  it("parses plugin invoke payloads", async () => {
    const host = fakeHost()
    const handlers = createPluginIpcHandlers(host)

    await handlers.invoke({
      pluginId: "com.deskit.test",
      commandId: "test.run",
      phase: "run",
      payload: { initialQuery: "42" },
    })

    expect(host.invoke).toHaveBeenCalledWith({
      pluginId: "com.deskit.test",
      commandId: "test.run",
      phase: "run",
      payload: { initialQuery: "42" },
    })
  })

  it("rejects unknown invoke phases", async () => {
    const handlers = createPluginIpcHandlers(fakeHost())

    expect(() =>
      handlers.invoke({ pluginId: "com.deskit.test", commandId: "test.run", phase: "bad" })
    ).toThrow("phase must be run, onSearchChange, or onAction")
  })

  it("keeps marketplace list as an empty P0 stub", () => {
    const handlers = createPluginIpcHandlers(fakeHost())

    expect(handlers.marketplaceList()).toEqual([])
  })
})
