import * as path from "node:path"
import process from "node:process"
import { nativeImage, Notification } from "electron"

export interface StartupNotificationOptions {
  hotkey: string
  /** From app.getLocale() — used to pick the language for the toast text. */
  locale: string
  iconPath?: string
}

/**
 * Show the "DesKit is running" toast on launch. Tells the user where the
 * app went (it's in the tray) and what shortcut summons the launcher.
 */
export function showStartupNotification(options: StartupNotificationOptions): void {
  if (!Notification.isSupported()) return

  const strings = startupStrings(options.locale, prettyHotkey(options.hotkey))

  // On Windows 10+, the toast icon resolves through the AppUserModelID
  // registered with the Start Menu, not from this `icon` field — so in
  // dev mode without an installed shortcut the OS may fall back to
  // Electron's default icon. We still pass a NativeImage because newer
  // Electron honours it when the AUMID is properly set, and Linux
  // notify-send respects it unconditionally.
  const icon = options.iconPath ? nativeImage.createFromPath(options.iconPath) : undefined

  const notification = new Notification({
    title: strings.title,
    body: strings.body,
    silent: false,
    icon: icon && !icon.isEmpty() ? icon : undefined,
  })
  notification.show()
}

interface StartupStrings {
  title: string
  body: string
}

function startupStrings(locale: string, hotkey: string): StartupStrings {
  if (isChinese(locale)) {
    return {
      title: "DesKit 已启动",
      body: `按 ${hotkey} 打开命令启动器。`,
    }
  }
  return {
    title: "DesKit is running",
    body: `Press ${hotkey} to open the command launcher.`,
  }
}

function isChinese(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh")
}

export function prettyHotkey(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "commandorcontrol":
        case "cmdorctrl":
          return process.platform === "darwin" ? "⌘" : "Ctrl"
        case "control":
        case "ctrl":
          return "Ctrl"
        case "command":
        case "cmd":
          return "⌘"
        case "alt":
        case "option":
          return process.platform === "darwin" ? "⌥" : "Alt"
        case "shift":
          return "Shift"
        case "super":
        case "meta":
          return process.platform === "darwin" ? "⌘" : "Win"
        case "space":
          return "Space"
        default:
          return part.length === 1 ? part.toUpperCase() : part
      }
    })
    .join("+")
}

export function defaultNotificationIcon(): string {
  // 256x256 PNG rasterized from resources/logo.svg by
  // scripts/build-tray-icons.cjs. Resides next to icon.{ico,icns,png}
  // so electron-builder packages it.
  return path.join(__dirname, "../../resources/notification.png")
}
