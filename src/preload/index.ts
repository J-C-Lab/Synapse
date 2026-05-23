import { contextBridge, ipcRenderer } from "electron"

const electronAPI = {
  // ---- Launcher ----
  searchApps: (query: string) => ipcRenderer.invoke("launcher:search", query),
  launchApp: (id: string) => ipcRenderer.invoke("launcher:launch", id),
  refreshApps: () => ipcRenderer.invoke("launcher:refresh"),
  hideLauncher: () => ipcRenderer.invoke("launcher:hide"),

  // ---- Settings ----
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: { hotkey?: string }) => ipcRenderer.invoke("settings:update", patch),

  // Subscribe to the "search window just gained focus" pulse so the
  // renderer can reset its input + selection without polling.
  onLauncherFocus: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on("launcher:focus", listener)
    return () => ipcRenderer.removeListener("launcher:focus", listener)
  },
} as const

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

export type ElectronAPI = typeof electronAPI
