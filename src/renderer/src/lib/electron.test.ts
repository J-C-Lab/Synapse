import type { ElectronIpcError } from "./electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  disconnectLanDevice,
  disposePluginCommand,
  getLanStatus,
  getPlugin,
  getSettings,
  hideFloatingBall,
  hideLauncher,
  installMarketplacePlugin,
  installPluginFolder,
  installPluginPackage,
  invokePluginCommand,
  isElectron,
  launchApp,
  listLanDevices,
  listMarketplacePlugins,
  listPlugins,
  moveFloatingBallBy,
  notifyLauncherReady,
  onFloatingBallFeatures,
  onFloatingBallMenuState,
  onLanDevicesChanged,
  onLanStatusChanged,
  onLanTransfersChanged,
  onLauncherFocus,
  onPluginRegistryChanged,
  onSettingsChanged,
  openExternalUrl,
  openFloatingBallFeature,
  pairLanDevice,
  refreshApps,
  reloadPlugin,
  removeLanTransferHistory,
  searchApps,
  searchPluginCommands,
  sendLanFile,
  setPluginEnabled,
  setPluginPreference,
  toggleFloatingBallMenu,
  uninstallPlugin,
  updateSettings,
  writeClipboardContent,
} from "./electron"

function ok<T>(data: T): SynapsePluginIpcResult<T> {
  return { ok: true, data }
}

function mockApi() {
  const api = {
    searchApps: vi.fn().mockResolvedValue([]),
    launchApp: vi.fn().mockResolvedValue(true),
    refreshApps: vi.fn().mockResolvedValue([]),
    hideLauncher: vi.fn().mockResolvedValue(undefined),
    openExternalUrl: vi.fn().mockResolvedValue(true),
    writeClipboardContent: vi.fn().mockResolvedValue(true),
    notifyLauncherReady: vi.fn(),
    openFloatingBallFeature: vi.fn().mockResolvedValue(undefined),
    toggleFloatingBallMenu: vi.fn().mockResolvedValue(undefined),
    moveFloatingBallBy: vi.fn().mockResolvedValue(undefined),
    hideFloatingBall: vi.fn().mockResolvedValue(undefined),
    listPlugins: vi.fn().mockResolvedValue(ok([])),
    getPlugin: vi.fn().mockResolvedValue(ok(null)),
    setPluginEnabled: vi.fn().mockResolvedValue(ok({ pluginId: "plugin" })),
    setPluginPreference: vi.fn().mockResolvedValue(ok(undefined)),
    installPluginFolder: vi.fn().mockResolvedValue(ok({ pluginId: "plugin" })),
    installPluginPackage: vi.fn().mockResolvedValue(ok({ pluginId: "plugin" })),
    uninstallPlugin: vi.fn().mockResolvedValue(ok(undefined)),
    reloadPlugin: vi.fn().mockResolvedValue(ok({ pluginId: "plugin" })),
    searchPluginCommands: vi.fn().mockResolvedValue(ok([])),
    invokePluginCommand: vi.fn().mockResolvedValue(ok({ type: "toast" })),
    disposePluginCommand: vi.fn().mockResolvedValue(ok(undefined)),
    listPluginCapabilities: vi.fn().mockResolvedValue(ok([])),
    revokePluginCapability: vi.fn().mockResolvedValue(ok(undefined)),
    resolveCapabilityGrant: vi.fn().mockResolvedValue(ok(undefined)),
    resolveCapabilityApproval: vi.fn().mockResolvedValue(ok(undefined)),
    listMarketplacePlugins: vi.fn().mockResolvedValue(ok([])),
    installMarketplacePlugin: vi.fn().mockResolvedValue(ok({ id: "plugin" })),
    getSettings: vi.fn().mockResolvedValue({
      hotkey: "CommandOrControl+Space",
      themeMode: "system",
      accent: "blue",
      floatingBallEnabled: true,
      floatingBallFeatures: ["appLauncher"],
      lanEnabled: false,
      trustedSourcePolicy: "official-marketplace",
    }),
    updateSettings: vi.fn().mockResolvedValue({
      hotkey: "CommandOrControl+Space",
      themeMode: "dark",
      accent: "blue",
      floatingBallEnabled: true,
      floatingBallFeatures: ["appLauncher"],
      lanEnabled: false,
      trustedSourcePolicy: "official-marketplace",
    }),
    onLauncherFocus: vi.fn().mockReturnValue(() => {}),
    onFloatingBallMenuState: vi.fn().mockReturnValue(() => {}),
    onFloatingBallFeatures: vi.fn().mockReturnValue(() => {}),
    onPluginRegistryChanged: vi.fn().mockReturnValue(() => {}),
    onCapabilityGrantRequest: vi.fn().mockReturnValue(() => {}),
    onCapabilityApprovalRequest: vi.fn().mockReturnValue(() => {}),
    onSettingsChanged: vi.fn().mockReturnValue(() => {}),
    getLanStatus: vi.fn().mockResolvedValue({
      enabled: false,
      discovering: false,
      localDeviceId: "local",
      localDeviceName: "Desktop",
      deviceCount: 0,
    }),
    listLanDevices: vi.fn().mockResolvedValue([]),
    listLanPairings: vi.fn().mockResolvedValue([]),
    pairLanDevice: vi.fn(),
    confirmLanPairing: vi.fn(),
    rejectLanPairing: vi.fn(),
    disconnectLanDevice: vi.fn(),
    listLanTransfers: vi.fn().mockResolvedValue([]),
    sendLanFile: vi.fn(),
    resumeLanTransfer: vi.fn(),
    acceptLanTransfer: vi.fn(),
    rejectLanTransfer: vi.fn(),
    removeLanTransferHistory: vi.fn(),
    onLanDevicesChanged: vi.fn().mockReturnValue(() => {}),
    onLanStatusChanged: vi.fn().mockReturnValue(() => {}),
    onLanPairingsChanged: vi.fn().mockReturnValue(() => {}),
    onLanTransfersChanged: vi.fn().mockReturnValue(() => {}),
  }
  ;(window as unknown as { electronAPI: object }).electronAPI = api
  return api
}

