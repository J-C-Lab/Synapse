import type {
  AdminReportsResponse,
  MyPluginsResponse,
  PluginDetailResponse,
  PluginSummary,
  RateResponse,
  Report,
  SearchPluginsResponse,
  User,
} from "@synapse/marketplace-types"

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
export type FrequentAppEntry = LauncherFrequentAppEntry
export type UserSettings = SynapseUserSettings
export type FloatingBallFeature = SynapseFloatingBallFeature
export type LanDevice = SynapseLanDevice
export type LanStatus = SynapseLanStatus
export type LanPairing = SynapseLanPairing
export type LanTransfer = SynapseLanTransfer
export type PluginRegistryEntry = SynapsePluginRegistryEntry
export type PluginCapabilityRow = SynapsePluginCapabilityRow
export type PluginCredentialRow = SynapsePluginCredentialRow
export type PluginTriggerRow = SynapsePluginTriggerRow
export type TriggerInstanceRow = SynapseTriggerInstanceRow
export type TriggerMigrationNoticeState = SynapseTriggerMigrationNoticeState
export type CapabilityGrantRequestEvent = SynapseCapabilityGrantRequestEvent
export type CapabilityApprovalRequestEvent = SynapseCapabilityApprovalRequestEvent
export type HostResourceApprovalRequestEvent = SynapseHostResourceApprovalRequestEvent
export type MarketplaceEntry = SynapseMarketplaceEntry
export type MarketplaceSummary = PluginSummary
export type MarketplaceDetail = PluginDetailResponse
export type MarketplaceSearchResponse = SearchPluginsResponse
export type MarketplaceUser = User
export type MarketplaceReport = Report
export type MarketplaceReportsResponse = AdminReportsResponse
export interface MarketplaceAccount {
  user: User | null
}
export interface MarketplaceLoginPrompt {
  verificationUri: string
  userCode: string
  expiresAt: string
}
export interface CredentialConnectPrompt {
  pluginId: string
  credentialId: string
  provider: "github"
  authorizationUrl: string
}
export type PluginCommandResult = SynapsePluginCommandResult
export type PluginInvokePhase = SynapsePluginInvokePhase
export type PluginView = SynapsePluginView
export type PluginIpcError = SynapsePluginIpcError
export type PluginIpcErrorCode = SynapsePluginIpcErrorCode
type PluginIpcResult<T> = SynapsePluginIpcResult<T>

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

export async function getFrequentApps(limit?: number): Promise<FrequentAppEntry[]> {
  return api().getFrequentApps(limit)
}

export async function removeFrequentApp(id: string): Promise<void> {
  await api().removeFrequentApp(id)
}

export async function hideLauncher(): Promise<void> {
  await api().hideLauncher()
}

export async function pauseHotkeyCapture(): Promise<void> {
  await api().pauseHotkeyCapture()
}

export async function resumeHotkeyCapture(): Promise<boolean> {
  return api().resumeHotkeyCapture()
}

export async function openExternalUrl(url: string): Promise<boolean> {
  return api().openExternalUrl(url)
}

