import type { ClipboardContent } from "./clipboard"
import type { FsAPI } from "./fs"
import type { NetworkAPI } from "./network"

/**
 * Per-plugin key/value store. Backed by `userData/plugin-data/<pluginId>.json`
 * with throttled atomic writes (250ms batch) on the host. Values must be
 * JSON-serialisable. Reads are synchronous-feeling (host caches the file in
 * memory), writes are async to surface I/O errors.
 */
export interface StorageAPI {
  get: <T = unknown>(key: string) => Promise<T | undefined>
  set: <T = unknown>(key: string, value: T) => Promise<void>
  delete: (key: string) => Promise<void>
  list: () => Promise<string[]>
}

/**
 * Clipboard. Reading/writing requires the matching `clipboard:read` /
 * `clipboard:write` permission to be declared in the manifest.
 */
export interface ClipboardAPI {
  /**
   * Reads the richest clipboard payload the host can currently represent.
   * Text, image and file-list clipboard entries are all part of P0.
   */
  read: () => Promise<ClipboardContent | undefined>
  write: (content: ClipboardContent) => Promise<void>
  /**
   * Subscribe to OS clipboard changes. Used by the clipboard history
   * built-in. Returns an unsubscribe function. Host implements polling.
   */
  watch: (listener: (content: ClipboardContent) => void) => () => void

  /** Convenience text-only helpers for simple commands. */
  readText: () => Promise<string>
  writeText: (text: string) => Promise<void>
}

export interface NotificationAction {
  title: string
  journalId?: string
}

export interface NotificationShowOptions {
  title: string
  body?: string
  silent?: boolean
  actions?: NotificationAction[]
}

export interface NotificationShowResult {
  notificationId: string
}

export interface NotificationAPI {
  show: (options: NotificationShowOptions) => Promise<NotificationShowResult>
}

export interface SystemAPI {
  /** Opens the URL in the user's default browser. Only `http(s)` is honoured. */
  openUrl: (url: string) => Promise<void>
  /** Opens a file path with the OS default handler (`shell.openPath`). */
  openPath: (path: string) => Promise<void>
  /**
   * Captures a full screen and writes a PNG into the plugin's data directory.
   * P0 supports full-screen only — region/annotation are P1.
   * Returns the absolute path to the saved file.
   */
  captureScreen: (options?: {
    /** Optional filename (without extension). Default = ISO timestamp. */
    name?: string
  }) => Promise<{ path: string }>
}

/**
 * Per-invocation runtime handed to every command hook.
 *
 * The host constructs a fresh `PluginContext` for each `run` /
 * `onSearchChange` / `onAction` / `dispose` call so that `locale`, `theme`
 * and `preferences` always reflect the current user settings. Plugins
 * should treat the object as ephemeral — capturing it across calls (e.g.
 * stashing `ctx` in module scope from `run` and reusing it later) will
 * read stale settings and is not supported.
 *
 * Long-lived subscriptions (e.g. `clipboard.watch`) intentionally outlive
 * a single ctx and stay valid until the plugin is disabled.
 */
export interface PluginContext {
  pluginId: string
  /** BCP-47 locale, e.g. `en` or `zh-CN`. Updated when the user changes language. */
  locale: string
  theme: { mode: "light" | "dark"; accent: string }
  /** Manifest-declared `contributes.preferences`, merged with user overrides. */
  preferences: Record<string, unknown>

  storage: StorageAPI
  clipboard: ClipboardAPI
  notifications: NotificationAPI
  system: SystemAPI

  /**
   * HTTPS fetch, gated by the `network:https` capability. Constrained to the
   * declared host/method/path scope; the host blocks private IPs and
   * cross-origin redirects, and there is no cookie jar.
   */
  network: NetworkAPI

  /**
   * Declared-path filesystem helpers for background triggers. Absolute paths
   * are never exposed in trigger events — resolve/read through these gated APIs.
   */
  fs: FsAPI

  /** Routed to the host's plugin log channel. Avoid `console` from inside the sandbox. */
  log: (...args: unknown[]) => void
}
