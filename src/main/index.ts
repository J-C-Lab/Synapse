import type { ClipboardContent } from "@synapse/plugin-sdk"
import type { IpcMainInvokeEvent } from "electron"
import type { SecretProtector } from "./lan/credential-store"
import type { LanDevice, LanPairing, LanStatus, LanTransfer } from "./lan/types"
import type { SearchWindowDeps } from "./search-window"
import type { AutoUpdaterPort } from "./updates/update-service"
import { Buffer } from "node:buffer"
import * as path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron"
import electronUpdater from "electron-updater"
import { AgentService } from "./ai/agent-service"
import { aiSettingsFilePath, AiSettingsStore } from "./ai/ai-settings-store"
import { aiApprovalsFilePath, ApprovalStore } from "./ai/approval-store"
import { asFallbackSource, CompositeToolHost } from "./ai/composite-tool-host"
import { ConversationStore } from "./ai/conversation-store"
import { aiCredentialFilePath, AiCredentialStore } from "./ai/credential-store"
import { createMcpClient } from "./ai/mcp-client-factory"
import { MCP_FQ_PREFIX, McpClientManager } from "./ai/mcp-client-manager"
import { aiMcpServersFilePath, McpServerConfigStore } from "./ai/mcp-server-config-store"
import { MemoryService } from "./ai/memory/memory-service"
import { aiMemoryFilePath, MemoryStore } from "./ai/memory/memory-store"
import { MEMORY_FQ_PREFIX, MemoryToolSource } from "./ai/memory/memory-tools"
import { OpenAiEmbeddingProvider } from "./ai/memory/openai-embedding-provider"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "./ai/providers/catalog"
import { AiToolRegistry } from "./ai/tool-registry"
import {
  destroyFloatingBallWindow,
  hideFloatingBallWindow,
  moveFloatingBallBy,
  openFloatingBallFeature,
  syncFloatingBallWindow,
  toggleFloatingBallMenu,
} from "./floating-ball-window"
import { registerAiIpc } from "./ipc/ai"
import { registerLanIpc } from "./ipc/lan"
import { LauncherService } from "./ipc/launcher-service"
import { registerMarketplaceIpc } from "./ipc/marketplace"
import { registerPluginIpc } from "./ipc/plugins"
import { registerUpdatesIpc } from "./ipc/updates"
import { BonjourLanDiscoveryAdapter } from "./lan/bonjour-discovery-adapter"
import { LanCredentialLoadError } from "./lan/credential-store"
import {
  LAN_SIMULATION_PROFILE_ENV,
  resetDevLanSimulationCredentials,
  resolveDevLanSimulation,
} from "./lan/dev-simulation"
import { LanService } from "./lan/lan-service"
import { MarketplaceAccountService } from "./marketplace/account-service"
import { marketplaceTokenFilePath, MarketplaceTokenStore } from "./marketplace/token-store"
import { runSynapseMcpStdioServer } from "./mcp/synapse-mcp-server"
import { defaultNotificationIcon, showStartupNotification } from "./notifications"
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
import { bindGlobalShortcut, unbindGlobalShortcut } from "./shortcut"
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
  console.warn(
    `[synapse] LAN simulation profile "${lanSimulation.profile}" uses ${lanSimulation.userDataDir}`
  )
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
let lan: LanService
let agent: AgentService
let accountService: MarketplaceAccountService
let marketplaceTokens: MarketplaceTokenStore | undefined
// External MCP servers feeding tools to the built-in agent (P5). Held at module
// scope so shutdown can disconnect the child processes.
let mcpClients: McpClientManager | null = null
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
    return next
  })

  registerPluginIpc(ipcMain, plugins, {
    isTrustedSender: isTrustedIpcSender,
    onRegistryChanged: broadcastPluginRegistryChanged,
    pickPackageFile: pickSynapsePackageFile,
  })
  registerAiIpc(ipcMain, agent, { isTrustedSender: isTrustedIpcSender })
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
    console.error("[synapse] failed to update LAN discovery state", err)
    return launcher.updateSettings({ lanEnabled: previous.lanEnabled })
  }
}

