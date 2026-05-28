import { afterEach, describe, expect, it, vi } from "vitest"
import {
  disposePluginCommand,
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
  listMarketplacePlugins,
  listPlugins,
  moveFloatingBallBy,
  notifyLauncherReady,
  onFloatingBallFeatures,
  onFloatingBallMenuState,
  onLauncherFocus,
  onPluginRegistryChanged,
  onSettingsChanged,
  openFloatingBallFeature,
  refreshApps,
  reloadPlugin,
  searchApps,
  searchPluginCommands,
  setPluginEnabled,
  setPluginPreference,
  toggleFloatingBallMenu,
  uninstallPlugin,
  updateSettings,
} from "./electron"

function mockApi() {
  const api = {
    searchApps: vi.fn().mockResolvedValue([]),
    launchApp: vi.fn().mockResolvedValue(true),
    refreshApps: vi.fn().mockResolvedValue([]),
    hideLauncher: vi.fn().mockResolvedValue(undefined),
    notifyLauncherReady: vi.fn(),
    openFloatingBallFeature: vi.fn().mockResolvedValue(undefined),
    toggleFloatingBallMenu: vi.fn().mockResolvedValue(undefined),
    moveFloatingBallBy: vi.fn().mockResolvedValue(undefined),
    hideFloatingBall: vi.fn().mockResolvedValue(undefined),
    listPlugins: vi.fn().mockResolvedValue([]),
    getPlugin: vi.fn().mockResolvedValue(null),
    setPluginEnabled: vi.fn().mockResolvedValue({ pluginId: "plugin" }),
    setPluginPreference: vi.fn().mockResolvedValue(undefined),
    installPluginFolder: vi.fn().mockResolvedValue({ pluginId: "plugin" }),
    installPluginPackage: vi.fn().mockResolvedValue({ pluginId: "plugin" }),
    uninstallPlugin: vi.fn().mockResolvedValue(undefined),
    reloadPlugin: vi.fn().mockResolvedValue({ pluginId: "plugin" }),
    searchPluginCommands: vi.fn().mockResolvedValue([]),
    invokePluginCommand: vi.fn().mockResolvedValue({ type: "toast" }),
    disposePluginCommand: vi.fn().mockResolvedValue(undefined),
    listMarketplacePlugins: vi.fn().mockResolvedValue([]),
    installMarketplacePlugin: vi.fn().mockResolvedValue({ id: "plugin" }),
    getSettings: vi.fn().mockResolvedValue({
      hotkey: "CommandOrControl+Space",
      themeMode: "system",
      accent: "blue",
      floatingBallEnabled: true,
      floatingBallFeatures: ["appLauncher"],
    }),
    updateSettings: vi.fn().mockResolvedValue({
      hotkey: "CommandOrControl+Space",
      themeMode: "dark",
      accent: "blue",
      floatingBallEnabled: true,
      floatingBallFeatures: ["appLauncher"],
    }),
    onLauncherFocus: vi.fn().mockReturnValue(() => {}),
    onFloatingBallMenuState: vi.fn().mockReturnValue(() => {}),
    onFloatingBallFeatures: vi.fn().mockReturnValue(() => {}),
    onPluginRegistryChanged: vi.fn().mockReturnValue(() => {}),
    onSettingsChanged: vi.fn().mockReturnValue(() => {}),
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

    it("listPlugins calls listPlugins", async () => {
      const api = mockApi()
      await listPlugins()
      expect(api.listPlugins).toHaveBeenCalled()
    })

    it("getPlugin forwards plugin id", async () => {
      const api = mockApi()
      await getPlugin("com.deskit.test")
      expect(api.getPlugin).toHaveBeenCalledWith("com.deskit.test")
    })

    it("setPluginEnabled forwards plugin id and enabled state", async () => {
      const api = mockApi()
      await setPluginEnabled("com.deskit.test", false)
      expect(api.setPluginEnabled).toHaveBeenCalledWith("com.deskit.test", false)
    })

    it("setPluginPreference forwards preference patch", async () => {
      const api = mockApi()
      await setPluginPreference("com.deskit.test", "unit", "ms")
      expect(api.setPluginPreference).toHaveBeenCalledWith("com.deskit.test", "unit", "ms")
    })

    it("installPluginFolder forwards folder path", async () => {
      const api = mockApi()
      await installPluginFolder("/tmp/plugin")
      expect(api.installPluginFolder).toHaveBeenCalledWith("/tmp/plugin")
    })

    it("installPluginPackage forwards zip path", async () => {
      const api = mockApi()
      await installPluginPackage("/tmp/plugin.deskit")
      expect(api.installPluginPackage).toHaveBeenCalledWith("/tmp/plugin.deskit")
    })

    it("uninstallPlugin forwards plugin id", async () => {
      const api = mockApi()
      await uninstallPlugin("com.deskit.test")
      expect(api.uninstallPlugin).toHaveBeenCalledWith("com.deskit.test")
    })

    it("reloadPlugin forwards optional plugin id", async () => {
      const api = mockApi()
      await reloadPlugin("com.deskit.test")
      expect(api.reloadPlugin).toHaveBeenCalledWith("com.deskit.test")
    })

    it("searchPluginCommands forwards query options", async () => {
      const api = mockApi()
      await searchPluginCommands("time", "zh-CN", 5)
      expect(api.searchPluginCommands).toHaveBeenCalledWith("time", "zh-CN", 5)
    })

    it("invokePluginCommand forwards invocation payload", async () => {
      const api = mockApi()
      await invokePluginCommand("com.deskit.test", "test.run", "run", { initialQuery: "1" })
      expect(api.invokePluginCommand).toHaveBeenCalledWith("com.deskit.test", "test.run", "run", {
        initialQuery: "1",
      })
    })

    it("disposePluginCommand forwards command identity", async () => {
      const api = mockApi()
      await disposePluginCommand("com.deskit.test", "test.run")
      expect(api.disposePluginCommand).toHaveBeenCalledWith("com.deskit.test", "test.run")
    })

    it("listMarketplacePlugins calls listMarketplacePlugins", async () => {
      const api = mockApi()
      await listMarketplacePlugins()
      expect(api.listMarketplacePlugins).toHaveBeenCalled()
    })

    it("installMarketplacePlugin forwards id and version", async () => {
      const api = mockApi()
      await installMarketplacePlugin("com.deskit.test", "0.1.0")
      expect(api.installMarketplacePlugin).toHaveBeenCalledWith("com.deskit.test", "0.1.0")
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
  })
})
