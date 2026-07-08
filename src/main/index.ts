import type { ClipboardContent } from "@synapse/plugin-sdk"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import type { ToolResilienceSettings } from "./ai/ai-settings-store"
import type { WorkspaceRoot } from "./ai/execution/types"
import type { ChatProvider } from "./ai/providers/types"
import type { RunTrace } from "./ai/run-trace-store"
import type { SecretProtector } from "./lan/credential-store"
import type { LanDevice, LanPairing, LanStatus, LanTransfer } from "./lan/types"
import type { SearchWindowDeps } from "./search-window"
import type { AutoUpdaterPort } from "./updates/update-service"
import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { derivePluginProfile, profileToAgentText } from "@synapse/plugin-manifest"
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron"
import electronUpdater from "electron-updater"
import { AgentService } from "./ai/agent-service"
import {
  aiSettingsFilePath,
  AiSettingsStore,
  DEFAULT_TOOL_RESILIENCE,
} from "./ai/ai-settings-store"
import { aiApprovalsFilePath, ApprovalStore } from "./ai/approval-store"
import { asFallbackSource, CompositeToolHost } from "./ai/composite-tool-host"
import { ConversationStore } from "./ai/conversation-store"
import { aiCredentialFilePath, AiCredentialStore } from "./ai/credential-store"
import { ExecutionApprovalResolver } from "./ai/execution/execution-approval"
import { executionLogFilePath, ExecutionLogStore } from "./ai/execution/execution-log-store"
import { EXECUTION_FQ_PREFIX, ExecutionToolHostSource } from "./ai/execution/execution-tool-host"
import { createMcpClient } from "./ai/mcp-client-factory"
import { MCP_FQ_PREFIX, McpClientManager } from "./ai/mcp-client-manager"
import { aiMcpServersFilePath, McpServerConfigStore } from "./ai/mcp-server-config-store"
import { MemoryService } from "./ai/memory/memory-service"
import { aiMemoryFilePath, MemoryStore } from "./ai/memory/memory-store"
import { MEMORY_FQ_PREFIX, MemoryToolSource } from "./ai/memory/memory-tools"
import { OpenAiEmbeddingProvider } from "./ai/memory/openai-embedding-provider"
import { PLAN_FQ_PREFIX, PlanToolSource } from "./ai/plan/plan-tool-source"
import { RunPlanRegistry } from "./ai/plan/run-plan-registry"
import {
  PLUGIN_INTROSPECT_PREFIX,
  PluginIntrospectionToolSource,
} from "./ai/plugin-introspection-tools"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "./ai/providers/catalog"
import { ResilientToolHost } from "./ai/resilient-tool-host"
import { RunBudgetRegistry } from "./ai/run-budget-registry"
import { getLatestPlan, recordRun as persistRunTrace } from "./ai/run-trace-store"
import { SubagentRunner } from "./ai/subagent/subagent-runner"
import { SpawnSubagentToolSource, SUBAGENT_FQ_PREFIX } from "./ai/subagent/subagent-tool-source"
import { AiToolRegistry } from "./ai/tool-registry"
import { WorkspaceStore } from "./ai/workspace/workspace-store"
import { ensureDevAppUserModelShortcut } from "./dev-app-shortcut"
import {
  destroyFloatingBallWindow,
  hideFloatingBallWindow,
  moveFloatingBallBy,
  openFloatingBallFeature,
  syncFloatingBallWindow,
  toggleFloatingBallMenu,
} from "./floating-ball-window"
import { registerAiIpc } from "./ipc/ai"
import { CapabilityIpcService, registerCapabilitiesIpc } from "./ipc/capabilities"
import { attachCapabilityPromptLifecycle } from "./ipc/capability-prompt-lifecycle"
import { createCapabilityPromptSender } from "./ipc/capability-prompt-router"
import { registerCredentialsIpc } from "./ipc/credentials"
import { registerLanIpc } from "./ipc/lan"
import { LauncherService } from "./ipc/launcher-service"
import { registerMarketplaceIpc } from "./ipc/marketplace"
import { registerMemoryIpc } from "./ipc/memory"
import { registerPluginIpc } from "./ipc/plugins"
import { registerTriggersIpc, TriggerIpcService } from "./ipc/triggers"
import { registerUpdatesIpc } from "./ipc/updates"
import { BonjourLanDiscoveryAdapter } from "./lan/bonjour-discovery-adapter"
import { LanCredentialLoadError } from "./lan/credential-store"
import {
  LAN_SIMULATION_PROFILE_ENV,
  resetDevLanSimulationCredentials,
  resolveDevLanSimulation,
} from "./lan/dev-simulation"
import { LanService } from "./lan/lan-service"
import { configureRootLogger, logger } from "./logging"
import { createFileSink } from "./logging/file-sink"
import { MarketplaceAccountService } from "./marketplace/account-service"
import { marketplaceTokenFilePath, MarketplaceTokenStore } from "./marketplace/token-store"
import { defaultNotificationIcon, showStartupNotification } from "./notifications"
import { createCapabilityAudit } from "./plugins/capability-audit"
import { createElectronSecretPrompt, CredentialBroker } from "./plugins/credential-broker"
import { GrantStore, grantStoreFilePath } from "./plugins/grant-store"
import { createMarketplaceApi } from "./plugins/marketplace-api"
import { PluginHost } from "./plugins/plugin-host"
import { getContentType, resolveStaticPath } from "./protocol/resolve-static-path"
import {
  consumeSearchWindowTrayOpenSuppression,
  ensureSearchWindow,
  hideSearchWindow,
  markSearchWindowReady,
  setSearchWindowQuitting,
  showSearchWindow,
  toggleSearchWindow,
} from "./search-window"
import {
  bindGlobalShortcut,
  resumeGlobalShortcut,
  suspendGlobalShortcut,
  unbindGlobalShortcut,
} from "./shortcut"
import { createTray, defaultTrayIcon, destroyTray, refreshTrayMenu } from "./tray"
import { shouldAutoCheckOnStartup, UpdateService } from "./updates/update-service"
import { attachWindowSecurity, isSameOrigin } from "./window-security"

