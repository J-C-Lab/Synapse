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
}
type Settings = Required<SettingsPatch>

const electronAPI = {
  // ---- Launcher ----
  searchApps: (query: string) => ipcRenderer.invoke("launcher:search", query),
  launchApp: (id: string) => ipcRenderer.invoke("launcher:launch", id),
  refreshApps: () => ipcRenderer.invoke("launcher:refresh"),
  hideLauncher: () => ipcRenderer.invoke("launcher:hide"),

  // ---- Settings ----
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke("settings:update", patch),

  // Subscribe to the "search window just gained focus" pulse so the
  // renderer can reset its input + selection without polling.
  onLauncherFocus: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on("launcher:focus", listener)
    return () => ipcRenderer.removeListener("launcher:focus", listener)
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
