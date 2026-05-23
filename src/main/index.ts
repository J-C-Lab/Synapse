import * as path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from "electron"
import { greet } from "./ipc/greet"
import { getContentType, resolveStaticPath } from "./protocol/resolve-static-path"

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

function registerIpc(): void {
  ipcMain.handle("greet", (_event, name: unknown) => {
    if (typeof name !== "string") {
      throw new TypeError("name must be a string")
    }
    return greet(name)
  })
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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: "DesKit",
    show: false, // wait for ready-to-show to avoid white flash
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  win.once("ready-to-show", () => win.show())

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

// Single-instance lock: focusing the existing window is friendlier than
// silently launching a duplicate process that fights for the same resources.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    const [first] = BrowserWindow.getAllWindows()
    if (first) {
      if (first.isMinimized()) first.restore()
      first.focus()
    }
  })

  void app.whenReady().then(() => {
    applyCsp()
    registerStaticProtocol()
    registerIpc()
    createWindow()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
