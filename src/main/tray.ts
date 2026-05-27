import * as path from "node:path"
import { app, Menu, nativeImage, Tray } from "electron"
import { prettyHotkey } from "./notifications"

export interface TrayActions {
  onOpenSearch: () => void
  onShowMainWindow: () => void
  onRefreshApps: () => void
  onQuit: () => void
  getHotkey: () => string
  /** From app.getLocale(); selects the menu language. */
  getLocale: () => string
}

interface TrayStrings {
  openLauncher: (hotkey: string) => string
  showMainWindow: string
  reloadApps: string
  version: (v: string) => string
  quit: string
}

function trayStrings(locale: string): TrayStrings {
  if (locale.toLowerCase().startsWith("zh")) {
    return {
      openLauncher: (hotkey) => `打开启动器 (${hotkey})`,
      showMainWindow: "显示 DesKit 主窗口",
      reloadApps: "重新扫描已安装应用",
      version: (v) => `版本 ${v}`,
      quit: "退出 DesKit",
    }
  }
  return {
    openLauncher: (hotkey) => `Open launcher (${hotkey})`,
    showMainWindow: "Show DesKit window",
    reloadApps: "Reload installed apps",
    version: (v) => `Version ${v}`,
    quit: "Quit DesKit",
  }
}

let tray: Tray | null = null

export function createTray(iconPath: string, actions: TrayActions): Tray {
  // nativeImage automatically picks @2x / @3x variants next to the base
  // file on HiDPI displays (e.g. tray@2x.png for a 200% scale display),
  // so we hand it the 16x16 base path and let it scale.
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip("DesKit")
  refreshTrayMenu(actions)
  tray.on("click", actions.onOpenSearch)
  return tray
}

export function refreshTrayMenu(actions: TrayActions): void {
  if (!tray) return
  const s = trayStrings(actions.getLocale())
  const menu = Menu.buildFromTemplate([
    {
      label: s.openLauncher(prettyHotkey(actions.getHotkey())),
      click: actions.onOpenSearch,
    },
    { label: s.showMainWindow, click: actions.onShowMainWindow },
    { type: "separator" },
    { label: s.reloadApps, click: actions.onRefreshApps },
    { type: "separator" },
    { label: s.version(app.getVersion()), enabled: false },
    { label: s.quit, click: actions.onQuit },
  ])
  tray.setContextMenu(menu)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export function defaultTrayIcon(): string {
  return path.join(__dirname, "../../resources/tray.png")
}
