import type { IpcRendererEvent } from "electron"
import { contextBridge, ipcRenderer, webUtils } from "electron"

// Local mirror of the renderer-visible global SynapseUserSettings shape.
// The global declared in index.d.ts is only loaded into the renderer's
// compilation; the preload tsconfig doesn't pick up that .d.ts, so we
// keep a structurally identical type here for type-only use.
interface SettingsPatch {
  hotkey?: string
  themeMode?: "light" | "dark" | "system"
  accent?: "neutral" | "blue" | "green" | "rose" | "violet"
  floatingBallEnabled?: boolean
  floatingBallFeatures?: "appLauncher"[]
  lanEnabled?: boolean
  trustedSourcePolicy?: "official-marketplace" | "any-url" | "local-syn"
  allowAgentShell?: boolean
}
type Settings = Required<SettingsPatch>

const electronAPI = {
  // ---- Launcher ----
  searchApps: (query: string) => ipcRenderer.invoke("launcher:search", query),
  launchApp: (id: string) => ipcRenderer.invoke("launcher:launch", id),
  refreshApps: () => ipcRenderer.invoke("launcher:refresh"),
  getFrequentApps: (limit?: number) => ipcRenderer.invoke("launcher:frequent", limit),
  removeFrequentApp: (id: string) => ipcRenderer.invoke("launcher:remove-frequent", id),
  hideLauncher: () => ipcRenderer.invoke("launcher:hide"),
  openExternalUrl: (url: string) => ipcRenderer.invoke("system:open-external", url),
  writeClipboardContent: (content: unknown) =>
    ipcRenderer.invoke("system:write-clipboard", content),
  notifyLauncherReady: () => ipcRenderer.send("launcher:ready"),
  pauseHotkeyCapture: () => ipcRenderer.invoke("launcher:pause-hotkey"),
  resumeHotkeyCapture: () => ipcRenderer.invoke("launcher:resume-hotkey"),

  // ---- Floating Ball ----
  openFloatingBallFeature: (feature: "appLauncher") =>
    ipcRenderer.invoke("floating-ball:open-feature", feature),
  toggleFloatingBallMenu: () => ipcRenderer.invoke("floating-ball:toggle-menu"),
  moveFloatingBallBy: (delta: { x: number; y: number }) =>
    ipcRenderer.invoke("floating-ball:move-by", delta),
  hideFloatingBall: () => ipcRenderer.invoke("floating-ball:hide"),

  // ---- Settings ----
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke("settings:update", patch),

  // ---- LAN Discovery ----
  getLanStatus: () => ipcRenderer.invoke("lan:status"),
  listLanDevices: () => ipcRenderer.invoke("lan:devices"),
  listLanPairings: () => ipcRenderer.invoke("lan:pairings"),
  pairLanDevice: (deviceId: string) => ipcRenderer.invoke("lan:pair", deviceId),
  confirmLanPairing: (pairingId: string, sas: string) =>
    ipcRenderer.invoke("lan:pairing-confirm", pairingId, sas),
  rejectLanPairing: (pairingId: string) => ipcRenderer.invoke("lan:pairing-reject", pairingId),
  disconnectLanDevice: (deviceId: string) => ipcRenderer.invoke("lan:disconnect", deviceId),
  listLanTransfers: () => ipcRenderer.invoke("lan:transfers"),
  sendLanFile: (deviceId: string) => ipcRenderer.invoke("lan:send-file", deviceId),
  resumeLanTransfer: (transferId: string) => ipcRenderer.invoke("lan:transfer-resume", transferId),
  acceptLanTransfer: (transferId: string) => ipcRenderer.invoke("lan:transfer-accept", transferId),
  rejectLanTransfer: (transferId: string) => ipcRenderer.invoke("lan:transfer-reject", transferId),
  removeLanTransferHistory: (transferId: string) =>
    ipcRenderer.invoke("lan:transfer-history-remove", transferId),

  // ---- Plugins ----
  listPlugins: () => ipcRenderer.invoke("plugin:list"),
  getPlugin: (pluginId: string) => ipcRenderer.invoke("plugin:get", pluginId),
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke("plugin:set-enabled", { pluginId, enabled }),
  listPendingTriggerCapabilities: () =>
    ipcRenderer.invoke("plugin:list-pending-trigger-capabilities"),
  confirmTriggerCapabilities: (pluginId: string, capabilityIds: string[]) =>
    ipcRenderer.invoke("plugin:confirm-trigger-capabilities", { pluginId, capabilityIds }),
  confirmAndEnablePlugin: (pluginId: string, capabilityIds: string[]) =>
    ipcRenderer.invoke("plugin:confirm-and-enable", { pluginId, capabilityIds }),
  setPluginPreference: (pluginId: string, key: string, value: unknown) =>
    ipcRenderer.invoke("plugin:set-preference", { pluginId, key, value }),
  installPluginFolder: (folderPath: string) =>
    ipcRenderer.invoke("plugin:install-folder", folderPath),
  installPluginPackage: (zipPath: string) => ipcRenderer.invoke("plugin:install-package", zipPath),
  importPluginFromFile: () => ipcRenderer.invoke("plugin:import-from-file"),
  // Electron 33 removed File.path; resolve a dropped File's absolute path here.
  getDroppedFilePath: (file: File) => webUtils.getPathForFile(file),
  uninstallPlugin: (pluginId: string) => ipcRenderer.invoke("plugin:uninstall", pluginId),
  reloadPlugin: (pluginId?: string) => ipcRenderer.invoke("plugin:reload", pluginId),
  searchPluginCommands: (query: string, locale?: string, limit?: number) =>
    ipcRenderer.invoke("plugin:search-commands", { query, locale, limit }),
  invokePluginCommand: (
    pluginId: string,
    commandId: string,
    phase: "run" | "onSearchChange" | "onAction",
    payload?: unknown
  ) => ipcRenderer.invoke("plugin:invoke", { pluginId, commandId, phase, payload }),
  disposePluginCommand: (pluginId: string, commandId: string) =>
    ipcRenderer.invoke("plugin:dispose-command", { pluginId, commandId }),
  listPluginCapabilities: (pluginId: string) => ipcRenderer.invoke("capabilities:list", pluginId),
  getCapabilityProfile: (pluginId: string) => ipcRenderer.invoke("capabilities:profile", pluginId),
  previewPluginCapabilityProfile: (manifest: unknown) =>
    ipcRenderer.invoke("capabilities:preview-manifest", manifest),
  revokePluginCapability: (pluginId: string, capability: string) =>
    ipcRenderer.invoke("capabilities:revoke", { pluginId, capability }),
  setExternalMcpPreauthorized: (pluginId: string, capability: string, value: boolean) =>
    ipcRenderer.invoke("capabilities:set-external-mcp-preauthorized", {
      pluginId,
      capability,
      value,
    }),
  getMcpNonReadOnlyExposed: (pluginId: string) =>
    ipcRenderer.invoke("capabilities:get-mcp-exposure", pluginId),
  setMcpNonReadOnlyExposed: (pluginId: string, value: boolean) =>
    ipcRenderer.invoke("capabilities:set-mcp-nonreadonly-exposed", { pluginId, value }),
  resolveCapabilityGrant: (promptId: string, allow: boolean) =>
    ipcRenderer.invoke("capabilities:grant-resolve", { promptId, allow }),
  resolveCapabilityApproval: (promptId: string, allow: boolean) =>
    ipcRenderer.invoke("capabilities:approval-resolve", { promptId, allow }),
  resolveHostResourceApproval: (promptId: string, allow: boolean) =>
    ipcRenderer.invoke("host-resources:approval-resolve", { promptId, allow }),
  listPluginCredentials: (pluginId: string) => ipcRenderer.invoke("credentials:list", pluginId),
  connectPluginCredential: (pluginId: string, credentialId: string) =>
    ipcRenderer.invoke("credentials:connect", { pluginId, credentialId }),
  disconnectPluginCredential: (pluginId: string, credentialId: string) =>
    ipcRenderer.invoke("credentials:disconnect", { pluginId, credentialId }),
  listTriggers: () => ipcRenderer.invoke("triggers:list"),
  pauseTrigger: (pluginId: string, triggerId: string) =>
    ipcRenderer.invoke("triggers:pause", { pluginId, triggerId }),
  resumeTrigger: (pluginId: string, triggerId: string) =>
    ipcRenderer.invoke("triggers:resume", { pluginId, triggerId }),
  killTrigger: (pluginId: string, triggerId: string) =>
    ipcRenderer.invoke("triggers:kill", { pluginId, triggerId }),
  listTriggerInstances: (pluginId: string, triggerId: string) =>
    ipcRenderer.invoke("triggers:list-instances", { pluginId, triggerId }),
  createTriggerInstance: (pluginId: string, triggerId: string, workspaceId: string) =>
    ipcRenderer.invoke("triggers:create-instance", { pluginId, triggerId, workspaceId }),
  reactivateTriggerInstance: (instanceId: string) =>
    ipcRenderer.invoke("triggers:reactivate-instance", { instanceId }),
  pauseTriggerInstance: (instanceId: string) =>
    ipcRenderer.invoke("triggers:pause-instance", { instanceId }),
  resumeTriggerInstance: (instanceId: string) =>
    ipcRenderer.invoke("triggers:resume-instance", { instanceId }),
  removeTriggerInstance: (instanceId: string) =>
    ipcRenderer.invoke("triggers:remove-instance", { instanceId }),
  getTriggerMigrationNotice: () => ipcRenderer.invoke("triggers:migration-notice"),
  dismissTriggerMigrationNotice: () => ipcRenderer.invoke("triggers:dismiss-migration-notice"),
  listMarketplacePlugins: () => ipcRenderer.invoke("marketplace:list"),
  installMarketplacePlugin: (id: string, version?: string) =>
    ipcRenderer.invoke("marketplace:install", { id, version }),
  searchMarketplace: (query?: string) => ipcRenderer.invoke("marketplace:search", query),
  getMarketplaceDetail: (pluginId: string) => ipcRenderer.invoke("marketplace:detail", pluginId),
  installMarketplaceBackendPlugin: (id: string, version: string) =>
    ipcRenderer.invoke("marketplace:backend-install", { id, version }),

  // ---- Marketplace account ----
  getMarketplaceAccount: () => ipcRenderer.invoke("market:status"),
  marketplaceLogin: () => ipcRenderer.invoke("market:login"),
  marketplaceLogout: () => ipcRenderer.invoke("market:logout"),
  rateMarketplacePlugin: (id: string, stars: number) =>
    ipcRenderer.invoke("market:rate", { id, stars }),
  listMyMarketplacePlugins: () => ipcRenderer.invoke("market:my-plugins"),
  setMarketplaceVisibility: (id: string, visibility: "public" | "private") =>
    ipcRenderer.invoke("market:set-visibility", { id, visibility }),
  yankMarketplaceVersion: (id: string, version: string, reason?: string) =>
    ipcRenderer.invoke("market:yank", { id, version, reason }),
  reportMarketplacePlugin: (id: string, reason: string) =>
    ipcRenderer.invoke("market:report", { id, reason }),
  removeMarketplacePlugin: (id: string) => ipcRenderer.invoke("market:remove", { id }),
  restoreMarketplacePlugin: (id: string) => ipcRenderer.invoke("market:restore", { id }),
  listMarketplaceReports: (status?: "open" | "reviewed" | "dismissed") =>
    ipcRenderer.invoke("market:admin-reports", { status }),
  resolveMarketplaceReport: (reportId: string, status: "reviewed" | "dismissed") =>
    ipcRenderer.invoke("market:resolve-report", { reportId, status }),
  onMarketplaceLoginPrompt: (handler: (prompt: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("market:login-prompt", listener)
    return () => ipcRenderer.removeListener("market:login-prompt", listener)
  },
  onCredentialConnectPrompt: (handler: (prompt: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("credentials:connect-prompt", listener)
    return () => ipcRenderer.removeListener("credentials:connect-prompt", listener)
  },

  // ---- AI assistant ----
  getAiStatus: () => ipcRenderer.invoke("ai:status"),
  setAiKey: (providerId: string, key: string) =>
    ipcRenderer.invoke("ai:set-key", { providerId, key }),
  deleteAiKey: (providerId: string) => ipcRenderer.invoke("ai:delete-key", providerId),
  setAiProvider: (providerId: string) => ipcRenderer.invoke("ai:set-provider", providerId),
  setAiModel: (providerId: string, model: string) =>
    ipcRenderer.invoke("ai:set-model", { providerId, model }),
  setAiBudget: (tokens: number) => ipcRenderer.invoke("ai:set-budget", tokens),
  setAiContextCompression: (value: { enabled: boolean; thresholdTokens: number }) =>
    ipcRenderer.invoke("ai:set-context-compression", value),
  setAiToolResilience: (value: unknown) => ipcRenderer.invoke("ai:set-tool-resilience", value),
  listAiTools: () => ipcRenderer.invoke("ai:list-tools"),
  getAiToolHealth: () => ipcRenderer.invoke("ai:tool-health"),
  listAiConversations: () => ipcRenderer.invoke("ai:list-conversations"),
  getAiConversation: (id: string) => ipcRenderer.invoke("ai:get-conversation", id),
  deleteAiConversation: (id: string) => ipcRenderer.invoke("ai:delete-conversation", id),
  listAiWorkspaces: (options?: { includeArchived?: boolean }) =>
    ipcRenderer.invoke("ai:list-workspaces", options),
  createAiWorkspace: (name: string) => ipcRenderer.invoke("ai:create-workspace", { name }),
  renameAiWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke("ai:rename-workspace", { id, name }),
  archiveAiWorkspace: (id: string) => ipcRenderer.invoke("ai:archive-workspace", { id }),
  unarchiveAiWorkspace: (id: string) => ipcRenderer.invoke("ai:unarchive-workspace", { id }),
  listRuns: (query?: { parentRunId?: string }) => ipcRenderer.invoke("runs:list", query),
  getRun: (runId: string) => ipcRenderer.invoke("runs:get", runId),
  getRunSnapshot: (runId: string) => ipcRenderer.invoke("runs:getSnapshot", runId),
  getRunEventsSince: (runId: string, afterSequence: number) =>
    ipcRenderer.invoke("runs:getEventsSince", { runId, afterSequence }),
  listRecoverableRuns: () => ipcRenderer.invoke("runs:listRecoverable"),
  resumeRun: (runId: string, decision?: { kind: "retry" | "mark_failed" }) =>
    ipcRenderer.invoke("runs:resume", { runId, decision }),
  abandonRun: (runId: string) => ipcRenderer.invoke("runs:abandon", runId),
  listWorkspaceRoots: (workspaceId: string) =>
    ipcRenderer.invoke("ai:list-workspace-roots", workspaceId),
  getMcpOnboardingAvailability: (workspaceId: string) =>
    ipcRenderer.invoke("mcp-onboarding:availability", workspaceId),
  generateMcpOnboardingConfig: (workspaceId: string) =>
    ipcRenderer.invoke("mcp-onboarding:generate-config", workspaceId),
  testMcpOnboardingConnection: (workspaceId: string) =>
    ipcRenderer.invoke("mcp-onboarding:test-connection", workspaceId),
  createWorkspaceRoot: (
    workspaceId: string,
    name: string,
    root: string,
    role: "primary" | "additional"
  ) => ipcRenderer.invoke("ai:create-workspace-root", { workspaceId, name, root, role }),
  removeWorkspaceRoot: (id: string) => ipcRenderer.invoke("ai:remove-workspace-root", id),
  setPrimaryWorkspaceRoot: (id: string) => ipcRenderer.invoke("ai:set-primary-workspace-root", id),
  pickWorkspaceRootDirectory: () => ipcRenderer.invoke("ai:pick-workspace-root-directory"),
  createAiConversation: (workspaceId: string) =>
    ipcRenderer.invoke("ai:create-conversation", { workspaceId }),
  sendAiChat: (conversationId: string, text: string) =>
    ipcRenderer.invoke("ai:chat", { conversationId, text }),
  cancelAiChat: (conversationId: string) => ipcRenderer.invoke("ai:cancel", conversationId),
  approveAiTool: (approvalId: string, allow: boolean, remember?: string) =>
    ipcRenderer.invoke("ai:approve", { approvalId, allow, remember }),
  listAiAllowedTools: () => ipcRenderer.invoke("ai:list-allowed-tools"),
  revokeAiTool: (fqName: string) => ipcRenderer.invoke("ai:revoke-tool", fqName),
  listAiMcpServers: () => ipcRenderer.invoke("ai:mcp:list"),
  listExecutionWorkspaces: (workspaceId?: string) =>
    ipcRenderer.invoke("ai:list-execution-workspaces", workspaceId),
  getAiMcpServerStatus: () => ipcRenderer.invoke("ai:mcp:status"),
  saveAiMcpServer: (config: unknown) => ipcRenderer.invoke("ai:mcp:save", config),
  deleteAiMcpServer: (id: string) => ipcRenderer.invoke("ai:mcp:delete", id),
  listMemories: () => ipcRenderer.invoke("ai:memory:list"),
  listMemorySources: () => ipcRenderer.invoke("ai:memory:sources"),
  ingestMemoryDocument: (input: { source: string; text: string }) =>
    ipcRenderer.invoke("ai:memory:ingest", input),
  ingestMemoryDocumentFromPath: (input: { source: string; filePath: string }) =>
    ipcRenderer.invoke("ai:memory:ingest-path", input),
  deleteMemory: (id: string) => ipcRenderer.invoke("ai:memory:delete", id),
  deleteMemorySource: (source: string) => ipcRenderer.invoke("ai:memory:delete-source", source),
  onAiChatEvent: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("ai:chat:event", listener)
    return () => ipcRenderer.removeListener("ai:chat:event", listener)
  },
  getUpdateStatus: () => ipcRenderer.invoke("updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateEvent: (handler: (state: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("updates:event", listener)
    return () => ipcRenderer.removeListener("updates:event", listener)
  },

  setTitleBarDimmed: (dimmed: boolean) => ipcRenderer.invoke("window:set-title-bar-dimmed", dimmed),

  // Subscribe to the "search window just gained focus" pulse so the
  // renderer can reset its input + selection without polling.
  onLauncherFocus: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on("launcher:focus", listener)
    return () => ipcRenderer.removeListener("launcher:focus", listener)
  },

  onFloatingBallMenuState: (handler: (expanded: boolean) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, expanded: boolean): void => handler(expanded)
    ipcRenderer.on("floating-ball:menu-state", listener)
    return () => ipcRenderer.removeListener("floating-ball:menu-state", listener)
  },

  onFloatingBallFeatures: (handler: (features: "appLauncher"[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, features: "appLauncher"[]): void =>
      handler(features)
    ipcRenderer.on("floating-ball:features", listener)
    return () => ipcRenderer.removeListener("floating-ball:features", listener)
  },

  onPluginRegistryChanged: (handler: (plugins: unknown[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, plugins: unknown[]): void => handler(plugins)
    ipcRenderer.on("plugins:registry-changed", listener)
    return () => ipcRenderer.removeListener("plugins:registry-changed", listener)
  },

  onCapabilityGrantRequest: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("capabilities:grant-request", listener)
    return () => ipcRenderer.removeListener("capabilities:grant-request", listener)
  },

  onCapabilityApprovalRequest: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("capabilities:approval-request", listener)
    return () => ipcRenderer.removeListener("capabilities:approval-request", listener)
  },

  onHostResourceApprovalRequest: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("host-resources:approval-request", listener)
    return () => ipcRenderer.removeListener("host-resources:approval-request", listener)
  },

  onApprovalSettled: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on("approvals:settled", listener)
    return () => ipcRenderer.removeListener("approvals:settled", listener)
  },

  // Pushed by main after any settings:update so that windows other than
  // the one that initiated the change (notably the long-lived launcher
  // window) can re-apply theme/hotkey state without a reload.
  onSettingsChanged: (handler: (settings: Settings) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, settings: Settings): void => handler(settings)
    ipcRenderer.on("settings:changed", listener)
    return () => ipcRenderer.removeListener("settings:changed", listener)
  },

  onLanDevicesChanged: (handler: (devices: unknown[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, devices: unknown[]): void => handler(devices)
    ipcRenderer.on("lan:devices-changed", listener)
    return () => ipcRenderer.removeListener("lan:devices-changed", listener)
  },

  onLanStatusChanged: (handler: (status: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, status: unknown): void => handler(status)
    ipcRenderer.on("lan:status-changed", listener)
    return () => ipcRenderer.removeListener("lan:status-changed", listener)
  },

  onLanPairingsChanged: (handler: (pairings: unknown[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, pairings: unknown[]): void => handler(pairings)
    ipcRenderer.on("lan:pairings-changed", listener)
    return () => ipcRenderer.removeListener("lan:pairings-changed", listener)
  },

  onLanTransfersChanged: (handler: (transfers: unknown[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, transfers: unknown[]): void => handler(transfers)
    ipcRenderer.on("lan:transfers-changed", listener)
    return () => ipcRenderer.removeListener("lan:transfers-changed", listener)
  },
} as const

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

export type ElectronAPI = typeof electronAPI
