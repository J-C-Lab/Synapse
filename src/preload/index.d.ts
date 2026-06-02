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
  type DeskitClipboardContent =
    | { type: "text"; text: string }
    | {
        type: "image"
        dataUrl: string
        mimeType: string
        width?: number
        height?: number
        name?: string
      }
    | { type: "file"; paths: string[] }
  type DeskitPluginSourceKind = "builtin" | "user" | "dev"
  type DeskitPluginRuntimeStatus = "active" | "disabled" | "invalid" | "crashed" | "shadowed"
  type DeskitPluginCommandMode = "view" | "no-view"
  type DeskitPluginActivationEvent = "clipboard:change"
  type DeskitPluginInvokePhase = "run" | "onSearchChange" | "onAction"
  type DeskitPluginIpcErrorCode =
    | "IPC_FORBIDDEN"
    | "IPC_INVALID_PAYLOAD"
    | "PLUGIN_NOT_FOUND"
    | "PLUGIN_NOT_ACTIVE"
    | "PLUGIN_PERMISSION_DENIED"
    | "PLUGIN_CRASHED"
    | "PLUGIN_NOT_IMPLEMENTED"
    | "PLUGIN_INSTALL_ERROR"
    | "PLUGIN_IO_ERROR"
    | "UNKNOWN_ERROR"

  interface DeskitPluginIpcError {
    code: DeskitPluginIpcErrorCode
    message: string
    details?: Record<string, unknown>
  }

  type DeskitPluginIpcResult<T> = { ok: true; data: T } | { ok: false; error: DeskitPluginIpcError }

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
      activationEvents?: DeskitPluginActivationEvent[]
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
    preferences?: Record<string, unknown>
    error?: string
    shadowedBy?: DeskitPluginSourceKind
    loadedAt?: number
  }

  interface DeskitMarketplaceEntry {
    id: string
    name: string
    displayName: DeskitLocalizedString
    description: DeskitLocalizedString
    author: string
    homepage: string
    version: string
    downloadUrl: string
    sha256: string
    deskitEngine: string
    icon?: string
    categories?: string[]
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
      openExternalUrl: (url: string) => Promise<boolean>
      writeClipboardContent: (content: DeskitClipboardContent) => Promise<boolean>
      notifyLauncherReady: () => void
      openFloatingBallFeature: (feature: DeskitFloatingBallFeature) => Promise<void>
      toggleFloatingBallMenu: () => Promise<void>
      moveFloatingBallBy: (delta: { x: number; y: number }) => Promise<void>
      hideFloatingBall: () => Promise<void>
      getSettings: () => Promise<DeskitUserSettings>
      updateSettings: (patch: Partial<DeskitUserSettings>) => Promise<DeskitUserSettings>
      listPlugins: () => Promise<DeskitPluginIpcResult<DeskitPluginRegistryEntry[]>>
      getPlugin: (
        pluginId: string
      ) => Promise<DeskitPluginIpcResult<DeskitPluginRegistryEntry | null>>
      setPluginEnabled: (
        pluginId: string,
        enabled: boolean
      ) => Promise<DeskitPluginIpcResult<DeskitPluginRegistryEntry>>
      setPluginPreference: (
        pluginId: string,
        key: string,
        value: unknown
      ) => Promise<DeskitPluginIpcResult<void>>
      installPluginFolder: (
        folderPath: string
      ) => Promise<DeskitPluginIpcResult<DeskitPluginRegistryEntry>>
      installPluginPackage: (
        zipPath: string
      ) => Promise<DeskitPluginIpcResult<DeskitPluginRegistryEntry>>
      importPluginFromFile: () => Promise<DeskitPluginIpcResult<DeskitPluginRegistryEntry | null>>
      getDroppedFilePath: (file: File) => string
      uninstallPlugin: (pluginId: string) => Promise<DeskitPluginIpcResult<void>>
      reloadPlugin: (
        pluginId?: string
      ) => Promise<DeskitPluginIpcResult<DeskitPluginRegistryEntry | undefined>>
      searchPluginCommands: (
        query: string,
        locale?: string,
        limit?: number
      ) => Promise<DeskitPluginIpcResult<DeskitPluginCommandResult[]>>
      invokePluginCommand: (
        pluginId: string,
        commandId: string,
        phase: DeskitPluginInvokePhase,
        payload?: unknown
      ) => Promise<DeskitPluginIpcResult<DeskitPluginView | void>>
      disposePluginCommand: (
        pluginId: string,
        commandId: string
      ) => Promise<DeskitPluginIpcResult<void>>
      listMarketplacePlugins: () => Promise<DeskitPluginIpcResult<DeskitMarketplaceEntry[]>>
      installMarketplacePlugin: (
        id: string,
        version?: string
      ) => Promise<DeskitPluginIpcResult<DeskitPluginRegistryEntry>>
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
