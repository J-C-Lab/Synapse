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
export type LanDevice = DeskitLanDevice
export type LanStatus = DeskitLanStatus
export type LanPairing = DeskitLanPairing
export type LanTransfer = DeskitLanTransfer
export type PluginRegistryEntry = DeskitPluginRegistryEntry
export type MarketplaceEntry = DeskitMarketplaceEntry
export type PluginCommandResult = DeskitPluginCommandResult
export type PluginInvokePhase = DeskitPluginInvokePhase
export type PluginView = DeskitPluginView
export type PluginIpcError = DeskitPluginIpcError
export type PluginIpcErrorCode = DeskitPluginIpcErrorCode
type PluginIpcResult<T> = DeskitPluginIpcResult<T>

export class ElectronIpcError extends Error {
  readonly code: PluginIpcErrorCode
  readonly details?: Record<string, unknown>

  constructor(error: PluginIpcError) {
    super(error.message)
    this.name = "ElectronIpcError"
    this.code = error.code
    this.details = error.details
  }
}

function unwrapIpcResult<T>(result: PluginIpcResult<T>): T {
  if (result.ok) return result.data
  throw new ElectronIpcError(result.error)
}

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

export async function openExternalUrl(url: string): Promise<boolean> {
  return api().openExternalUrl(url)
}

export async function writeClipboardContent(content: DeskitClipboardContent): Promise<boolean> {
  return api().writeClipboardContent(content)
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

export async function getLanStatus(): Promise<LanStatus> {
  return api().getLanStatus()
}

export async function listLanDevices(): Promise<LanDevice[]> {
  return api().listLanDevices()
}

export async function listLanPairings(): Promise<LanPairing[]> {
  return api().listLanPairings()
}

export async function pairLanDevice(deviceId: string): Promise<LanPairing> {
  return api().pairLanDevice(deviceId)
}

export async function confirmLanPairing(pairingId: string, sas: string): Promise<LanPairing[]> {
  return api().confirmLanPairing(pairingId, sas)
}

export async function rejectLanPairing(pairingId: string): Promise<LanPairing[]> {
  return api().rejectLanPairing(pairingId)
}

export async function disconnectLanDevice(deviceId: string): Promise<void> {
  await api().disconnectLanDevice(deviceId)
}

export async function listLanTransfers(): Promise<LanTransfer[]> {
  return api().listLanTransfers()
}

export async function sendLanFile(deviceId: string): Promise<LanTransfer | null> {
  return api().sendLanFile(deviceId)
}

export async function resumeLanTransfer(transferId: string): Promise<LanTransfer> {
  return api().resumeLanTransfer(transferId)
}

export async function acceptLanTransfer(transferId: string): Promise<LanTransfer | null> {
  return api().acceptLanTransfer(transferId)
}

export async function rejectLanTransfer(transferId: string): Promise<LanTransfer> {
  return api().rejectLanTransfer(transferId)
}

export async function removeLanTransferHistory(transferId: string): Promise<LanTransfer[]> {
  return api().removeLanTransferHistory(transferId)
}

export async function listPlugins(): Promise<PluginRegistryEntry[]> {
  return unwrapIpcResult(await api().listPlugins())
}

export async function getPlugin(pluginId: string): Promise<PluginRegistryEntry | null> {
  return unwrapIpcResult(await api().getPlugin(pluginId))
}

export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean
): Promise<PluginRegistryEntry> {
  return unwrapIpcResult(await api().setPluginEnabled(pluginId, enabled))
}

export async function setPluginPreference(
  pluginId: string,
  key: string,
  value: unknown
): Promise<void> {
  unwrapIpcResult(await api().setPluginPreference(pluginId, key, value))
}

export async function installPluginFolder(folderPath: string): Promise<PluginRegistryEntry> {
  return unwrapIpcResult(await api().installPluginFolder(folderPath))
}

export async function installPluginPackage(zipPath: string): Promise<PluginRegistryEntry> {
  return unwrapIpcResult(await api().installPluginPackage(zipPath))
}

/**
 * Open the native file picker and install the chosen `.deskit` package.
 * Resolves to null if the user cancelled the dialog.
 */
export async function importPluginFromFile(): Promise<PluginRegistryEntry | null> {
  return unwrapIpcResult(await api().importPluginFromFile())
}

/** Resolve the absolute path of a dropped File (Electron 33 removed File.path). */
export function droppedFilePath(file: File): string {
  return api().getDroppedFilePath(file)
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  unwrapIpcResult(await api().uninstallPlugin(pluginId))
}

export async function reloadPlugin(pluginId?: string): Promise<PluginRegistryEntry | undefined> {
  return unwrapIpcResult(await api().reloadPlugin(pluginId))
}

export async function searchPluginCommands(
  query: string,
  locale?: string,
  limit?: number
): Promise<PluginCommandResult[]> {
  return unwrapIpcResult(await api().searchPluginCommands(query, locale, limit))
}

export async function invokePluginCommand(
  pluginId: string,
  commandId: string,
  phase: PluginInvokePhase,
  payload?: unknown
): Promise<PluginView | void> {
  return unwrapIpcResult(await api().invokePluginCommand(pluginId, commandId, phase, payload))
}

export async function disposePluginCommand(pluginId: string, commandId: string): Promise<void> {
  unwrapIpcResult(await api().disposePluginCommand(pluginId, commandId))
}

export async function listMarketplacePlugins(): Promise<MarketplaceEntry[]> {
  return unwrapIpcResult(await api().listMarketplacePlugins())
}

export async function installMarketplacePlugin(
  id: string,
  version?: string
): Promise<PluginRegistryEntry> {
  return unwrapIpcResult(await api().installMarketplacePlugin(id, version))
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

export function onLanDevicesChanged(handler: (devices: LanDevice[]) => void): () => void {
  return api().onLanDevicesChanged(handler)
}

export function onLanStatusChanged(handler: (status: LanStatus) => void): () => void {
  return api().onLanStatusChanged(handler)
}

export function onLanPairingsChanged(handler: (pairings: LanPairing[]) => void): () => void {
  return api().onLanPairingsChanged(handler)
}

export function onLanTransfersChanged(handler: (transfers: LanTransfer[]) => void): () => void {
  return api().onLanTransfersChanged(handler)
}
