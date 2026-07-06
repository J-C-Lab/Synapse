// Global typings for the surface exposed by src/preload/index.ts.
// Kept in the preload package so the renderer and the preload always
// agree on the contract.

export {}

declare global {
  type LauncherAppKind = "win32" | "uwp" | "url" | "macos"
  type SynapseFloatingBallFeature = "appLauncher"

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

  type SynapseThemeMode = "light" | "dark" | "system"
  type SynapseThemeAccent = "neutral" | "blue" | "green" | "rose" | "violet"
  type SynapseTrustedSourcePolicy = "official-marketplace" | "any-url" | "local-syn"

  interface SynapseUserSettings {
    hotkey: string
    themeMode: SynapseThemeMode
    accent: SynapseThemeAccent
    floatingBallEnabled: boolean
    floatingBallFeatures: SynapseFloatingBallFeature[]
    lanEnabled: boolean
    trustedSourcePolicy: SynapseTrustedSourcePolicy
    allowAgentShell: boolean
    agentShellRoots: string[]
  }

  type SynapseLanPlatform = "win32" | "darwin" | "linux" | "unknown"
  type SynapseLanDiscoverySource = "bonjour" | "presence" | "trusted-cache"

  interface SynapseLanDevice {
    deviceId: string
    name: string
    host: string
    addresses: string[]
    port: number
    platform: SynapseLanPlatform
    capabilities: string[]
    discoverySource?: SynapseLanDiscoverySource
    lastSeenAt: number
    online: boolean
    paired: boolean
    reachable?: boolean
  }

  interface SynapseLanStatus {
    enabled: boolean
    discovering: boolean
    localDeviceId: string
    localDeviceName: string
    deviceCount: number
  }

  type SynapseLanPairingDirection = "incoming" | "outgoing"
  type SynapseLanPairingState = "awaiting-confirmation" | "confirmed" | "rejected"

  interface SynapseLanPairing {
    id: string
    direction: SynapseLanPairingDirection
    deviceId: string
    deviceName: string
    sas: string
    state: SynapseLanPairingState
    createdAt: number
  }

  type SynapseLanTransferDirection = "incoming" | "outgoing"
  type SynapseLanTransferState =
    | "preparing"
    | "transferring"
    | "paused"
    | "awaiting-confirmation"
    | "completed"
    | "rejected"
    | "failed"

  interface SynapseLanTransfer {
    id: string
    direction: SynapseLanTransferDirection
    deviceId: string
    deviceName: string
    fileName: string
    size: number
    sha256: string
    chunkSize: number
    completedChunks: number
    totalChunks: number
    transferredBytes: number
    state: SynapseLanTransferState
    error?: string
  }

  type SynapseLocalizedString = string | Record<string, string>
  type SynapseClipboardContent =
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
  type SynapsePluginSourceKind = "builtin" | "user" | "dev"
  type SynapsePluginRuntimeStatus = "active" | "disabled" | "invalid" | "crashed" | "shadowed"
  type SynapsePluginCommandMode = "view" | "no-view"
  type SynapsePluginActivationEvent = "clipboard:change"
  type SynapsePluginInvokePhase = "run" | "onSearchChange" | "onAction"
  type SynapsePluginIpcErrorCode =
    | "IPC_FORBIDDEN"
    | "IPC_INVALID_PAYLOAD"
    | "MARKETPLACE_ERROR"
    | "PLUGIN_NOT_FOUND"
    | "PLUGIN_NOT_ACTIVE"
    | "PLUGIN_PERMISSION_DENIED"
    | "PLUGIN_CRASHED"
    | "PLUGIN_INVOCATION_TIMEOUT"
    | "PLUGIN_NOT_IMPLEMENTED"
    | "PLUGIN_INSTALL_ERROR"
    | "PLUGIN_IO_ERROR"
    | "UNKNOWN_ERROR"

  interface SynapsePluginIpcError {
    code: SynapsePluginIpcErrorCode
    message: string
    details?: Record<string, unknown>
  }

  type SynapsePluginIpcResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: SynapsePluginIpcError }

  interface SynapsePluginSource {
    kind: SynapsePluginSourceKind
    priority: number
  }

  interface SynapseManifestCommand {
    id: string
    title: SynapseLocalizedString
    subtitle?: SynapseLocalizedString
    keywords?: string[]
    mode: SynapsePluginCommandMode
    icon?: string
  }

  interface SynapsePluginManifest {
    id: string
    name: string
    displayName: SynapseLocalizedString
    description: SynapseLocalizedString
    version: string
    author: string
    icon?: string
    engines: { synapse: string }
    main: string
    contributes: {
      activationEvents?: SynapsePluginActivationEvent[]
      commands: SynapseManifestCommand[]
      preferences?: Array<{
        id: string
        type: "text" | "number" | "checkbox" | "select"
        label: SynapseLocalizedString
        default?: unknown
        options?: Array<{ value: string; label: SynapseLocalizedString }>
      }>
    }
    permissions: string[]
  }

  interface SynapsePluginRegistryEntry {
    pluginId: string
    rootDir: string
    source: SynapsePluginSource
    status: SynapsePluginRuntimeStatus
    manifest?: SynapsePluginManifest
    preferences?: Record<string, unknown>
    error?: string
    shadowedBy?: SynapsePluginSourceKind
    loadedAt?: number
  }

  interface SynapsePluginCapabilityRow {
    id: string
    tier: "auto" | "consent" | "elevated"
    granted: boolean
    scopeEnforced: boolean
  }

  interface SynapsePluginCredentialRow {
    id: string
    type: "static" | "oauth2-pkce"
    label: Record<string, string> | string
    status: "connected" | "disconnected" | "needs-reconnect"
    injectSummary: string
    pendingConnect: boolean
  }

  interface SynapsePluginTriggerBudgetRow {
    capabilityId: string
    used: number
    max: number
  }

  interface SynapsePluginTriggerRow {
    pluginId: string
    triggerId: string
    type: string
    status: string
    budgets: SynapsePluginTriggerBudgetRow[]
  }

  interface SynapseCapabilityGrantRequestEvent {
    promptId: string
    pluginId: string
    capability: string
    tier: string
    trigger: string
    operation: string
    reason?: string
  }

  interface SynapseCapabilityApprovalRequestEvent {
    promptId: string
    pluginId: string
    capability: string
    actor: string
    trigger: string
    operation: string
    reason?: string
  }

  interface SynapseMarketplaceEntry {
    id: string
    name: string
    displayName: SynapseLocalizedString
    description: SynapseLocalizedString
    author: string
    homepage: string
    version: string
    downloadUrl: string
    sha256: string
    synapseEngine: string
    icon?: string
    categories?: string[]
  }

  interface SynapsePluginCommandResult {
    kind: "plugin-command"
    pluginId: string
    commandId: string
    title: SynapseLocalizedString
    subtitle?: SynapseLocalizedString
    icon?: string
    mode: SynapsePluginCommandMode
    score: number
    matches: number[]
  }

  type SynapsePluginView =
    | { type: "list"; [key: string]: unknown }
    | { type: "detail"; [key: string]: unknown }
    | { type: "form"; [key: string]: unknown }
    | { type: "toast"; [key: string]: unknown }

  interface SynapseAiProviderStatus {
    id: string
    label: string
    hasKey: boolean
    model: string
    models: string[]
  }

  interface SynapseToolResilience {
    failureThreshold: number
    recoveryMs: number
    timeoutMs: number
  }

  interface SynapseAiStatus {
    provider: string
    hasKey: boolean
    model: string
    providers: SynapseAiProviderStatus[]
    budgetTokens: number
    contextCompression: { enabled: boolean; thresholdTokens: number }
    toolResilience: SynapseToolResilience
  }

  interface SynapseAiTool {
    name: string
    description: string
    inputSchema: { type: "object"; [keyword: string]: unknown }
  }

  interface SynapseAiTokenUsage {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  }

  type SynapseAiChatContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }

  interface SynapseAiChatMessage {
    role: "user" | "assistant"
    content: SynapseAiChatContentBlock[]
  }

  interface SynapseAiConversationSummary {
    id: string
    title?: string
    updatedAt: number
  }

  interface SynapseAiConversation {
    id: string
    title?: string
    messages: SynapseAiChatMessage[]
    createdAt: number
    updatedAt: number
  }

  type SynapseAiChatEvent =
    | { type: "text"; conversationId: string; delta: string }
    | { type: "tool_call"; conversationId: string; id: string; name: string; input: unknown }
    | { type: "tool_result"; conversationId: string; id: string; isError: boolean }
    | {
        type: "approval_request"
        conversationId: string
        approvalId: string
        toolName: string
        input: unknown
      }
    | { type: "done"; conversationId: string; stopReason: string; usage: SynapseAiTokenUsage }
    | { type: "error"; conversationId: string; message: string }
    | {
        type: "plan"
        conversationId: string
        runId: string
        steps: Array<{ title: string; status: "pending" | "in_progress" | "completed" }>
      }

  type SynapseAiRememberScope = "once" | "conversation" | "always"

  interface SynapseMemoryEntry {
    id: string
    text: string
    tags: string[]
    createdAt: number
  }

  interface SynapseMemorySource {
    source: string
    count: number
  }

  interface SynapseMemoryIngestResult {
    source: string
    chunks: number
  }

  type SynapseUpdateStatus =
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "not-available"
    | "error"

  interface SynapseUpdateState {
    status: SynapseUpdateStatus
    currentVersion: string
    version?: string
    percent?: number
    error?: string
  }

  interface SynapseMcpServerConfig {
    id: string
    name?: string
    transport?: "stdio" | "http"
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    url?: string
    headers?: Record<string, string>
    enabled?: boolean
  }

  type SynapseMcpConnectionState = "connecting" | "connected" | "disconnected" | "error"

  interface SynapseMcpServerStatus {
    id: string
    name?: string
    enabled: boolean
    state: SynapseMcpConnectionState
    toolCount: number
    error?: string
  }

  type SynapseToolCircuitState = "closed" | "open" | "half_open"

  interface SynapseToolHealth {
    key: string
    state: SynapseToolCircuitState
    total: number
    ok: number
    infraFailures: number
    toolErrors: number
    consecutiveFailures: number
    avgLatencyMs: number
    openedAt?: number
    lastErrorAt?: number
    lastTouchedAt: number
  }

  interface Window {
    electronAPI?: {
      searchApps: (query: string) => Promise<LauncherSearchResult[]>
      launchApp: (id: string) => Promise<boolean>
      refreshApps: () => Promise<LauncherAppEntry[]>
      hideLauncher: () => Promise<void>
      openExternalUrl: (url: string) => Promise<boolean>
      writeClipboardContent: (content: SynapseClipboardContent) => Promise<boolean>
      notifyLauncherReady: () => void
      openFloatingBallFeature: (feature: SynapseFloatingBallFeature) => Promise<void>
      toggleFloatingBallMenu: () => Promise<void>
      moveFloatingBallBy: (delta: { x: number; y: number }) => Promise<void>
      hideFloatingBall: () => Promise<void>
      getSettings: () => Promise<SynapseUserSettings>
      updateSettings: (patch: Partial<SynapseUserSettings>) => Promise<SynapseUserSettings>
      getLanStatus: () => Promise<SynapseLanStatus>
      listLanDevices: () => Promise<SynapseLanDevice[]>
      listLanPairings: () => Promise<SynapseLanPairing[]>
      pairLanDevice: (deviceId: string) => Promise<SynapseLanPairing>
      confirmLanPairing: (pairingId: string, sas: string) => Promise<SynapseLanPairing[]>
      rejectLanPairing: (pairingId: string) => Promise<SynapseLanPairing[]>
      disconnectLanDevice: (deviceId: string) => Promise<void>
      listLanTransfers: () => Promise<SynapseLanTransfer[]>
      sendLanFile: (deviceId: string) => Promise<SynapseLanTransfer | null>
      resumeLanTransfer: (transferId: string) => Promise<SynapseLanTransfer>
      acceptLanTransfer: (transferId: string) => Promise<SynapseLanTransfer | null>
      rejectLanTransfer: (transferId: string) => Promise<SynapseLanTransfer>
      removeLanTransferHistory: (transferId: string) => Promise<SynapseLanTransfer[]>
      listPlugins: () => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry[]>>
      getPlugin: (
        pluginId: string
      ) => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry | null>>
      setPluginEnabled: (
        pluginId: string,
        enabled: boolean
      ) => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry>>
      setPluginPreference: (
        pluginId: string,
        key: string,
        value: unknown
      ) => Promise<SynapsePluginIpcResult<void>>
      installPluginFolder: (
        folderPath: string
      ) => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry>>
      installPluginPackage: (
        zipPath: string
      ) => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry>>
      importPluginFromFile: () => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry | null>>
      getDroppedFilePath: (file: File) => string
      uninstallPlugin: (pluginId: string) => Promise<SynapsePluginIpcResult<void>>
      reloadPlugin: (
        pluginId?: string
      ) => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry | undefined>>
      searchPluginCommands: (
        query: string,
        locale?: string,
        limit?: number
      ) => Promise<SynapsePluginIpcResult<SynapsePluginCommandResult[]>>
      invokePluginCommand: (
        pluginId: string,
        commandId: string,
        phase: SynapsePluginInvokePhase,
        payload?: unknown
      ) => Promise<SynapsePluginIpcResult<SynapsePluginView | void>>
      disposePluginCommand: (
        pluginId: string,
        commandId: string
      ) => Promise<SynapsePluginIpcResult<void>>
      listPluginCapabilities: (
        pluginId: string
      ) => Promise<SynapsePluginIpcResult<SynapsePluginCapabilityRow[]>>
      getCapabilityProfile: (
        pluginId: string
      ) => Promise<
        SynapsePluginIpcResult<import("@synapse/plugin-manifest").PluginCapabilityProfile>
      >
      previewPluginCapabilityProfile: (
        manifest: unknown
      ) => Promise<
        SynapsePluginIpcResult<import("@synapse/plugin-manifest").PluginCapabilityProfile>
      >
      revokePluginCapability: (
        pluginId: string,
        capability: string
      ) => Promise<SynapsePluginIpcResult<void>>
      resolveCapabilityGrant: (
        promptId: string,
        allow: boolean
      ) => Promise<SynapsePluginIpcResult<void>>
      resolveCapabilityApproval: (
        promptId: string,
        allow: boolean
      ) => Promise<SynapsePluginIpcResult<void>>
      listPluginCredentials: (
        pluginId: string
      ) => Promise<SynapsePluginIpcResult<SynapsePluginCredentialRow[]>>
      connectPluginCredential: (
        pluginId: string,
        credentialId: string
      ) => Promise<SynapsePluginIpcResult<void>>
      disconnectPluginCredential: (
        pluginId: string,
        credentialId: string
      ) => Promise<SynapsePluginIpcResult<void>>
      listTriggers: () => Promise<SynapsePluginIpcResult<SynapsePluginTriggerRow[]>>
      pauseTrigger: (pluginId: string, triggerId: string) => Promise<SynapsePluginIpcResult<void>>
      resumeTrigger: (pluginId: string, triggerId: string) => Promise<SynapsePluginIpcResult<void>>
      killTrigger: (pluginId: string, triggerId: string) => Promise<SynapsePluginIpcResult<void>>
      listMarketplacePlugins: () => Promise<SynapsePluginIpcResult<SynapseMarketplaceEntry[]>>
      installMarketplacePlugin: (
        id: string,
        version?: string
      ) => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry>>
      searchMarketplace: (
        query?: string
      ) => Promise<
        SynapsePluginIpcResult<import("@synapse/marketplace-types").SearchPluginsResponse>
      >
      getMarketplaceDetail: (
        pluginId: string
      ) => Promise<
        SynapsePluginIpcResult<import("@synapse/marketplace-types").PluginDetailResponse>
      >
      installMarketplaceBackendPlugin: (
        id: string,
        version: string
      ) => Promise<SynapsePluginIpcResult<SynapsePluginRegistryEntry>>
      getMarketplaceAccount: () => Promise<
        SynapsePluginIpcResult<{ user: import("@synapse/marketplace-types").User | null }>
      >
      marketplaceLogin: () => Promise<
        SynapsePluginIpcResult<import("@synapse/marketplace-types").User>
      >
      marketplaceLogout: () => Promise<SynapsePluginIpcResult<void>>
      rateMarketplacePlugin: (
        id: string,
        stars: number
      ) => Promise<SynapsePluginIpcResult<import("@synapse/marketplace-types").RateResponse>>
      listMyMarketplacePlugins: () => Promise<
        SynapsePluginIpcResult<import("@synapse/marketplace-types").MyPluginsResponse>
      >
      setMarketplaceVisibility: (
        id: string,
        visibility: "public" | "private"
      ) => Promise<
        SynapsePluginIpcResult<import("@synapse/marketplace-types").PluginDetailResponse>
      >
      yankMarketplaceVersion: (
        id: string,
        version: string,
        reason?: string
      ) => Promise<
        SynapsePluginIpcResult<import("@synapse/marketplace-types").PluginDetailResponse>
      >
      reportMarketplacePlugin: (id: string, reason: string) => Promise<SynapsePluginIpcResult<void>>
      removeMarketplacePlugin: (id: string) => Promise<SynapsePluginIpcResult<void>>
      restoreMarketplacePlugin: (id: string) => Promise<SynapsePluginIpcResult<void>>
      listMarketplaceReports: (
        status?: "open" | "reviewed" | "dismissed"
      ) => Promise<
        SynapsePluginIpcResult<import("@synapse/marketplace-types").AdminReportsResponse>
      >
      resolveMarketplaceReport: (
        reportId: string,
        status: "reviewed" | "dismissed"
      ) => Promise<SynapsePluginIpcResult<void>>
      onMarketplaceLoginPrompt: (
        handler: (prompt: { verificationUri: string; userCode: string; expiresAt: string }) => void
      ) => () => void
      onLauncherFocus: (handler: () => void) => () => void
      onFloatingBallMenuState: (handler: (expanded: boolean) => void) => () => void
      onFloatingBallFeatures: (
        handler: (features: SynapseFloatingBallFeature[]) => void
      ) => () => void
      onPluginRegistryChanged: (
        handler: (plugins: SynapsePluginRegistryEntry[]) => void
      ) => () => void
      onCapabilityGrantRequest: (
        handler: (event: SynapseCapabilityGrantRequestEvent) => void
      ) => () => void
      onCapabilityApprovalRequest: (
        handler: (event: SynapseCapabilityApprovalRequestEvent) => void
      ) => () => void
      onSettingsChanged: (handler: (settings: SynapseUserSettings) => void) => () => void
      onLanDevicesChanged: (handler: (devices: SynapseLanDevice[]) => void) => () => void
      onLanStatusChanged: (handler: (status: SynapseLanStatus) => void) => () => void
      onLanPairingsChanged: (handler: (pairings: SynapseLanPairing[]) => void) => () => void
      onLanTransfersChanged: (handler: (transfers: SynapseLanTransfer[]) => void) => () => void
      getAiStatus: () => Promise<SynapseAiStatus>
      setAiKey: (providerId: string, key: string) => Promise<void>
      deleteAiKey: (providerId: string) => Promise<void>
      setAiProvider: (providerId: string) => Promise<void>
      setAiModel: (providerId: string, model: string) => Promise<void>
      setAiBudget: (tokens: number) => Promise<void>
      setAiContextCompression: (value: {
        enabled: boolean
        thresholdTokens: number
      }) => Promise<void>
      setAiToolResilience: (value: SynapseToolResilience) => Promise<void>
      listAiTools: () => Promise<SynapseAiTool[]>
      getAiToolHealth: () => Promise<SynapseToolHealth[]>
      listAiConversations: () => Promise<SynapseAiConversationSummary[]>
      getAiConversation: (id: string) => Promise<SynapseAiConversation | undefined>
      deleteAiConversation: (id: string) => Promise<void>
      sendAiChat: (
        conversationId: string,
        text: string
      ) => Promise<{ stopReason: string; usage: SynapseAiTokenUsage }>
      cancelAiChat: (conversationId: string) => Promise<void>
      approveAiTool: (
        approvalId: string,
        allow: boolean,
        remember?: SynapseAiRememberScope
      ) => Promise<void>
      listAiAllowedTools: () => Promise<string[]>
      revokeAiTool: (fqName: string) => Promise<void>
      listAiMcpServers: () => Promise<SynapseMcpServerConfig[]>
      getAiMcpServerStatus: () => Promise<SynapseMcpServerStatus[]>
      saveAiMcpServer: (config: SynapseMcpServerConfig) => Promise<SynapseMcpServerStatus[]>
      deleteAiMcpServer: (id: string) => Promise<void>
      listMemories: () => Promise<SynapseMemoryEntry[]>
      listMemorySources: () => Promise<SynapseMemorySource[]>
      ingestMemoryDocument: (input: {
        source: string
        text: string
      }) => Promise<SynapseMemoryIngestResult>
      deleteMemory: (id: string) => Promise<boolean>
      deleteMemorySource: (source: string) => Promise<number>
      onAiChatEvent: (handler: (event: SynapseAiChatEvent) => void) => () => void
      getUpdateStatus: () => Promise<SynapseUpdateState>
      checkForUpdates: () => Promise<void>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      onUpdateEvent: (handler: (state: SynapseUpdateState) => void) => () => void
    }
  }
}