export async function writeClipboardContent(content: SynapseClipboardContent): Promise<boolean> {
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

export async function listPluginCapabilities(pluginId: string): Promise<PluginCapabilityRow[]> {
  return unwrapIpcResult(await api().listPluginCapabilities(pluginId))
}

export type { PluginCapabilityProfile, ProfileLine } from "@synapse/plugin-manifest"

export async function getPluginCapabilityProfile(
  pluginId: string
): Promise<import("@synapse/plugin-manifest").PluginCapabilityProfile> {
  return unwrapIpcResult(await api().getCapabilityProfile(pluginId))
}

export async function previewPluginCapabilityProfile(
  manifest: import("@synapse/plugin-manifest").PluginManifest
): Promise<import("@synapse/plugin-manifest").PluginCapabilityProfile> {
  return unwrapIpcResult(await api().previewPluginCapabilityProfile(manifest))
}

export async function revokePluginCapability(pluginId: string, capability: string): Promise<void> {
  unwrapIpcResult(await api().revokePluginCapability(pluginId, capability))
}

export async function setExternalMcpPreauthorized(
  pluginId: string,
  capability: string,
  value: boolean
): Promise<void> {
  unwrapIpcResult(await api().setExternalMcpPreauthorized(pluginId, capability, value))
}

export async function getMcpNonReadOnlyExposed(pluginId: string): Promise<boolean> {
  return unwrapIpcResult(await api().getMcpNonReadOnlyExposed(pluginId))
}

export async function setMcpNonReadOnlyExposed(pluginId: string, value: boolean): Promise<void> {
  unwrapIpcResult(await api().setMcpNonReadOnlyExposed(pluginId, value))
}

export async function listPluginCredentials(pluginId: string): Promise<PluginCredentialRow[]> {
  return unwrapIpcResult(await api().listPluginCredentials(pluginId))
}

export async function connectPluginCredential(
  pluginId: string,
  credentialId: string
): Promise<void> {
  unwrapIpcResult(await api().connectPluginCredential(pluginId, credentialId))
}

export async function disconnectPluginCredential(
  pluginId: string,
  credentialId: string
): Promise<void> {
  unwrapIpcResult(await api().disconnectPluginCredential(pluginId, credentialId))
}

export async function resolveCapabilityGrant(promptId: string, allow: boolean): Promise<void> {
  unwrapIpcResult(await api().resolveCapabilityGrant(promptId, allow))
}

export async function resolveCapabilityApproval(promptId: string, allow: boolean): Promise<void> {
  unwrapIpcResult(await api().resolveCapabilityApproval(promptId, allow))
}

export async function resolveHostResourceApproval(promptId: string, allow: boolean): Promise<void> {
  unwrapIpcResult(await api().resolveHostResourceApproval(promptId, allow))
}

export function onCapabilityGrantRequest(
  handler: (event: CapabilityGrantRequestEvent) => void
): () => void {
  return api().onCapabilityGrantRequest(handler)
}

export function onCapabilityApprovalRequest(
  handler: (event: CapabilityApprovalRequestEvent) => void
): () => void {
  return api().onCapabilityApprovalRequest(handler)
}

export function onHostResourceApprovalRequest(
  handler: (event: HostResourceApprovalRequestEvent) => void
): () => void {
  return api().onHostResourceApprovalRequest(handler)
}

export async function listTriggers(): Promise<PluginTriggerRow[]> {
  return unwrapIpcResult(await api().listTriggers())
}

export async function pauseTrigger(pluginId: string, triggerId: string): Promise<void> {
  unwrapIpcResult(await api().pauseTrigger(pluginId, triggerId))
}

export async function resumeTrigger(pluginId: string, triggerId: string): Promise<void> {
  unwrapIpcResult(await api().resumeTrigger(pluginId, triggerId))
}

export async function killTrigger(pluginId: string, triggerId: string): Promise<void> {
  unwrapIpcResult(await api().killTrigger(pluginId, triggerId))
}

export async function listTriggerInstances(
  pluginId: string,
  triggerId: string
): Promise<TriggerInstanceRow[]> {
  return unwrapIpcResult(await api().listTriggerInstances(pluginId, triggerId))
}

export async function createTriggerInstance(
  pluginId: string,
  triggerId: string,
  workspaceId: string
): Promise<TriggerInstanceRow> {
  return unwrapIpcResult(await api().createTriggerInstance(pluginId, triggerId, workspaceId))
}

export async function reactivateTriggerInstance(instanceId: string): Promise<TriggerInstanceRow> {
  return unwrapIpcResult(await api().reactivateTriggerInstance(instanceId))
}

export async function pauseTriggerInstance(instanceId: string): Promise<void> {
  unwrapIpcResult(await api().pauseTriggerInstance(instanceId))
}

export async function resumeTriggerInstance(instanceId: string): Promise<void> {
  unwrapIpcResult(await api().resumeTriggerInstance(instanceId))
}

export async function removeTriggerInstance(instanceId: string): Promise<void> {
  unwrapIpcResult(await api().removeTriggerInstance(instanceId))
}

export async function getTriggerMigrationNotice(): Promise<TriggerMigrationNoticeState> {
  return unwrapIpcResult(await api().getTriggerMigrationNotice())
}

export async function dismissTriggerMigrationNotice(): Promise<void> {
  unwrapIpcResult(await api().dismissTriggerMigrationNotice())
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

export type PendingTriggerCapability = SynapsePendingTriggerCapability
export type PendingTriggerCapabilityConfirmation = SynapsePendingTriggerCapabilityConfirmation

export async function listPendingTriggerCapabilities(): Promise<
  PendingTriggerCapabilityConfirmation[]
> {
  return unwrapIpcResult(await api().listPendingTriggerCapabilities())
}

export async function confirmTriggerCapabilities(
  pluginId: string,
  capabilityIds: string[]
): Promise<PendingTriggerCapability[]> {
  return unwrapIpcResult(await api().confirmTriggerCapabilities(pluginId, capabilityIds))
}

export async function confirmAndEnablePlugin(
  pluginId: string,
  capabilityIds: string[]
): Promise<PluginRegistryEntry> {
  return unwrapIpcResult(await api().confirmAndEnablePlugin(pluginId, capabilityIds))
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
 * Open the native file picker and install the chosen `.syn` package.
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

export async function searchMarketplace(query?: string): Promise<MarketplaceSearchResponse> {
  return unwrapIpcResult(await api().searchMarketplace(query))
}

export async function getMarketplaceDetail(pluginId: string): Promise<MarketplaceDetail> {
  return unwrapIpcResult(await api().getMarketplaceDetail(pluginId))
}

export async function installMarketplaceBackendPlugin(
  id: string,
  version: string
): Promise<PluginRegistryEntry> {
  return unwrapIpcResult(await api().installMarketplaceBackendPlugin(id, version))
}

export async function getMarketplaceAccount(): Promise<MarketplaceAccount> {
  return unwrapIpcResult(await api().getMarketplaceAccount())
}

export async function marketplaceLogin(): Promise<MarketplaceUser> {
  return unwrapIpcResult(await api().marketplaceLogin())
}

export async function marketplaceLogout(): Promise<void> {
  unwrapIpcResult(await api().marketplaceLogout())
}

export async function rateMarketplacePlugin(id: string, stars: number): Promise<RateResponse> {
  return unwrapIpcResult(await api().rateMarketplacePlugin(id, stars))
}

export async function listMyMarketplacePlugins(): Promise<MyPluginsResponse> {
  return unwrapIpcResult(await api().listMyMarketplacePlugins())
}

export async function setMarketplaceVisibility(
  id: string,
  visibility: "public" | "private"
): Promise<MarketplaceDetail> {
  return unwrapIpcResult(await api().setMarketplaceVisibility(id, visibility))
}

export async function yankMarketplaceVersion(
  id: string,
  version: string,
  reason?: string
): Promise<MarketplaceDetail> {
  return unwrapIpcResult(await api().yankMarketplaceVersion(id, version, reason))
}

export async function reportMarketplacePlugin(id: string, reason: string): Promise<void> {
  unwrapIpcResult(await api().reportMarketplacePlugin(id, reason))
}

export async function removeMarketplacePlugin(id: string): Promise<void> {
  unwrapIpcResult(await api().removeMarketplacePlugin(id))
}

export async function restoreMarketplacePlugin(id: string): Promise<void> {
  unwrapIpcResult(await api().restoreMarketplacePlugin(id))
}

export async function listMarketplaceReports(
  status?: "open" | "reviewed" | "dismissed"
): Promise<AdminReportsResponse> {
  return unwrapIpcResult(await api().listMarketplaceReports(status))
}

export async function resolveMarketplaceReport(
  reportId: string,
  status: "reviewed" | "dismissed"
): Promise<void> {
  unwrapIpcResult(await api().resolveMarketplaceReport(reportId, status))
}

export function onMarketplaceLoginPrompt(
  handler: (prompt: MarketplaceLoginPrompt) => void
): () => void {
  return api().onMarketplaceLoginPrompt(handler)
}

export function onCredentialConnectPrompt(
  handler: (prompt: CredentialConnectPrompt) => void
): () => void {
  return api().onCredentialConnectPrompt(handler)
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

export type AiStatus = SynapseAiStatus
export type AiProviderStatus = SynapseAiProviderStatus
export type AiTool = SynapseAiTool
export type AiConversationSummary = SynapseAiConversationSummary
export type AiWorkspace = SynapseAiWorkspace
export type AiConversation = SynapseAiConversation
export type AiChatMessage = SynapseAiChatMessage
export type AiChatEvent = SynapseAiChatEvent
export type AiTokenUsage = SynapseAiTokenUsage
export type AiRememberScope = SynapseAiRememberScope
export type McpServerConfig = SynapseMcpServerConfig
export type ExecutionWorkspace = SynapseExecutionWorkspace
export type WorkspaceRoot = SynapseWorkspaceRoot
export type McpServerStatus = SynapseMcpServerStatus
export type ToolHealth = SynapseToolHealth
export type ToolResilience = SynapseToolResilience
export type UpdateState = SynapseUpdateState
export type UpdateStatus = SynapseUpdateStatus
export type MemoryEntry = SynapseMemoryEntry
export type MemorySource = SynapseMemorySource
export type MemoryIngestResult = SynapseMemoryIngestResult

export async function getAiStatus(): Promise<AiStatus> {
  return api().getAiStatus()
}

export async function setAiKey(providerId: string, key: string): Promise<void> {
  await api().setAiKey(providerId, key)
}

export async function deleteAiKey(providerId: string): Promise<void> {
  await api().deleteAiKey(providerId)
}

export async function setAiProvider(providerId: string): Promise<void> {
  await api().setAiProvider(providerId)
}

export async function setAiModel(providerId: string, model: string): Promise<void> {
  await api().setAiModel(providerId, model)
}

export async function setAiBudget(tokens: number): Promise<void> {
  await api().setAiBudget(tokens)
}

export async function setAiContextCompression(value: {
  enabled: boolean
  thresholdTokens: number
}): Promise<void> {
  await api().setAiContextCompression(value)
}

export async function setAiToolResilience(value: ToolResilience): Promise<void> {
  await api().setAiToolResilience(value)
}

export async function listAiTools(): Promise<AiTool[]> {
  return api().listAiTools()
}

export async function getAiToolHealth(): Promise<ToolHealth[]> {
  return api().getAiToolHealth()
}

export async function listAiConversations(): Promise<AiConversationSummary[]> {
  return api().listAiConversations()
}

export async function getAiConversation(id: string): Promise<AiConversation | undefined> {
  return api().getAiConversation(id)
}

export async function deleteAiConversation(id: string): Promise<void> {
  await api().deleteAiConversation(id)
}

export async function listAiWorkspaces(options?: {
  includeArchived?: boolean
}): Promise<AiWorkspace[]> {
  return api().listAiWorkspaces(options)
}

export type RunSummary = SynapseRunSummary
export type RunDetail = SynapseRunDetail

export async function listRuns(query?: { parentRunId?: string }): Promise<RunSummary[]> {
  return api().listRuns(query)
}

export async function getRun(runId: string): Promise<RunDetail | undefined> {
  return api().getRun(runId)
}

export async function createAiWorkspace(name: string): Promise<AiWorkspace> {
  return api().createAiWorkspace(name)
}

export async function renameAiWorkspace(id: string, name: string): Promise<AiWorkspace> {
  return api().renameAiWorkspace(id, name)
}

export async function archiveAiWorkspace(id: string): Promise<AiWorkspace> {
  return api().archiveAiWorkspace(id)
}

export async function unarchiveAiWorkspace(id: string): Promise<AiWorkspace> {
  return api().unarchiveAiWorkspace(id)
}

export async function listWorkspaceRoots(workspaceId: string): Promise<WorkspaceRoot[]> {
  return api().listWorkspaceRoots(workspaceId)
}

export async function createWorkspaceRoot(
  workspaceId: string,
  name: string,
  root: string,
  role: "primary" | "additional"
): Promise<WorkspaceRoot> {
  return api().createWorkspaceRoot(workspaceId, name, root, role)
}

export async function removeWorkspaceRoot(id: string): Promise<void> {
  await api().removeWorkspaceRoot(id)
}

export async function setPrimaryWorkspaceRoot(id: string): Promise<void> {
  await api().setPrimaryWorkspaceRoot(id)
}

export async function pickWorkspaceRootDirectory(): Promise<string | null> {
  return api().pickWorkspaceRootDirectory()
}

export async function createAiConversation(
  workspaceId: string
): Promise<{ id: string; workspaceId: string }> {
  return api().createAiConversation(workspaceId)
}

export async function sendAiChat(
  conversationId: string,
  text: string
): Promise<{ stopReason: string; usage: AiTokenUsage }> {
  return api().sendAiChat(conversationId, text)
}

export async function cancelAiChat(conversationId: string): Promise<void> {
  await api().cancelAiChat(conversationId)
}

export async function approveAiTool(
  approvalId: string,
  allow: boolean,
  remember?: AiRememberScope
): Promise<void> {
  await api().approveAiTool(approvalId, allow, remember)
}

export function onAiChatEvent(handler: (event: AiChatEvent) => void): () => void {
  return api().onAiChatEvent(handler)
}

export async function listAiAllowedTools(): Promise<string[]> {
  return api().listAiAllowedTools()
}

export async function revokeAiTool(fqName: string): Promise<void> {
  await api().revokeAiTool(fqName)
}

export async function listAiMcpServers(): Promise<McpServerConfig[]> {
  return api().listAiMcpServers()
}

export async function listExecutionWorkspaces(
  workspaceId = "default"
): Promise<ExecutionWorkspace[]> {
  return api().listExecutionWorkspaces(workspaceId)
}

export async function getAiMcpServerStatus(): Promise<McpServerStatus[]> {
  return api().getAiMcpServerStatus()
}

export async function saveAiMcpServer(config: McpServerConfig): Promise<McpServerStatus[]> {
  return api().saveAiMcpServer(config)
}

export async function deleteAiMcpServer(id: string): Promise<void> {
  await api().deleteAiMcpServer(id)
}

export async function listMemories(): Promise<MemoryEntry[]> {
  return api().listMemories()
}

export async function listMemorySources(): Promise<MemorySource[]> {
  return api().listMemorySources()
}

export async function ingestMemoryDocument(input: {
  source: string
  text: string
}): Promise<MemoryIngestResult> {
  return api().ingestMemoryDocument(input)
}

export async function ingestMemoryDocumentFromPath(input: {
  source: string
  filePath: string
}): Promise<MemoryIngestResult> {
  return api().ingestMemoryDocumentFromPath(input)
}

export async function deleteMemory(id: string): Promise<boolean> {
  return api().deleteMemory(id)
}

export async function deleteMemorySource(source: string): Promise<number> {
  return api().deleteMemorySource(source)
}

export async function getUpdateStatus(): Promise<UpdateState> {
  return api().getUpdateStatus()
}

export async function checkForUpdates(): Promise<void> {
  await api().checkForUpdates()
}

export async function downloadUpdate(): Promise<void> {
  await api().downloadUpdate()
}

export async function installUpdate(): Promise<void> {
  await api().installUpdate()
}

export function onUpdateEvent(handler: (state: UpdateState) => void): () => void {
  return api().onUpdateEvent(handler)
}

export async function setTitleBarDimmed(dimmed: boolean): Promise<void> {
  await api().setTitleBarDimmed(dimmed)
}
