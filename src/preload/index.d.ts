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

  type DeskitLocalizedString = string | Record<string, string>
  type DeskitPluginSourceKind = "builtin" | "user" | "dev"
  type DeskitPluginRuntimeStatus = "active" | "disabled" | "invalid" | "crashed" | "shadowed"
  type DeskitPluginCommandMode = "view" | "no-view"
  type DeskitPluginInvokePhase = "run" | "onSearchChange" | "onAction"

  interface DeskitPluginSource {
    kind: DeskitPluginSourceKind
    priority: number
  }

  interface DeskitManifestCommand {
    id: string
    title: DeskitLocalizedString
    subtitle?: DeskitLocalizedString
    keywords?: string[]
    mode: DeskitPluginCommandMode
    icon?: string
  }

  interface DeskitPluginManifest {
    id: string
    name: string
    displayName: DeskitLocalizedString
    description: DeskitLocalizedString
    version: string
    author: string
    icon?: string
    engines: { deskit: string }
    main: string
    contributes: {
      commands: DeskitManifestCommand[]
      preferences?: Array<{
        id: string
        type: "text" | "number" | "checkbox" | "select"
        label: DeskitLocalizedString
        default?: unknown
        options?: Array<{ value: string; label: DeskitLocalizedString }>
      }>
    }
    permissions: string[]
  }

  interface DeskitPluginRegistryEntry {
    pluginId: string
    rootDir: string
    source: DeskitPluginSource
    status: DeskitPluginRuntimeStatus
    manifest?: DeskitPluginManifest
    error?: string
    shadowedBy?: DeskitPluginSourceKind
    loadedAt?: number
  }

  interface DeskitPluginCommandResult {
    kind: "plugin-command"
    pluginId: string
    commandId: string
    title: DeskitLocalizedString
    subtitle?: DeskitLocalizedString
    icon?: string
    mode: DeskitPluginCommandMode
    score: number
    matches: number[]
  }

  type DeskitPluginView =
    | { type: "list"; [key: string]: unknown }
    | { type: "detail"; [key: string]: unknown }
    | { type: "form"; [key: string]: unknown }
    | { type: "toast"; [key: string]: unknown }

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
      listPlugins: () => Promise<DeskitPluginRegistryEntry[]>
      getPlugin: (pluginId: string) => Promise<DeskitPluginRegistryEntry | null>
      setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<DeskitPluginRegistryEntry>
      setPluginPreference: (pluginId: string, key: string, value: unknown) => Promise<void>
      installPluginFolder: (folderPath: string) => Promise<DeskitPluginRegistryEntry>
      installPluginPackage: (zipPath: string) => Promise<DeskitPluginRegistryEntry>
      uninstallPlugin: (pluginId: string) => Promise<void>
      reloadPlugin: (pluginId?: string) => Promise<DeskitPluginRegistryEntry | undefined>
      searchPluginCommands: (
        query: string,
        locale?: string,
        limit?: number
      ) => Promise<DeskitPluginCommandResult[]>
      invokePluginCommand: (
        pluginId: string,
        commandId: string,
        phase: DeskitPluginInvokePhase,
        payload?: unknown
      ) => Promise<DeskitPluginView | void>
      disposePluginCommand: (pluginId: string, commandId: string) => Promise<void>
      listMarketplacePlugins: () => Promise<unknown[]>
      installMarketplacePlugin: (id: string, version?: string) => Promise<unknown>
      onLauncherFocus: (handler: () => void) => () => void
      onFloatingBallMenuState: (handler: (expanded: boolean) => void) => () => void
      onFloatingBallFeatures: (
        handler: (features: DeskitFloatingBallFeature[]) => void
      ) => () => void
      onPluginRegistryChanged: (
        handler: (plugins: DeskitPluginRegistryEntry[]) => void
      ) => () => void
      onSettingsChanged: (handler: (settings: DeskitUserSettings) => void) => () => void
    }
  }
}
