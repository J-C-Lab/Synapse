import type { IpcRendererEvent } from "electron"
import { contextBridge, ipcRenderer } from "electron"

// Local mirror of the renderer-visible global DeskitUserSettings shape.
// The global declared in index.d.ts is only loaded into the renderer's
// compilation; the preload tsconfig doesn't pick up that .d.ts, so we
// keep a structurally identical type here for type-only use.
interface SettingsPatch {
  hotkey?: string
  themeMode?: "light" | "dark" | "system"
  accent?: "neutral" | "blue" | "green" | "rose" | "violet"
  floatingBallEnabled?: boolean
  floatingBallFeatures?: "appLauncher"[]
}
type Settings = Required<SettingsPatch>

const electronAPI = {
  // ---- Launcher ----
  searchApps: (query: string) => ipcRenderer.invoke("launcher:search", query),
  launchApp: (id: string) => ipcRenderer.invoke("launcher:launch", id),
  refreshApps: () => ipcRenderer.invoke("launcher:refresh"),
  hideLauncher: () => ipcRenderer.invoke("launcher:hide"),
  notifyLauncherReady: () => ipcRenderer.send("launcher:ready"),

  // ---- Floating Ball ----
  openFloatingBallFeature: (feature: "appLauncher") =>
    ipcRenderer.invoke("floating-ball:open-feature", feature),
  toggleFloatingBallMenu: () => ipcRenderer.invoke("floating-ball:toggle-menu"),
  moveFloatingBallBy: (delta: { x: number; y: number }) =>
    ipcRenderer.invoke("floating-ball:move-by", delta),
  hideFloatingBall: () => ipcRenderer.invoke("floating-ball:hide"),

  // ---- Settings ----
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke("settings:update", patch),

  // ---- Plugins ----
  listPlugins: () => ipcRenderer.invoke("plugin:list"),
  getPlugin: (pluginId: string) => ipcRenderer.invoke("plugin:get", pluginId),
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke("plugin:set-enabled", { pluginId, enabled }),
  setPluginPreference: (pluginId: string, key: string, value: unknown) =>
    ipcRenderer.invoke("plugin:set-preference", { pluginId, key, value }),
  installPluginFolder: (folderPath: string) =>
    ipcRenderer.invoke("plugin:install-folder", folderPath),
  installPluginPackage: (zipPath: string) => ipcRenderer.invoke("plugin:install-package", zipPath),
  uninstallPlugin: (pluginId: string) => ipcRenderer.invoke("plugin:uninstall", pluginId),
  reloadPlugin: (pluginId?: string) => ipcRenderer.invoke("plugin:reload", pluginId),
  searchPluginCommands: (query: string, locale?: string, limit?: number) =>
    ipcRenderer.invoke("plugin:search-commands", { query, locale, limit }),
  invokePluginCommand: (
    pluginId: string,
    commandId: string,
    phase: "run" | "onSearchChange" | "onAction",
    payload?: unknown
  ) => ipcRenderer.invoke("plugin:invoke", { pluginId, commandId, phase, payload }),
  disposePluginCommand: (pluginId: string, commandId: string) =>
    ipcRenderer.invoke("plugin:dispose-command", { pluginId, commandId }),
  listMarketplacePlugins: () => ipcRenderer.invoke("marketplace:list"),
  installMarketplacePlugin: (id: string, version?: string) =>
    ipcRenderer.invoke("marketplace:install", { id, version }),

  // Subscribe to the "search window just gained focus" pulse so the
  // renderer can reset its input + selection without polling.
  onLauncherFocus: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on("launcher:focus", listener)
    return () => ipcRenderer.removeListener("launcher:focus", listener)
  },

  onFloatingBallMenuState: (handler: (expanded: boolean) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, expanded: boolean): void => handler(expanded)
    ipcRenderer.on("floating-ball:menu-state", listener)
    return () => ipcRenderer.removeListener("floating-ball:menu-state", listener)
  },

  onFloatingBallFeatures: (handler: (features: "appLauncher"[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, features: "appLauncher"[]): void =>
      handler(features)
    ipcRenderer.on("floating-ball:features", listener)
    return () => ipcRenderer.removeListener("floating-ball:features", listener)
  },

  onPluginRegistryChanged: (handler: (plugins: unknown[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, plugins: unknown[]): void => handler(plugins)
    ipcRenderer.on("plugins:registry-changed", listener)
    return () => ipcRenderer.removeListener("plugins:registry-changed", listener)
  },

  // Pushed by main after any settings:update so that windows other than
  // the one that initiated the change (notably the long-lived launcher
  // window) can re-apply theme/hotkey state without a reload.
  onSettingsChanged: (handler: (settings: Settings) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, settings: Settings): void => handler(settings)
    ipcRenderer.on("settings:changed", listener)
    return () => ipcRenderer.removeListener("settings:changed", listener)
  },
} as const

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

export type ElectronAPI = typeof electronAPI
