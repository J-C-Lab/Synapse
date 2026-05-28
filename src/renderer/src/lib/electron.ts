/**
 * Detects whether the app is running inside an Electron renderer.
 * Use this to gate any code that calls IPC so the same component
 * works in both `pnpm dev` (web) and `pnpm electron:dev` (desktop).
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && Boolean(window.electronAPI)
}

function api(): NonNullable<Window["electronAPI"]> {
  if (!window.electronAPI) {
    throw new Error("electronAPI is unavailable — not running in Electron (preload did not run)")
  }
  return window.electronAPI
}

export type AppEntry = LauncherAppEntry
export type SearchResult = LauncherSearchResult
export type UserSettings = DeskitUserSettings
export type FloatingBallFeature = DeskitFloatingBallFeature
export type PluginRegistryEntry = DeskitPluginRegistryEntry
export type PluginCommandResult = DeskitPluginCommandResult
export type PluginInvokePhase = DeskitPluginInvokePhase
export type PluginView = DeskitPluginView

/**
 * Type-safe wrappers for IPC commands defined in src/main/index.ts.
 * Keep this file as the SOLE caller of `window.electronAPI` — business
 * code imports named functions from here, never `electronAPI` directly.
 */
export async function searchApps(query: string): Promise<SearchResult[]> {
  return api().searchApps(query)
}

export async function launchApp(id: string): Promise<boolean> {
  return api().launchApp(id)
}

export async function refreshApps(): Promise<AppEntry[]> {
  return api().refreshApps()
}

export async function hideLauncher(): Promise<void> {
  await api().hideLauncher()
}

export function notifyLauncherReady(): void {
  api().notifyLauncherReady()
}

export async function openFloatingBallFeature(feature: FloatingBallFeature): Promise<void> {
  await api().openFloatingBallFeature(feature)
}

export async function toggleFloatingBallMenu(): Promise<void> {
  await api().toggleFloatingBallMenu()
}

export async function moveFloatingBallBy(delta: { x: number; y: number }): Promise<void> {
  await api().moveFloatingBallBy(delta)
}

export async function hideFloatingBall(): Promise<void> {
  await api().hideFloatingBall()
}

export async function getSettings(): Promise<UserSettings> {
  return api().getSettings()
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  return api().updateSettings(patch)
}

export async function listPlugins(): Promise<PluginRegistryEntry[]> {
  return api().listPlugins()
}

export async function getPlugin(pluginId: string): Promise<PluginRegistryEntry | null> {
  return api().getPlugin(pluginId)
}

export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean
): Promise<PluginRegistryEntry> {
  return api().setPluginEnabled(pluginId, enabled)
}

export async function setPluginPreference(
  pluginId: string,
  key: string,
  value: unknown
): Promise<void> {
  await api().setPluginPreference(pluginId, key, value)
}

export async function installPluginFolder(folderPath: string): Promise<PluginRegistryEntry> {
  return api().installPluginFolder(folderPath)
}

export async function installPluginPackage(zipPath: string): Promise<PluginRegistryEntry> {
  return api().installPluginPackage(zipPath)
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  await api().uninstallPlugin(pluginId)
}

export async function reloadPlugin(pluginId?: string): Promise<PluginRegistryEntry | undefined> {
  return api().reloadPlugin(pluginId)
}

export async function searchPluginCommands(
  query: string,
  locale?: string,
  limit?: number
): Promise<PluginCommandResult[]> {
  return api().searchPluginCommands(query, locale, limit)
}

export async function invokePluginCommand(
  pluginId: string,
  commandId: string,
  phase: PluginInvokePhase,
  payload?: unknown
): Promise<PluginView | void> {
  return api().invokePluginCommand(pluginId, commandId, phase, payload)
}

export async function disposePluginCommand(pluginId: string, commandId: string): Promise<void> {
  await api().disposePluginCommand(pluginId, commandId)
}

export async function listMarketplacePlugins(): Promise<unknown[]> {
  return api().listMarketplacePlugins()
}

export async function installMarketplacePlugin(id: string, version?: string): Promise<unknown> {
  return api().installMarketplacePlugin(id, version)
}

export function onLauncherFocus(handler: () => void): () => void {
  return api().onLauncherFocus(handler)
}

export function onFloatingBallMenuState(handler: (expanded: boolean) => void): () => void {
  return api().onFloatingBallMenuState(handler)
}

export function onFloatingBallFeatures(
  handler: (features: FloatingBallFeature[]) => void
): () => void {
  return api().onFloatingBallFeatures(handler)
}

export function onPluginRegistryChanged(
  handler: (plugins: PluginRegistryEntry[]) => void
): () => void {
  return api().onPluginRegistryChanged(handler)
}

export function onSettingsChanged(handler: (settings: UserSettings) => void): () => void {
  return api().onSettingsChanged(handler)
}
