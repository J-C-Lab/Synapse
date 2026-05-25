import type { SearchWindowDeps } from "./search-window"
import * as path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron"
import {
  destroyFloatingBallWindow,
  hideFloatingBallWindow,
  moveFloatingBallBy,
  openFloatingBallFeature,
  syncFloatingBallWindow,
  toggleFloatingBallMenu,
} from "./floating-ball-window"
import { LauncherService } from "./ipc/launcher-service"
import { defaultNotificationIcon, showStartupNotification } from "./notifications"
import { getContentType, resolveStaticPath } from "./protocol/resolve-static-path"
import {
  ensureSearchWindow,
  hideSearchWindow,
  markSearchWindowReady,
  setSearchWindowQuitting,
  showSearchWindow,
  toggleSearchWindow,
} from "./search-window"
import { bindGlobalShortcut, unbindGlobalShortcut } from "./shortcut"
import { createTray, defaultTrayIcon, destroyTray, refreshTrayMenu } from "./tray"
import { attachWindowSecurity } from "./window-security"

const isDev = !app.isPackaged
// electron-vite injects this in dev (Vite dev server URL). Undefined in prod.
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL

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

const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'"

function devCsp(devOrigin: string): string {
  const ws = devOrigin.replace(/^http/, "ws")
  return (
    `default-src 'self' ${devOrigin} ${ws}; ` +
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}; ` +
    `style-src 'self' 'unsafe-inline' ${devOrigin}; ` +
    `img-src 'self' data: blob: ${devOrigin}; ` +
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
let mainWindow: BrowserWindow | null = null
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

    refreshTrayMenu(trayActions())
    syncFloatingBallWindow(floatingBallDeps())
    broadcastSettingsChanged(next)
    return next
  })
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

function coercePatch(value: unknown): Partial<{
  hotkey: string
  themeMode: "light" | "dark" | "system"
  accent: "neutral" | "blue" | "green" | "rose" | "violet"
  floatingBallEnabled: boolean
  floatingBallFeatures: "appLauncher"[]
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
  return out
}

function searchWindowDeps(): SearchWindowDeps {
  return { rendererDevUrl, appOrigin: APP_ORIGIN }
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
    title: "DesKit",
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
    console.warn(`[deskit] failed to register global shortcut: ${accelerator}`)
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
    getLocale: () => app.getLocale(),
  }
}

// Single-instance lock: focusing the existing packaged app is friendlier than
// silently launching a duplicate process that fights for the same resources.
// In dev, skip the lock so stale Electron processes do not steal restarts and
// leave the visible window stuck on only the BrowserWindow background.
const shouldUseSingleInstanceLock = app.isPackaged
const gotLock = !shouldUseSingleInstanceLock || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  if (shouldUseSingleInstanceLock) {
    app.on("second-instance", () => {
      // Second launch should re-open the launcher rather than steal focus
      // from whatever the user is doing — matches PowerToys behaviour.
      showSearchWindow(searchWindowDeps())
    })
  }

  void app.whenReady().then(async () => {
    // Match package.json build.appId so Windows recognises the app
    // identity and the post-install Start Menu shortcut's icon flows
    // through to toast notifications. Without this the OS treats us
    // as "electron.app.Electron" and shows Electron's default logo.
    if (process.platform === "win32") {
      app.setAppUserModelId("com.deskit.desktop")
    }

    applyCsp()
    registerStaticProtocol()
    registerIpc()

    const settings = await launcher.init()

    // Pre-warm both the main window (so the first show is instant) and the
    // app cache (so the first launcher query has results).
    mainWindow = createMainWindow()
    ensureSearchWindow(searchWindowDeps())
    void launcher.refreshApps()

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
    unbindGlobalShortcut()
    destroyTray()
  })

  app.on("before-quit", () => {
    quitRequested = true
    setSearchWindowQuitting(true)
  })

  // Tray-resident launcher: do NOT quit when all windows are closed.
  // Subscribing with a no-op handler suppresses Electron's default
  // "quit when last window closes" behaviour on Windows/Linux.
  app.on("window-all-closed", () => {
    // intentionally empty
  })
}