const isDev = !app.isPackaged
const lanSimulation = resolveDevLanSimulation({
  defaultUserDataDir: app.getPath("userData"),
  isPackaged: app.isPackaged,
  profile: process.env[LAN_SIMULATION_PROFILE_ENV],
})
if (lanSimulation) {
  app.setPath("userData", lanSimulation.userDataDir)
}
configureRootLogger({ userDataDir: app.getPath("userData") })
if (lanSimulation) {
  logger.child("synapse").warn("using LAN simulation profile", {
    profile: lanSimulation.profile,
    userDataDir: lanSimulation.userDataDir,
  })
}
// electron-vite injects this in dev (Vite dev server URL). Undefined in prod.
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const isMcpStdioMode = process.argv.includes("--mcp-stdio")

// Custom scheme used for the production renderer. Loading the renderer at
// `app://app/index.html` makes absolute asset paths (`/assets/...`) resolve
// to `app://app/assets/...`, which the handler maps to files under
// `out/renderer/`. Loading via `file://` would make the same paths resolve
// to the filesystem root and 404 every asset.
const APP_SCHEME = "app"
const APP_ORIGIN = `${APP_SCHEME}://app`

// Must be called *before* app is ready. Marking the scheme `standard` and
// `secure` makes its origin behave like https for CORS, cookies, and CSP.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

// Marketplace user avatars are served by GitHub (avatars + camo redirects).
// Allowlist GitHub's image hosts in img-src rather than opening it to all https.
const AVATAR_IMG_SRC = "https://*.githubusercontent.com"

const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  `img-src 'self' data: blob: ${AVATAR_IMG_SRC}; font-src 'self' data:; connect-src 'self'; ` +
  "object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'"

