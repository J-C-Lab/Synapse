import type { WebContents } from "electron"
import * as path from "node:path"
import process from "node:process"
import { BrowserWindow, screen } from "electron"
import { attachWindowSecurity } from "./window-security"

const SEARCH_WIDTH = 720
const SEARCH_HEIGHT = 480
const SEARCH_HASH = "search"
const SEARCH_REVEAL_DELAY_MS = 32

export interface SearchWindowDeps {
  /** Vite dev-server URL when running `pnpm dev`; undefined in production. */
  rendererDevUrl: string | undefined
  /** Origin allowed to navigate inside the window (CSP / navigation guard). */
  appOrigin: string
}

let searchWindow: BrowserWindow | null = null
let searchWindowQuitting = false
let searchWindowReady = false
let searchWindowShown = false
let pendingSearchWindowShow = false
let searchWindowRevealToken = 0

export function setSearchWindowQuitting(quitting: boolean): void {
  searchWindowQuitting = quitting
}

export function ensureSearchWindow(deps: SearchWindowDeps): BrowserWindow {
  if (searchWindow && !searchWindow.isDestroyed()) return searchWindow

  searchWindowReady = false
  searchWindowShown = false
  pendingSearchWindowShow = false
  searchWindowRevealToken += 1

  searchWindow = new BrowserWindow({
    width: SEARCH_WIDTH,
    height: SEARCH_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "DesKit Launcher",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })
  searchWindow.setOpacity(0)
  searchWindow.setIgnoreMouseEvents(true)
  searchWindow.setFocusable(false)

  // Hide instead of closing — re-creating a BrowserWindow on every hotkey
  // press makes the first show feel sluggish.
  searchWindow.on("close", (event) => {
    if (!searchWindow) return
    if (searchWindowQuitting) return
    event.preventDefault()
    hideSearchWindow()
  })

  searchWindow.on("closed", () => {
    searchWindow = null
    searchWindowReady = false
    searchWindowShown = false
    pendingSearchWindowShow = false
    searchWindowRevealToken += 1
  })

  // Auto-hide when the user clicks elsewhere — same behaviour as
  // Spotlight / PowerToys Run.
  searchWindow.on("blur", () => {
    if (process.env.DESKIT_KEEP_SEARCH_OPEN) return
    hideSearchWindow()
  })

  const allowedOrigin = deps.rendererDevUrl ? new URL(deps.rendererDevUrl).origin : deps.appOrigin
  attachWindowSecurity(searchWindow, allowedOrigin)

  const url = deps.rendererDevUrl
    ? `${deps.rendererDevUrl}#${SEARCH_HASH}`
    : `${deps.appOrigin}/index.html#${SEARCH_HASH}`
  void searchWindow.loadURL(url)

  return searchWindow
}

export function getSearchWindow(): BrowserWindow | null {
  return searchWindow && !searchWindow.isDestroyed() ? searchWindow : null
}

export function showSearchWindow(deps: SearchWindowDeps): void {
  const win = ensureSearchWindow(deps)
  centerOnActiveDisplay(win)
  searchWindowShown = true

  if (!searchWindowReady) {
    pendingSearchWindowShow = true
    return
  }

  revealSearchWindow(win)
}

export function hideSearchWindow(): void {
  const win = getSearchWindow()
  if (!win) return
  searchWindowShown = false
  pendingSearchWindowShow = false
  searchWindowRevealToken += 1
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
  win.setFocusable(false)
}

export function toggleSearchWindow(deps: SearchWindowDeps): void {
  const win = getSearchWindow()
  if (win && searchWindowShown) {
    hideSearchWindow()
  } else {
    showSearchWindow(deps)
  }
}

export function markSearchWindowReady(sender: WebContents): void {
  const win = getSearchWindow()
  if (!win || BrowserWindow.fromWebContents(sender) !== win) return

  searchWindowReady = true
  prepareHiddenSearchWindow(win)

  if (pendingSearchWindowShow) {
    pendingSearchWindowShow = false
    searchWindowShown = true
    revealSearchWindow(win)
  }
}

function prepareHiddenSearchWindow(win: BrowserWindow): void {
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
  win.setFocusable(false)
  if (!win.isVisible()) win.showInactive()
}

function revealSearchWindow(win: BrowserWindow): void {
  const token = ++searchWindowRevealToken

  win.setOpacity(0)
  win.setFocusable(true)
  win.setIgnoreMouseEvents(false)
  if (!win.isVisible()) win.showInactive()
  win.webContents.send("launcher:focus")

  setTimeout(() => {
    if (token !== searchWindowRevealToken || !searchWindowShown || win.isDestroyed()) return
    win.setOpacity(1)
    win.focus()
  }, SEARCH_REVEAL_DELAY_MS)
}

function centerOnActiveDisplay(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x, y, width, height } = display.workArea
  // Sit at ~1/4 from the top — roughly where users expect command palettes.
  win.setBounds({
    x: Math.round(x + (width - SEARCH_WIDTH) / 2),
    y: Math.round(y + height / 4 - SEARCH_HEIGHT / 4),
    width: SEARCH_WIDTH,
    height: SEARCH_HEIGHT,
  })
}
