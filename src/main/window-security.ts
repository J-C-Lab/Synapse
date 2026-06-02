import type { BrowserWindow } from "electron"
import { shell } from "electron"

export function attachWindowSecurity(win: BrowserWindow, allowedOrigin: string): void {
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
    if (isSameOrigin(target, allowedOrigin)) return
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

// Whether `target` shares the allowed origin. The production renderer uses the
// custom `app://` scheme, whose origin Node's URL parser serializes to "null",
// so fall back to comparing scheme + host when `.origin` can't be matched.
export function isSameOrigin(target: URL, allowedOrigin: string): boolean {
  if (target.origin !== "null" && target.origin === allowedOrigin) return true
  try {
    const allowed = new URL(allowedOrigin)
    return target.protocol === allowed.protocol && target.host === allowed.host
  } catch {
    return false
  }
}