function devCsp(devOrigin: string): string {
  const ws = devOrigin.replace(/^http/, "ws")
  return (
    `default-src 'self' ${devOrigin} ${ws}; ` +
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}; ` +
    `style-src 'self' 'unsafe-inline' ${devOrigin}; ` +
    `img-src 'self' data: blob: ${AVATAR_IMG_SRC} ${devOrigin}; ` +
    `font-src 'self' data: ${devOrigin}; ` +
    `connect-src 'self' ${devOrigin} ${ws}`
  )
}

function applyCsp(): void {
  const csp = isDev && rendererDevUrl ? devCsp(rendererDevUrl) : PROD_CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    })
  })
}

function registerStaticProtocol(): void {
  // electron-vite emits the renderer bundle to out/renderer/, which sits
  // next to out/main/index.js after build.
  const root = path.join(__dirname, "../renderer")

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const resolved = resolveStaticPath(url.pathname, root)

    if (resolved.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 })
    }

    // `net.fetch` reads the file (transparently handling asar) and returns a
    // Response with proper streaming. We override Content-Type because some
    // extensions (`.woff2`, `.wasm`) are not always inferred correctly.
    const fileUrl = pathToFileURL(resolved.filePath).toString()
    const response = await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true })
    if (!response.ok) {
      return response
    }
    const headers = new Headers(response.headers)
    headers.set("content-type", getContentType(resolved.filePath))
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}

const launcher = new LauncherService()
let plugins: PluginHost
let capabilityService!: CapabilityIpcService
let lan: LanService
let agent: AgentService
let runTraceRecorder: (trace: RunTrace) => void = () => {}
let emitPlanForRun: (
  runId: string,
  steps: import("./ai/plan/plan-types").PlanStep[]
) => void = () => {}
let makeSubagentProvider: () => Promise<{ provider: ChatProvider; model: string }> = async () => {
  throw new Error("subagent provider not wired")
}
const runBudgetRegistry = new RunBudgetRegistry()
let accountService: MarketplaceAccountService
let marketplaceTokens: MarketplaceTokenStore | undefined
// External MCP servers feeding tools to the built-in agent (P5). Held at module
// scope so shutdown can disconnect the child processes.
let mcpClients: McpClientManager | null = null
// Long-term memory service, held at module scope so the memory IPC can reach the
// same instance the agent's memory tools use.
let memoryService: MemoryService | null = null
let mainWindow: BrowserWindow | null = null
// Auto-update orchestration (electron-updater). Constructed during IPC setup.
let updateService: UpdateService | null = null
// A `.syn` path from an OS "open with" before the plugin host finished
// initializing — replayed once init completes. Also guards against handling
// the same import twice concurrently.
let pendingSynapseImport: string | null = null
let synapseImportInFlight = false
// Tracks whether quit was explicitly requested through the tray menu, so
// the main-window close handler can distinguish "user clicked X" (hide)
// from "user picked Quit" (let the close go through).
let quitRequested = false
const capabilityPromptLifecycleBound = new WeakSet<WebContents>()

function bindCapabilityPromptLifecycle(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const { webContents } = win
  if (capabilityPromptLifecycleBound.has(webContents)) return
  capabilityPromptLifecycleBound.add(webContents)
  attachCapabilityPromptLifecycle(webContents, () => capabilityService?.dispose())
}

function registerIpc(): void {
  ipcMain.handle("launcher:search", (_event, query: unknown) => {
    return launcher.search(typeof query === "string" ? query : "")
  })

  ipcMain.handle("launcher:launch", async (_event, id: unknown) => {
    if (typeof id !== "string") return false
    const ok = await launcher.launchById(id)
    if (ok) hideSearchWindow()
    return ok
  })

  ipcMain.handle("launcher:refresh", () => launcher.refreshApps())

  ipcMain.handle("launcher:pause-hotkey", () => {
    suspendGlobalShortcut()
  })

  ipcMain.handle("launcher:resume-hotkey", () => {
    return resumeGlobalShortcut(() => toggleSearchWindow(searchWindowDeps()))
  })

  ipcMain.handle("launcher:hide", () => {
    hideSearchWindow()
  })

  ipcMain.handle("system:open-external", async (event, url: unknown) => {
    if (!isTrustedIpcSender(event) || typeof url !== "string") return false
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return false
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return false
    await shell.openExternal(target.toString())
    return true
  })

  ipcMain.handle("system:write-clipboard", async (event, content: unknown) => {
    if (!isTrustedIpcSender(event) || !isClipboardContent(content)) return false
    writeClipboardContent(content)
    return true
  })

  ipcMain.on("launcher:ready", (event) => {
    markSearchWindowReady(event.sender)
  })

  ipcMain.handle("floating-ball:toggle-menu", () => {
    toggleFloatingBallMenu()
  })

  ipcMain.handle("floating-ball:open-feature", (_event, feature: unknown) => {
    if (feature === "appLauncher") {
      openFloatingBallFeature(feature)
    }
  })

  ipcMain.handle("floating-ball:hide", async () => {
    await disableFloatingBall()
  })

  ipcMain.handle("floating-ball:move-by", (_event, delta: unknown) => {
    if (!delta || typeof delta !== "object") return
    const value = delta as Record<string, unknown>
    if (typeof value.x !== "number" || typeof value.y !== "number") return
    moveFloatingBallBy({ x: value.x, y: value.y })
  })

  ipcMain.handle("settings:get", () => launcher.getSettings())

  ipcMain.handle("settings:update", async (_event, patch: unknown) => {
    const previous = launcher.getSettings()
    let next = await launcher.updateSettings(coercePatch(patch))

    if (next.hotkey !== previous.hotkey && !rebindHotkey(next.hotkey)) {
      next = await launcher.updateSettings({ hotkey: previous.hotkey })
    }
    if (next.lanEnabled !== previous.lanEnabled) {
      next = await syncLanEnabled(next, previous)
    }

    refreshTrayMenu(trayActions())
    syncFloatingBallWindow(floatingBallDeps())
    broadcastSettingsChanged(next)
    if (next.themeMode !== previous.themeMode && mainWindow) {
      applyTitleBarScheme(mainWindow, next.themeMode)
    }
    return next
  })

  registerPluginIpc(ipcMain, plugins, {
    isTrustedSender: isTrustedIpcSender,
    onRegistryChanged: broadcastPluginRegistryChanged,
    pickPackageFile: pickSynapsePackageFile,
  })
  registerCapabilitiesIpc(ipcMain, capabilityService, {
    isTrustedSender: isTrustedIpcSender,
  })
  registerCredentialsIpc(ipcMain, () => plugins, {
    isTrustedSender: isTrustedIpcSender,
  })
  registerTriggersIpc(ipcMain, new TriggerIpcService(() => plugins), {
    isTrustedSender: isTrustedIpcSender,
  })
  registerAiIpc(ipcMain, agent, { isTrustedSender: isTrustedIpcSender })
  if (memoryService)
    registerMemoryIpc(ipcMain, memoryService, { isTrustedSender: isTrustedIpcSender })
  updateService = setupAutoUpdates()
  registerUpdatesIpc(ipcMain, updateService, { isTrustedSender: isTrustedIpcSender })
  registerMarketplaceIpc(ipcMain, accountService, plugins, {
    isTrustedSender: isTrustedIpcSender,
    onLoginPrompt: broadcastMarketLoginPrompt,
  })
  registerLanIpc(ipcMain, lan, {
    isTrustedSender: isTrustedIpcSender,
    onDevicesChanged: broadcastLanDevicesChanged,
    onStatusChanged: broadcastLanStatusChanged,
    onPairingsChanged: broadcastLanPairingsChanged,
    onTransfersChanged: broadcastLanTransfersChanged,
    selectSendFile: async () => {
      const result = await dialog.showOpenDialog({ properties: ["openFile"] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    selectSaveFile: async (suggestedName) => {
      const result = await dialog.showSaveDialog({ defaultPath: suggestedName })
      return result.canceled ? null : (result.filePath ?? null)
    },
  })
}

// Open a native picker filtered to `.syn` packages. Returns the chosen
// absolute path, or null when the user cancels.
async function pickSynapsePackageFile(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Import Synapse Plugin",
    properties: ["openFile"],
    filters: [{ name: "Synapse Plugin", extensions: ["syn"] }],
  }
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

// First `.syn` path found in a process argv list (OS "open with" passes the
// file as a launch argument on Windows/Linux). Ignores Electron's own flags.
function findSynapseArg(argv: string[]): string | null {
  return argv.find((arg) => !arg.startsWith("-") && arg.toLowerCase().endsWith(".syn")) ?? null
}

// Install a `.syn` opened from the OS (file association / drag-to-icon).
// Confirms first, then installs through the host and surfaces the result.
async function importSynapseFromOs(filePath: string): Promise<void> {
  if (!plugins) {
    pendingSynapseImport = filePath
    return
  }
  if (synapseImportInFlight) return
  synapseImportInFlight = true
  try {
    showMainWindow()
    const confirm = await dialog.showMessageBox({
      type: "question",
      buttons: ["Install", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "Install this Synapse plugin?",
      detail: filePath,
    })
    if (confirm.response !== 0) return
    const entry = await plugins.installPackage(filePath)
    await dialog.showMessageBox({
      type: "info",
      message: "Plugin installed",
      detail: entry.manifest?.name ?? entry.pluginId,
    })
  } catch (err) {
    dialog.showErrorBox("Plugin import failed", err instanceof Error ? err.message : String(err))
  } finally {
    synapseImportInFlight = false
  }
}

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url || event.sender.getURL()
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }

  // The production renderer is served from the custom `app://app` scheme;
  // isSameOrigin handles that scheme's "null" origin (see window-security).
  if (isSameOrigin(target, APP_ORIGIN)) return true
  if (rendererDevUrl && isSameOrigin(target, new URL(rendererDevUrl).origin)) return true
  return false
}