function searchWindowDeps(): SearchWindowDeps {
  return { rendererDevUrl, appOrigin: APP_ORIGIN }
}

function createPluginHost(): PluginHost {
  return new PluginHost({
    fetch: (url, init) => net.fetch(url, init),
    marketplaceGetToken: () => marketplaceTokenStore().get(),
    userDataDir: app.getPath("userData"),
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

  // The model sees one flat tool list: local plugin tools, external MCP tools
  // (`mcp:<id>/<tool>`), and built-in memory tools (`memory:…`). Invocations
  // route by ownership.
  const tools = new AiToolRegistry(
    new CompositeToolHost([
      asFallbackSource(
        plugins,
        (fqName) => fqName.startsWith(MCP_FQ_PREFIX) || fqName.startsWith(MEMORY_FQ_PREFIX)
      ),
      manager,
      new MemoryToolSource(memory),
    ])
  )
  return new AgentService({
    credentials,
    tools,
    conversations: new ConversationStore(path.join(userDataDir, "ai", "conversations")),
    providers: defaultProviderCatalog(),
    settings: new AiSettingsStore(aiSettingsFilePath(userDataDir), DEFAULT_PROVIDER_ID),
    approvals: new ApprovalStore(aiApprovalsFilePath(userDataDir)),
    sendEvent: broadcastAiChatEvent,
    mcp: {
      // Encrypt env/header secrets at rest with the OS keychain.
      configs: new McpServerConfigStore(aiMcpServersFilePath(userDataDir), osSecretProtector()),
      manager,
    },
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

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: lanSimulation ? `Synapse - ${lanSimulation.deviceName}` : "Synapse",
    show: false, // launcher app stays in tray; window is shown on demand
    backgroundColor: "#0a0a0a",
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
    console.warn(`[synapse] failed to register global shortcut: ${accelerator}`)
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
    console.warn("[synapse] resetting unreadable LAN simulation credentials", err)
    await resetDevLanSimulationCredentials(lanSimulation)
    await lan.init(enabled)
  }
}

async function startMcpStdioMode(): Promise<void> {
  await app.whenReady()
  plugins = createPluginHost()
  await plugins.init()
  await runSynapseMcpStdioServer(plugins, { version: app.getVersion() })
}

// Single-instance lock: focusing the existing packaged app is friendlier than
// silently launching a duplicate process that fights for the same resources.
// In dev, skip the lock so stale Electron processes do not steal restarts and
// leave the visible window stuck on only the BrowserWindow background.
const shouldUseSingleInstanceLock = app.isPackaged
if (isMcpStdioMode) {
  app.on("will-quit", () => {
    plugins?.dispose()
  })
  void startMcpStdioMode().catch((err) => {
    console.error("[synapse:mcp] stdio server failed", err)
    app.exit(1)
  })
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
      }

      applyCsp()
      registerStaticProtocol()
      plugins = createPluginHost()
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
        console.error("[synapse] failed to initialize LAN discovery", err)
        settings = await launcher.updateSettings({ lanEnabled: false })
      }
      await plugins.init()

      // Connect external MCP servers in the background — a slow or broken
      // server must not block the launcher coming up.
      void agent
        .startMcpServers()
        .catch((err) => console.error("[synapse] failed to start MCP clients", err))

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
          .catch((err) => console.error("[synapse] update check failed", err))
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
      void lan?.stop().catch((err) => console.error("[synapse] failed to stop LAN discovery", err))
      void mcpClients
        ?.dispose()
        .catch((err) => console.error("[synapse] failed to stop MCP clients", err))
      unbindGlobalShortcut()
      destroyTray()
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
        .catch((err) => console.error("[synapse] plugin flush failed during shutdown", err))
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
