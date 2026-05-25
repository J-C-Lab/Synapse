// Global typings for the surface exposed by src/preload/index.ts.
// Kept in the preload package so the renderer and the preload always
// agree on the contract.

export {}

declare global {
  type LauncherAppKind = "win32" | "uwp" | "url" | "macos"
  type DeskitFloatingBallFeature = "appLauncher"

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

  type DeskitThemeMode = "light" | "dark" | "system"
  type DeskitThemeAccent = "neutral" | "blue" | "green" | "rose" | "violet"

  interface DeskitUserSettings {
    hotkey: string
    themeMode: DeskitThemeMode
    accent: DeskitThemeAccent
    floatingBallEnabled: boolean
    floatingBallFeatures: DeskitFloatingBallFeature[]
  }

  interface Window {
    electronAPI?: {
      searchApps: (query: string) => Promise<LauncherSearchResult[]>
      launchApp: (id: string) => Promise<boolean>
      refreshApps: () => Promise<LauncherAppEntry[]>
      hideLauncher: () => Promise<void>
      notifyLauncherReady: () => void
      openFloatingBallFeature: (feature: DeskitFloatingBallFeature) => Promise<void>
      toggleFloatingBallMenu: () => Promise<void>
      moveFloatingBallBy: (delta: { x: number; y: number }) => Promise<void>
      hideFloatingBall: () => Promise<void>
      getSettings: () => Promise<DeskitUserSettings>
      updateSettings: (patch: Partial<DeskitUserSettings>) => Promise<DeskitUserSettings>
      onLauncherFocus: (handler: () => void) => () => void
      onFloatingBallMenuState: (handler: (expanded: boolean) => void) => () => void
      onFloatingBallFeatures: (
        handler: (features: DeskitFloatingBallFeature[]) => void
      ) => () => void
      onSettingsChanged: (handler: (settings: DeskitUserSettings) => void) => () => void
    }
  }
}