function isClipboardContent(value: unknown): value is ClipboardContent {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  if (record.type === "text") return typeof record.text === "string"
  if (record.type === "image") {
    return typeof record.dataUrl === "string" && typeof record.mimeType === "string"
  }
  if (record.type === "file") {
    return Array.isArray(record.paths) && record.paths.every((item) => typeof item === "string")
  }
  return false
}

function writeClipboardContent(content: ClipboardContent): void {
  if (content.type === "text") {
    clipboard.writeText(content.text)
    return
  }
  if (content.type === "image") {
    clipboard.writeImage(nativeImage.createFromDataURL(content.dataUrl))
    return
  }
  clipboard.writeText(content.paths.join("\n"))
}

function broadcastPluginRegistryChanged(entries: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("plugins:registry-changed", entries)
    }
  }
}

function broadcastSettingsChanged(settings: ReturnType<typeof launcher.getSettings>): void {
  // Notify every renderer (main shell + long-lived launcher window) so
  // they can re-apply theme/hotkey state without reloading. Skip
  // destroyed windows defensively to avoid sending to torn-down webContents.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("settings:changed", settings)
    }
  }
}

function broadcastLanDevicesChanged(devices: LanDevice[]): void {
  broadcast("lan:devices-changed", devices)
}

function broadcastLanStatusChanged(status: LanStatus): void {
  broadcast("lan:status-changed", status)
}

function broadcastLanPairingsChanged(pairings: LanPairing[]): void {
  broadcast("lan:pairings-changed", pairings)
}

function broadcastLanTransfersChanged(transfers: LanTransfer[]): void {
  broadcast("lan:transfers-changed", transfers)
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

function broadcastAiChatEvent(event: unknown): void {
  broadcast("ai:chat:event", event)
}

// Build the auto-update service around electron-updater's singleton. Manual
// flow: we surface "available"/"downloaded" to the renderer and only download
// or restart on the user's request. State changes stream on `updates:event`.
function setupAutoUpdates(): UpdateService {
  const { autoUpdater } = electronUpdater
  autoUpdater.autoInstallOnAppQuit = true
  return new UpdateService({
    updater: autoUpdater as unknown as AutoUpdaterPort,
    currentVersion: app.getVersion(),
    onChange: (state) => broadcast("updates:event", state),
  })
}

function broadcastMarketLoginPrompt(prompt: unknown): void {
  broadcast("market:login-prompt", prompt)
}

function marketplaceTokenStore(): MarketplaceTokenStore {
  marketplaceTokens ??= new MarketplaceTokenStore({
    filePath: marketplaceTokenFilePath(app.getPath("userData")),
    protector: osSecretProtector(),
  })
  return marketplaceTokens
}

function createMarketplaceAccountService(): MarketplaceAccountService {
  const api = createMarketplaceApi({
    fetch: (url, init) => net.fetch(url, init),
    getToken: () => marketplaceTokenStore().get(),
  })
  return new MarketplaceAccountService({
    api,
    store: marketplaceTokenStore(),
    openBrowser: (url) => {
      void shell.openExternal(url)
    },
  })
}

function osSecretProtector(): SecretProtector {
  return {
    encrypt: (plainText) => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("OS-backed encryption is unavailable.")
      }
      return safeStorage.encryptString(plainText).toString("base64")
    },
    decrypt: (encryptedText) => safeStorage.decryptString(Buffer.from(encryptedText, "base64")),
  }
}

function coercePatch(value: unknown): Partial<{
  hotkey: string
  themeMode: "light" | "dark" | "system"
  accent: "neutral" | "blue" | "green" | "rose" | "violet"
  floatingBallEnabled: boolean
  floatingBallFeatures: "appLauncher"[]
  lanEnabled: boolean
  trustedSourcePolicy: "official-marketplace" | "any-url" | "local-syn"
  allowAgentShell?: boolean
  agentShellRoots?: string[]
}> {
  if (!value || typeof value !== "object") return {}
  const v = value as Record<string, unknown>
  const out: ReturnType<typeof coercePatch> = {}
  if (typeof v.hotkey === "string") out.hotkey = v.hotkey
  if (v.themeMode === "light" || v.themeMode === "dark" || v.themeMode === "system") {
    out.themeMode = v.themeMode
  }
  if (
    v.accent === "neutral" ||
    v.accent === "blue" ||
    v.accent === "green" ||
    v.accent === "rose" ||
    v.accent === "violet"
  ) {
    out.accent = v.accent
  }
  if (typeof v.floatingBallEnabled === "boolean") out.floatingBallEnabled = v.floatingBallEnabled
  if (Array.isArray(v.floatingBallFeatures)) {
    out.floatingBallFeatures = v.floatingBallFeatures.filter(
      (feature): feature is "appLauncher" => feature === "appLauncher"
    )
  }
  if (typeof v.lanEnabled === "boolean") out.lanEnabled = v.lanEnabled
  if (
    v.trustedSourcePolicy === "official-marketplace" ||
    v.trustedSourcePolicy === "any-url" ||
    v.trustedSourcePolicy === "local-syn"
  ) {
    out.trustedSourcePolicy = v.trustedSourcePolicy
  }
  if (typeof v.allowAgentShell === "boolean") out.allowAgentShell = v.allowAgentShell
  if (Array.isArray(v.agentShellRoots)) {
    out.agentShellRoots = v.agentShellRoots.filter((p): p is string => typeof p === "string")
  }
  return out
}

