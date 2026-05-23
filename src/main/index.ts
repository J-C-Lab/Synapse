import type { SearchWindowDeps } from "./search-window"
import * as path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from "electron"
import { LauncherService } from "./ipc/launcher-service"
import { defaultNotificationIcon, showStartupNotification } from "./notifications"
import { getContentType, resolveStaticPath } from "./protocol/resolve-static-path"
import {
  ensureSearchWindow,
  hideSearchWindow,
  showSearchWindow,
  toggleSearchWindow,
} from "./search-window"
import { bindGlobalShortcut, unbindGlobalShortcut } from "./shortcut"
import { createTray, defaultTrayIcon, destroyTray, refreshTrayMenu } from "./tray"

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

  ipcMain.handle("settings:get", () => launcher.getSettings())

  ipcMain.handle("settings:update", async (_event, patch: unknown) => {
    const next = await launcher.updateSettings(coercePatch(patch))
    rebindHotkey(next.hotkey)
    refreshTrayMenu(trayActions())
    return next
  })
}

function coercePatch(value: unknown): { hotkey?: string } {
  if (!value || typeof value !== "object") return {}
  const v = value as Record<string, unknown>
  const out: { hotkey?: string } = {}
  if (typeof v.hotkey === "string") out.hotkey = v.hotkey
  return out
}

function attachWindowSecurity(win: BrowserWindow, allowedOrigin: string): void {
  // window.open / target=_blank: never spawn a new BrowserWindow. Hand
  // off http(s) URLs to the OS browser; deny everything else.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url)
    }
    return { action: "deny" }
  })

  // Prevent the renderer from navigating away from the app origin.
  // Plain <a href="https://..."> (no target=_blank) would otherwise replace
  // the renderer document with an external page.
  win.webContents.on("will-navigate", (event, url) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      event.preventDefault()
      return
    }
    if (target.origin === allowedOrigin) return
    event.preventDefault()
    if (target.protocol === "http:" || target.protocol === "https:") {
      void shell.openExternal(url)
    }
  })

  // Reject privilege escalation requests from preload/renderer.
  win.webContents.on("will-attach-webview", (event, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    event.preventDefault()
  })
}

function searchWindowDeps(): SearchWindowDeps {
  return { rendererDevUrl, appOrigin: APP_ORIGIN }
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

function rebindHotkey(accelerator: string): void {
  const ok = bindGlobalShortcut(accelerator, () => toggleSearchWindow(searchWindowDeps()))
  if (!ok) {
    console.warn(`[deskit] failed to register global shortcut: ${accelerator}`)
  }
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
      app.quit()
    },
    getHotkey: () => launcher.getSettings().hotkey,
    getLocale: () => app.getLocale(),
  }
}

// Single-instance lock: focusing the existing window is friendlier than
// silently launching a duplicate process that fights for the same resources.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    // Second launch should re-open the launcher rather than steal focus
    // from whatever the user is doing — matches PowerToys behaviour.
    showSearchWindow(searchWindowDeps())
  })

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
    unbindGlobalShortcut()
    destroyTray()
  })

  app.on("before-quit", () => {
    quitRequested = true
  })

  // Tray-resident launcher: do NOT quit when all windows are closed.
  // Subscribing with a no-op handler suppresses Electron's default
  // "quit when last window closes" behaviour on Windows/Linux.
  app.on("window-all-closed", () => {
    // intentionally empty
  })
}