describe("lib/electron", () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  describe("isElectron", () => {
    it("returns false in jsdom (no electronAPI marker)", () => {
      expect(isElectron()).toBe(false)
    })

    it("returns true when window.electronAPI is present", () => {
      ;(window as unknown as { electronAPI: object }).electronAPI = {}
      expect(isElectron()).toBe(true)
    })
  })

  describe("iPC wrappers (api() throws when electronAPI missing)", () => {
    it("throws when electronAPI is not set", async () => {
      await expect(searchApps("test")).rejects.toThrow("electronAPI is unavailable")
    })
  })

  describe("iPC wrappers delegate to electronAPI", () => {
    it("searchApps forwards query", async () => {
      const api = mockApi()
      await searchApps("vscode")
      expect(api.searchApps).toHaveBeenCalledWith("vscode")
    })

    it("launchApp forwards id", async () => {
      const api = mockApi()
      await launchApp("app-id")
      expect(api.launchApp).toHaveBeenCalledWith("app-id")
    })

    it("refreshApps calls refreshApps", async () => {
      const api = mockApi()
      await refreshApps()
      expect(api.refreshApps).toHaveBeenCalled()
    })

    it("hideLauncher calls hideLauncher", async () => {
      const api = mockApi()
      await hideLauncher()
      expect(api.hideLauncher).toHaveBeenCalled()
    })

    it("openExternalUrl forwards url", async () => {
      const api = mockApi()
      await expect(openExternalUrl("https://example.com")).resolves.toBe(true)
      expect(api.openExternalUrl).toHaveBeenCalledWith("https://example.com")
    })

    it("writeClipboardContent forwards structured clipboard payloads", async () => {
      const api = mockApi()
      const content = { type: "text" as const, text: "hello" }
      await expect(writeClipboardContent(content)).resolves.toBe(true)
      expect(api.writeClipboardContent).toHaveBeenCalledWith(content)
    })

    it("notifyLauncherReady calls notifyLauncherReady", () => {
      const api = mockApi()
      notifyLauncherReady()
      expect(api.notifyLauncherReady).toHaveBeenCalled()
    })

    it("openFloatingBallFeature forwards feature", async () => {
      const api = mockApi()
      await openFloatingBallFeature("appLauncher")
      expect(api.openFloatingBallFeature).toHaveBeenCalledWith("appLauncher")
    })

    it("toggleFloatingBallMenu calls toggleFloatingBallMenu", async () => {
      const api = mockApi()
      await toggleFloatingBallMenu()
      expect(api.toggleFloatingBallMenu).toHaveBeenCalled()
    })

    it("moveFloatingBallBy forwards delta", async () => {
      const api = mockApi()
      await moveFloatingBallBy({ x: 10, y: -5 })
      expect(api.moveFloatingBallBy).toHaveBeenCalledWith({ x: 10, y: -5 })
    })

    it("hideFloatingBall calls hideFloatingBall", async () => {
      const api = mockApi()
      await hideFloatingBall()
      expect(api.hideFloatingBall).toHaveBeenCalled()
    })

    it("getSettings calls getSettings", async () => {
      const api = mockApi()
      await getSettings()
      expect(api.getSettings).toHaveBeenCalled()
    })

    it("updateSettings forwards patch", async () => {
      const api = mockApi()
      await updateSettings({ themeMode: "dark" })
      expect(api.updateSettings).toHaveBeenCalledWith({ themeMode: "dark" })
    })

    it("getLanStatus calls getLanStatus", async () => {
      const api = mockApi()
      await getLanStatus()
      expect(api.getLanStatus).toHaveBeenCalled()
    })

    it("listLanDevices calls listLanDevices", async () => {
      const api = mockApi()
      await listLanDevices()
      expect(api.listLanDevices).toHaveBeenCalled()
    })

    it("pairLanDevice forwards device id", async () => {
      const api = mockApi()
      await pairLanDevice("peer")
      expect(api.pairLanDevice).toHaveBeenCalledWith("peer")
    })

    it("disconnectLanDevice forwards device id", async () => {
      const api = mockApi()
      await disconnectLanDevice("peer")
      expect(api.disconnectLanDevice).toHaveBeenCalledWith("peer")
    })

    it("sendLanFile forwards device id", async () => {
      const api = mockApi()
      await sendLanFile("peer")
      expect(api.sendLanFile).toHaveBeenCalledWith("peer")
    })

    it("removeLanTransferHistory forwards transfer id", async () => {
      const api = mockApi()
      await removeLanTransferHistory("transfer")
      expect(api.removeLanTransferHistory).toHaveBeenCalledWith("transfer")
    })

    it("listPlugins calls listPlugins", async () => {
      const api = mockApi()
      await listPlugins()
      expect(api.listPlugins).toHaveBeenCalled()
    })

    it("plugin wrappers throw ElectronIpcError for failed IpcResult", async () => {
      const api = mockApi()
      api.listPlugins.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "PLUGIN_NOT_ACTIVE",
          message: "Plugin is not active.",
          details: { pluginId: "com.synapse.test" },
        },
      })

      await expect(listPlugins()).rejects.toMatchObject({
        name: "ElectronIpcError",
        code: "PLUGIN_NOT_ACTIVE",
        message: "Plugin is not active.",
        details: { pluginId: "com.synapse.test" },
      } satisfies Partial<ElectronIpcError>)
    })

    it("getPlugin forwards plugin id", async () => {
      const api = mockApi()
      await getPlugin("com.synapse.test")
      expect(api.getPlugin).toHaveBeenCalledWith("com.synapse.test")
    })

    it("setPluginEnabled forwards plugin id and enabled state", async () => {
      const api = mockApi()
      await setPluginEnabled("com.synapse.test", false)
      expect(api.setPluginEnabled).toHaveBeenCalledWith("com.synapse.test", false)
    })

    it("setPluginPreference forwards preference patch", async () => {
      const api = mockApi()
      await setPluginPreference("com.synapse.test", "unit", "ms")
      expect(api.setPluginPreference).toHaveBeenCalledWith("com.synapse.test", "unit", "ms")
    })

    it("installPluginFolder forwards folder path", async () => {
      const api = mockApi()
      await installPluginFolder("/tmp/plugin")
      expect(api.installPluginFolder).toHaveBeenCalledWith("/tmp/plugin")
    })

    it("installPluginPackage forwards zip path", async () => {
      const api = mockApi()
      await installPluginPackage("/tmp/plugin.syn")
      expect(api.installPluginPackage).toHaveBeenCalledWith("/tmp/plugin.syn")
    })

    it("uninstallPlugin forwards plugin id", async () => {
      const api = mockApi()
      await uninstallPlugin("com.synapse.test")
      expect(api.uninstallPlugin).toHaveBeenCalledWith("com.synapse.test")
    })

    it("reloadPlugin forwards optional plugin id", async () => {
      const api = mockApi()
      await reloadPlugin("com.synapse.test")
      expect(api.reloadPlugin).toHaveBeenCalledWith("com.synapse.test")
    })

    it("searchPluginCommands forwards query options", async () => {
      const api = mockApi()
      await searchPluginCommands("time", "zh-CN", 5)
      expect(api.searchPluginCommands).toHaveBeenCalledWith("time", "zh-CN", 5)
    })

    it("invokePluginCommand forwards invocation payload", async () => {
      const api = mockApi()
      await invokePluginCommand("com.synapse.test", "test.run", "run", { initialQuery: "1" })
      expect(api.invokePluginCommand).toHaveBeenCalledWith("com.synapse.test", "test.run", "run", {
        initialQuery: "1",
      })
    })

    it("disposePluginCommand forwards command identity", async () => {
      const api = mockApi()
      await disposePluginCommand("com.synapse.test", "test.run")
      expect(api.disposePluginCommand).toHaveBeenCalledWith("com.synapse.test", "test.run")
    })

    it("listMarketplacePlugins calls listMarketplacePlugins", async () => {
      const api = mockApi()
      await listMarketplacePlugins()
      expect(api.listMarketplacePlugins).toHaveBeenCalled()
    })

    it("installMarketplacePlugin forwards id and version", async () => {
      const api = mockApi()
      await installMarketplacePlugin("com.synapse.test", "0.1.0")
      expect(api.installMarketplacePlugin).toHaveBeenCalledWith("com.synapse.test", "0.1.0")
    })

    it("onLauncherFocus forwards handler and returns unsubscribe", () => {
      const api = mockApi()
      const handler = vi.fn()
      const unsub = onLauncherFocus(handler)
      expect(api.onLauncherFocus).toHaveBeenCalledWith(handler)
      expect(typeof unsub).toBe("function")
    })

    it("onFloatingBallMenuState forwards handler", () => {
      const api = mockApi()
      const handler = vi.fn()
      onFloatingBallMenuState(handler)
      expect(api.onFloatingBallMenuState).toHaveBeenCalledWith(handler)
    })

    it("onFloatingBallFeatures forwards handler", () => {
      const api = mockApi()
      const handler = vi.fn()
      onFloatingBallFeatures(handler)
      expect(api.onFloatingBallFeatures).toHaveBeenCalledWith(handler)
    })

    it("onPluginRegistryChanged forwards handler", () => {
      const api = mockApi()
      const handler = vi.fn()
      onPluginRegistryChanged(handler)
      expect(api.onPluginRegistryChanged).toHaveBeenCalledWith(handler)
    })

    it("onSettingsChanged forwards handler", () => {
      const api = mockApi()
      const handler = vi.fn()
      onSettingsChanged(handler)
      expect(api.onSettingsChanged).toHaveBeenCalledWith(handler)
    })

    it("onLanDevicesChanged forwards handler", () => {
      const api = mockApi()
      const handler = vi.fn()
      onLanDevicesChanged(handler)
      expect(api.onLanDevicesChanged).toHaveBeenCalledWith(handler)
    })

    it("onLanStatusChanged forwards handler", () => {
      const api = mockApi()
      const handler = vi.fn()
      onLanStatusChanged(handler)
      expect(api.onLanStatusChanged).toHaveBeenCalledWith(handler)
    })

    it("onLanTransfersChanged forwards handler", () => {
      const api = mockApi()
      const handler = vi.fn()
      onLanTransfersChanged(handler)
      expect(api.onLanTransfersChanged).toHaveBeenCalledWith(handler)
    })
  })
})