async function syncLanEnabled(
  next: ReturnType<typeof launcher.getSettings>,
  previous: ReturnType<typeof launcher.getSettings>
): Promise<ReturnType<typeof launcher.getSettings>> {
  try {
    if (next.lanEnabled) {
      await lan.start()
    } else {
      await lan.stop()
    }
    return next
  } catch (err) {
    logger.child("synapse").error("failed to update LAN discovery state", { err })
    return launcher.updateSettings({ lanEnabled: previous.lanEnabled })
  }
}

function searchWindowDeps(): SearchWindowDeps {
  return { rendererDevUrl, appOrigin: APP_ORIGIN }
}

function broadcastCredentialConnectPrompt(prompt: unknown): void {
  broadcast("credentials:connect-prompt", prompt)
}

function initPluginHost(): PluginHost {
  const userDataDir = app.getPath("userData")
  const grants = new GrantStore(grantStoreFilePath(userDataDir))
  const audit = createCapabilityAudit(
    createFileSink(path.join(userDataDir, "logs"), { fileName: "audit.log" })
  )

  capabilityService = new CapabilityIpcService(
    () => plugins,
    createCapabilityPromptSender(broadcast)
  )

  return new PluginHost({
    fetch: (url, init) => net.fetch(url, init),
    marketplaceGetToken: () => marketplaceTokenStore().get(),
    userDataDir,
    resourcesDir: pluginResourcesDir(),
    runtime: () => {
      const settings = launcher.getSettings()
      return {
        locale: app.getLocale(),
        theme: {
          mode: settings.themeMode === "dark" ? "dark" : "light",
          accent: settings.accent,
        },
      }
    },
    capabilityGovernance: {
      userDataDir,
      grants,
      audit,
      prompt: capabilityService.grantPrompt,
      approve: capabilityService.capabilityApprover,
    },
    backgroundAgentProvider: () => agent.createBackgroundAgentProvider(),
    recordRun: (trace) => runTraceRecorder(trace),
    runBudgetRegistry,
    reservedAccelerators: () => [launcher.getSettings().hotkey],
    credentialBroker: new CredentialBroker({
      userDataDir,
      safeStorage: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plainText) => safeStorage.encryptString(plainText),
        decryptString: (encrypted) => safeStorage.decryptString(encrypted),
      },
      secretPrompt: createElectronSecretPrompt(
        () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
        BrowserWindow
      ),
      audit,
      grants,
      onOAuthConnectPrompt: (prompt) => broadcastCredentialConnectPrompt(prompt),
      openBrowser: async (url) => {
        await shell.openExternal(url)
      },
    }),
  })
}

function pluginResourcesDir(): string {
  return path.join(app.getAppPath(), "resources")
}

