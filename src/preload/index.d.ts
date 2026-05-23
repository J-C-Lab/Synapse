// Global typings for the surface exposed by src/preload/index.ts.
// Kept in the preload package so the renderer and the preload always
// agree on the contract.

export {}

declare global {
  type LauncherAppKind = "win32" | "uwp" | "url"

  interface LauncherAppEntry {
    id: string
    kind: LauncherAppKind
    name: string
    nameLower: string
    target: string
    description?: string
    iconPath?: string
  }

  interface LauncherSearchResult {
    entry: LauncherAppEntry
    score: number
    matches: number[]
  }

  interface DeskitUserSettings {
    hotkey: string
  }

  interface Window {
    electronAPI?: {
      searchApps: (query: string) => Promise<LauncherSearchResult[]>
      launchApp: (id: string) => Promise<boolean>
      refreshApps: () => Promise<LauncherAppEntry[]>
      hideLauncher: () => Promise<void>
      getSettings: () => Promise<DeskitUserSettings>
      updateSettings: (patch: Partial<DeskitUserSettings>) => Promise<DeskitUserSettings>
      onLauncherFocus: (handler: () => void) => () => void
    }
  }
}
