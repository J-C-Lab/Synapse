import { contextBridge, ipcRenderer } from "electron"

const electronAPI = {
  greet: (name: string): Promise<string> => ipcRenderer.invoke("greet", name),
} as const

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

export type ElectronAPI = typeof electronAPI