function createAgentService(): AgentService {
  const userDataDir = app.getPath("userData")
  const credentials = new AiCredentialStore({
    filePath: aiCredentialFilePath(userDataDir),
    protector: osSecretProtector(),
  })
  const manager = new McpClientManager(createMcpClient)
  mcpClients = manager

  // Built-in long-term memory: embeds with the user's OpenAI key (falls back to
  // lexical recall when none is set).
  const memory = new MemoryService(
    new MemoryStore(aiMemoryFilePath(userDataDir)),
    new OpenAiEmbeddingProvider({ getApiKey: () => credentials.get("openai") })
  )
  memoryService = memory

  const pluginNote = (pluginId: string): string | undefined => {
    const entry = plugins.get(pluginId)
    return entry?.manifest
      ? profileToAgentText(derivePluginProfile({ manifest: entry.manifest }))
      : undefined
  }

  const introspectionSource = new PluginIntrospectionToolSource((pluginId) =>
    capabilityService.getCapabilityProfile(pluginId).then(
      (profile) => profile,
      () => undefined
    )
  )

  function effectiveShellRoots(): string[] {
    const roots = launcher.getSettings().agentShellRoots
    return roots.length > 0 ? roots : [os.homedir()]
  }

  // Local execution is authorized via the same settings as the legacy shell:
  // `allowAgentShell` is the master switch and `agentShellRoots` are the
  // sandbox roots, each surfaced to the agent as a named execution workspace.
  function executionWorkspaces(): WorkspaceRoot[] {
    if (!launcher.getSettings().allowAgentShell) return []
    return deriveExecutionWorkspaces(effectiveShellRoots())
  }

  const executionLog = new ExecutionLogStore(executionLogFilePath(userDataDir))
  const executionSource = new ExecutionToolHostSource({
    workspaces: { listWorkspaces: executionWorkspaces },
    log: executionLog,
  })
  const executionApprovalResolver = new ExecutionApprovalResolver({ log: executionLog })

  const runsDir = path.join(userDataDir, "logs", "runs")
  const recordRun = (trace: RunTrace): void => persistRunTrace(runsDir, trace)
  runTraceRecorder = recordRun

  const planRegistry = new RunPlanRegistry()
  const planSource = new PlanToolSource({
    registry: planRegistry,
    emitPlan: (runId, steps) => emitPlanForRun(runId, steps),
  })

  let agentTools!: AiToolRegistry
  const subagentSource = new SpawnSubagentToolSource({
    parentTools: () => agentTools,
    budgetTokens: (runId) => runBudgetRegistry.get(runId),
    runSubagent: async (inp) => {
      const { provider, model } = await makeSubagentProvider()
      return new SubagentRunner({ provider, model, recordRun }).run(inp)
    },
  })

  // The model sees one flat tool list: local plugin tools, external MCP tools
  // (`mcp:<id>/<tool>`), built-in memory tools (`memory:…`), and optionally
  // sandboxed local execution (`execution:…`). Invocations route by ownership.
  const aiSettings = new AiSettingsStore(aiSettingsFilePath(userDataDir), DEFAULT_PROVIDER_ID)
  // Live circuit-breaker tuning (P3). Held in a mutable holder the host reads
  // afresh per new breaker; setToolResilience updates it and resets breakers so
  // the change takes effect immediately. Seeded from persisted settings below.
  let toolResilience: ToolResilienceSettings = { ...DEFAULT_TOOL_RESILIENCE }

  // Wrap the flat tool surface in a per-tool circuit breaker + timeout so one
  // hung/dead source (crashed MCP server, wedged plugin) can't stall or keep
  // punching the agent loop. Execution and subagent tools are legitimately
  // long-running, so they opt out of the timeout; everything else uses the
  // configured timeout. Held in a variable so its health snapshots can be
  // surfaced to the renderer.
  const resilientToolHost = new ResilientToolHost(
    new CompositeToolHost([
      introspectionSource,
      executionSource,
      planSource,
      subagentSource,
      asFallbackSource(
        plugins,
        (fqName) =>
          fqName.startsWith(MCP_FQ_PREFIX) ||
          fqName.startsWith(MEMORY_FQ_PREFIX) ||
          fqName.startsWith(PLUGIN_INTROSPECT_PREFIX) ||
          fqName.startsWith(EXECUTION_FQ_PREFIX) ||
          fqName.startsWith(PLAN_FQ_PREFIX) ||
          fqName.startsWith(SUBAGENT_FQ_PREFIX)
      ),
      manager,
      new MemoryToolSource(memory),
    ]),
    {
      breaker: () => ({
        failureThreshold: toolResilience.failureThreshold,
        recoveryMs: toolResilience.recoveryMs,
      }),
      timeoutMs: (fqName) =>
        fqName.startsWith(EXECUTION_FQ_PREFIX) || fqName.startsWith(SUBAGENT_FQ_PREFIX)
          ? undefined
          : toolResilience.timeoutMs,
    }
  )
  agentTools = new AiToolRegistry(resilientToolHost, pluginNote)
  // Seed live tuning from persisted settings; reset breakers so any created
  // before the async load reflect the persisted config.
  void aiSettings.get().then((loaded) => {
    if (loaded.toolResilience) {
      toolResilience = loaded.toolResilience
      resilientToolHost.resetBreakers()
    }
  })

  const agentService = new AgentService({
    credentials,
    tools: agentTools,
    getToolHealth: () => resilientToolHost.snapshots(),
    onToolResilienceChange: (cfg) => {
      toolResilience = cfg
      resilientToolHost.resetBreakers()
    },
    getExecutionWorkspaces: executionWorkspaces,
    approvalResolver: (ctx) =>
      executionApprovalResolver.decide({
        conversationId: ctx.conversationId,
        fqName: ctx.fqName,
        input: ctx.input,
      }),
    conversations: new ConversationStore(path.join(userDataDir, "ai", "conversations")),
    workspaces: new WorkspaceStore(path.join(userDataDir, "ai")),
    providers: defaultProviderCatalog(),
    settings: aiSettings,
    approvals: new ApprovalStore(aiApprovalsFilePath(userDataDir)),
    sendEvent: broadcastAiChatEvent,
    recordRun,
    getLatestPlan: (conversationId) => getLatestPlan(runsDir, conversationId),
    planRegistry,
    onTurnStart: ({ runId, budgetTokens }) => {
      runBudgetRegistry.set(runId, budgetTokens)
    },
    onTurnEnd: ({ runId }) => {
      runBudgetRegistry.clear(runId)
    },
    mcp: {
      // Encrypt env/header secrets at rest with the OS keychain.
      configs: new McpServerConfigStore(aiMcpServersFilePath(userDataDir), osSecretProtector()),
      manager,
    },
  })

  emitPlanForRun = (runId, steps) => agentService.emitPlanForRun(runId, steps)
  makeSubagentProvider = () => agentService.createBackgroundAgentProvider()

  return agentService
}

/**
 * Turn authorized sandbox roots into named execution workspaces. The id is the
 * folder name, suffixed on collision so every workspace is addressable.
 */
function deriveExecutionWorkspaces(roots: readonly string[]): WorkspaceRoot[] {
  const seen = new Map<string, number>()
  return roots.map((root) => {
    const base = path.basename(root) || root
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return { id: count === 0 ? base : `${base}-${count + 1}`, root }
  })
}

function floatingBallDeps() {
  return {
    rendererDevUrl,
    appOrigin: APP_ORIGIN,
    getSettings: () => launcher.getSettings(),
    getLocale: () => app.getLocale(),
    onOpenFeature: (feature: "appLauncher") => {
      if (feature === "appLauncher") showSearchWindow(searchWindowDeps())
    },
    onDisable: () => {
      void disableFloatingBall()
    },
  }
}

async function disableFloatingBall(): Promise<void> {
  const next = await launcher.updateSettings({ floatingBallEnabled: false })
  hideFloatingBallWindow()
  refreshTrayMenu(trayActions())
  broadcastSettingsChanged(next)
}

interface TitleBarOverlayColors {
  color: string
  symbolColor: string
  height: number
}

/** "system" resolves through Electron's OS-level preference, mirroring the
 *  renderer's own matchMedia("prefers-color-scheme: dark") resolution in
 *  use-theme.tsx — the two must never disagree about which scheme is active. */
function resolveTitleBarScheme(themeMode: "light" | "dark" | "system"): "light" | "dark" {
  if (themeMode === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light"
  return themeMode
}

/** Colors match globals.css's --background/--foreground oklch tokens exactly
 *  (oklch(1 0 0)/oklch(0.145 0 0) light, oklch(0.145 0 0)/oklch(0.985 0 0)
 *  dark) so the native window-control overlay never clashes with whichever
 *  scheme the renderer actually painted. */
function titleBarOverlayForScheme(scheme: "light" | "dark"): TitleBarOverlayColors {
  return scheme === "dark"
    ? { color: "#0a0a0a", symbolColor: "#fafafa", height: 48 }
    : { color: "#ffffff", symbolColor: "#0a0a0a", height: 48 }
}

/** Re-themes an existing window's native title bar overlay — called on
 *  settings:update (explicit theme change) and on OS theme change while in
 *  "system" mode, so the min/maximize/close buttons never get stuck on
 *  whatever scheme was active when the window was created. */
function applyTitleBarScheme(win: BrowserWindow, themeMode: "light" | "dark" | "system"): void {
  if (win.isDestroyed()) return
  const overlay = titleBarOverlayForScheme(resolveTitleBarScheme(themeMode))
  win.setTitleBarOverlay(overlay)
  win.setBackgroundColor(overlay.color)
}

function createMainWindow(): BrowserWindow {
  const initialOverlay = titleBarOverlayForScheme(
    resolveTitleBarScheme(launcher.getSettings().themeMode)
  )
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: lanSimulation ? `Synapse - ${lanSimulation.deviceName}` : "Synapse",
    show: false, // launcher app stays in tray; window is shown on demand
    backgroundColor: initialOverlay.color,
    // Hide the native (light, OS-themed) title bar so the app's own themed
    // header can extend to the top of the window, matching the rest of the
    // UI instead of a jarring OS-default caption bar. The native min/
    // maximize/close buttons stay (as an "overlay") so window controls still
    // feel native; only their color is themed, and it's kept in sync with
    // the app's light/dark setting via applyTitleBarScheme. The renderer's
    // header must mark itself `-webkit-app-region: drag` (with `no-drag` on
    // any interactive children) to keep the window draggable without a real
    // title bar — see app-shell.tsx.
    titleBarStyle: "hidden",
    titleBarOverlay: initialOverlay,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  // Closing the main window should hide it, not quit the app — quitting is
  // reserved for the tray menu.
  win.on("close", (event) => {
    if (!quitRequested) {
      event.preventDefault()
      win.hide()
    }
  })

  if (rendererDevUrl) {
    void win.loadURL(rendererDevUrl)
    attachWindowSecurity(win, new URL(rendererDevUrl).origin)
    win.webContents.openDevTools({ mode: "detach" })
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`)
    attachWindowSecurity(win, APP_ORIGIN)
  }

  bindCapabilityPromptLifecycle(win)

  return win
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function rebindHotkey(accelerator: string): boolean {
  const ok = bindGlobalShortcut(accelerator, () => toggleSearchWindow(searchWindowDeps()))
  if (!ok) {
    logger.child("synapse").warn("failed to register global shortcut", { accelerator })
  }
  return ok
}

function trayActions() {
  return {
    onOpenSearch: () => showSearchWindow(searchWindowDeps()),
    onShowMainWindow: showMainWindow,
    onRefreshApps: () => {
      void launcher.refreshApps()
    },
    onQuit: () => {
      quitRequested = true
      setSearchWindowQuitting(true)
      app.quit()
    },
    getHotkey: () => launcher.getSettings().hotkey,
    shouldIgnoreOpenSearch: consumeSearchWindowTrayOpenSuppression,
    getLocale: () => app.getLocale(),
  }
}

async function initLan(enabled: boolean): Promise<void> {
  try {
    await lan.init(enabled)
  } catch (err) {
    if (!lanSimulation || !(err instanceof LanCredentialLoadError)) throw err
    logger.child("synapse").warn("resetting unreadable LAN simulation credentials", { err })
    await resetDevLanSimulationCredentials(lanSimulation)
    await lan.init(enabled)
  }
}

// `Synapse --mcp-stdio` is the friendly way to launch the MCP server, but a
// spawned Electron GUI process on Windows never receives piped stdin (which the
// MCP transport reads), so an in-process GUI server silently hangs. Instead,
// re-exec this binary as plain Node (ELECTRON_RUN_AS_NODE) pointed at the
// headless entry, inheriting stdio so the Node child speaks MCP straight to the
// caller. The heavy Electron/GUI init never runs in this mode.
function reExecMcpStdioAsNode(): void {
  const entry = path.join(__dirname, "mcp-stdio.js")
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  child.on("exit", (code) => app.exit(code ?? 0))
  child.on("error", (err) => {
    logger.child("synapse:mcp").error("failed to launch the stdio entry", { err })
    app.exit(1)
  })
}

// Single-instance lock: focusing the existing packaged app is friendlier than
// silently launching a duplicate process that fights for the same resources.
// In dev, skip the lock so stale Electron processes do not steal restarts and
// leave the visible window stuck on only the BrowserWindow background.
const shouldUseSingleInstanceLock = app.isPackaged
if (isMcpStdioMode) {
  reExecMcpStdioAsNode()
} else {
  const gotLock = !shouldUseSingleInstanceLock || app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    // macOS delivers "open with" through this event, possibly before the app is
    // ready — importSynapseFromOs queues until the plugin host exists.
    app.on("open-file", (event, filePath) => {
      event.preventDefault()
      if (filePath.toLowerCase().endsWith(".syn")) void importSynapseFromOs(filePath)
    })

    if (shouldUseSingleInstanceLock) {
      app.on("second-instance", (_event, argv) => {
        // A second launch carrying a .syn file (Windows/Linux "open with")
        // routes to import; otherwise re-open the launcher rather than steal
        // focus from whatever the user is doing — matches PowerToys behaviour.
        const synapseArg = findSynapseArg(argv)
        if (synapseArg) {
          void importSynapseFromOs(synapseArg)
          return
        }
        showSearchWindow(searchWindowDeps())
      })
    }

    void app.whenReady().then(async () => {
      // Match package.json build.appId so Windows recognises the app
      // identity and the post-install Start Menu shortcut's icon flows
      // through to toast notifications. Without this the OS treats us
      // as "electron.app.Electron" and shows Electron's default logo.
      if (process.platform === "win32") {
        app.setAppUserModelId("com.synapse.desktop")
        void ensureDevAppUserModelShortcut()
      }

      applyCsp()
      registerStaticProtocol()
      plugins = initPluginHost()
      app.on("browser-window-created", (_, win) => {
        bindCapabilityPromptLifecycle(win)
      })
      // Live-follow the OS light/dark switch while the user is on "system" —
      // mirrors use-theme.tsx's matchMedia listener on the renderer side, but
      // this one specifically keeps the native title bar overlay in sync.
      nativeTheme.on("updated", () => {
        if (launcher.getSettings().themeMode === "system" && mainWindow) {
          applyTitleBarScheme(mainWindow, "system")
        }
      })
      for (const win of BrowserWindow.getAllWindows()) {
        bindCapabilityPromptLifecycle(win)
      }
      lan = new LanService({
        userDataDir: app.getPath("userData"),
        adapter: new BonjourLanDiscoveryAdapter(),
        deviceName: lanSimulation?.deviceName,
        protector: {
          encrypt: (plainText) => {
            if (!safeStorage.isEncryptionAvailable()) {
              throw new Error("OS-backed encryption is unavailable for LAN credentials.")
            }
            return safeStorage.encryptString(plainText).toString("base64")
          },
          decrypt: (encryptedText) =>
            safeStorage.decryptString(Buffer.from(encryptedText, "base64")),
        },
      })
      agent = createAgentService()
      accountService = createMarketplaceAccountService()
      registerIpc()

      // Remove the default File/Edit/View… menu bar — the app uses a tray icon
      // and sidebar navigation instead.
      Menu.setApplicationMenu(null)

      let settings = await launcher.init()
      try {
        await initLan(settings.lanEnabled)
      } catch (err) {
        logger.child("synapse").error("failed to initialize LAN discovery", { err })
        settings = await launcher.updateSettings({ lanEnabled: false })
      }
      await plugins.init()

      // Connect external MCP servers in the background — a slow or broken
      // server must not block the launcher coming up.
      void agent
        .startMcpServers()
        .catch((err) => logger.child("synapse").error("failed to start MCP clients", { err }))

      // Replay a queued macOS open-file, or a .syn passed on first launch
      // (Windows/Linux "open with"), now that the plugin host is ready.
      const launchSynapse = pendingSynapseImport ?? findSynapseArg(process.argv.slice(1))
      pendingSynapseImport = null
      if (launchSynapse) void importSynapseFromOs(launchSynapse)

      // Pre-warm both the main window (so the first show is instant) and the
      // app cache (so the first launcher query has results).
      mainWindow = createMainWindow()
      if (lanSimulation) showMainWindow()
      ensureSearchWindow(searchWindowDeps())
      void launcher.refreshApps()

      // Check for updates once on startup — but only where we can actually
      // deliver one: packaged Windows/Linux. macOS is shipped unsigned, and
      // Squirrel.Mac rejects unsigned updates, so we don't offer them there.
      if (shouldAutoCheckOnStartup(process.platform, app.isPackaged)) {
        void updateService
          ?.check()
          .catch((err) => logger.child("synapse").error("update check failed", { err }))
      }

      createTray(defaultTrayIcon(), trayActions())
      rebindHotkey(settings.hotkey)
      syncFloatingBallWindow(floatingBallDeps())
      showStartupNotification({
        hotkey: settings.hotkey,
        locale: app.getLocale(),
        iconPath: defaultNotificationIcon(),
      })

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow()
        }
        showMainWindow()
      })
    })

    app.on("will-quit", () => {
      setSearchWindowQuitting(true)
      destroyFloatingBallWindow()
      void lan
        ?.stop()
        .catch((err) => logger.child("synapse").error("failed to stop LAN discovery", { err }))
      void mcpClients
        ?.dispose()
        .catch((err) => logger.child("synapse").error("failed to stop MCP clients", { err }))
      unbindGlobalShortcut()
      destroyTray()
      capabilityService?.dispose()
      plugins?.dispose()
    })

    // Plugin storage uses a 250ms throttled tmp+rename flush. Without this
    // hook the user clicks Quit at t=240ms after a `storage.set` and Electron
    // exits before the flush timer fires — the write is dropped. We block
    // before-quit once, run flushAll, then quit again. The `pluginsFlushed`
    // flag ensures the second quit goes through normally instead of looping.
    let pluginsFlushed = false
    app.on("before-quit", (event) => {
      quitRequested = true
      setSearchWindowQuitting(true)
      if (pluginsFlushed || !plugins) return
      event.preventDefault()
      void plugins
        .flush()
        .catch((err) =>
          logger.child("synapse").error("plugin flush failed during shutdown", { err })
        )
        .finally(() => {
          pluginsFlushed = true
          app.quit()
        })
    })

    // Tray-resident launcher: do NOT quit when all windows are closed.
    // Subscribing with a no-op handler suppresses Electron's default
    // "quit when last window closes" behaviour on Windows/Linux.
    app.on("window-all-closed", () => {
      // intentionally empty
    })
  }
}
