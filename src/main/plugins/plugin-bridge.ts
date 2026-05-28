import type {
  ClipboardContent,
  NotificationAPI,
  PluginContext,
  StorageAPI,
  SystemAPI,
} from "@deskit/plugin-sdk"
import type { PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { createPermissionGate } from "./permissions"

export interface PluginRuntimeSnapshot {
  locale: string
  theme: { mode: "light" | "dark"; accent: string }
}

export interface CaptureScreenOptions {
  name?: string
}

export interface ClipboardAdapter {
  read: () => Promise<ClipboardContent | undefined>
  write: (content: ClipboardContent) => Promise<void>
}

export interface NotificationAdapter {
  show: NotificationAPI["show"]
}

export interface SystemAdapter {
  openUrl: SystemAPI["openUrl"]
  openPath: SystemAPI["openPath"]
  captureScreen: (pluginId: string, options?: CaptureScreenOptions) => Promise<{ path: string }>
}

export interface PluginBridgeAdapters {
  clipboard: ClipboardAdapter
  notifications: NotificationAdapter
  system: SystemAdapter
}

export interface PluginBridgeOptions {
  userDataDir: string
  adapters: PluginBridgeAdapters
  runtime?: () => PluginRuntimeSnapshot
  preferences?: (pluginId: string, manifest: PluginManifest) => Record<string, unknown>
  storageFlushMs?: number
  clipboardPollMs?: number
}

interface StorageState {
  loaded: boolean
  data: Record<string, unknown>
  flushTimer?: ReturnType<typeof setTimeout>
}

const defaultRuntime: PluginRuntimeSnapshot = {
  locale: "en",
  theme: { mode: "light", accent: "neutral" },
}

export class PluginBridge {
  private readonly storage = new Map<string, StorageState>()
  private readonly watchers = new Map<string, Set<ReturnType<typeof setInterval>>>()
  private readonly storageFlushMs: number
  private readonly clipboardPollMs: number

  constructor(private readonly options: PluginBridgeOptions) {
    this.storageFlushMs = options.storageFlushMs ?? 250
    this.clipboardPollMs = options.clipboardPollMs ?? 500
  }

  createContext(pluginId: string, manifest: PluginManifest): PluginContext {
    const gate = createPermissionGate(manifest)
    const runtime = this.options.runtime?.() ?? defaultRuntime

    return {
      pluginId,
      locale: runtime.locale,
      theme: runtime.theme,
      preferences: {
        ...preferencesFromManifest(manifest),
        ...(this.options.preferences?.(pluginId, manifest) ?? {}),
      },
      storage: this.createStorageAPI(pluginId, gate),
      clipboard: {
        read: async () => {
          gate.check("clipboard:read")
          return this.options.adapters.clipboard.read()
        },
        write: async (content) => {
          gate.check("clipboard:write")
          await this.options.adapters.clipboard.write(content)
        },
        watch: (listener) => {
          gate.check("clipboard:read")
          return this.watchClipboard(pluginId, listener)
        },
        readText: async () => {
          gate.check("clipboard:read")
          const content = await this.options.adapters.clipboard.read()
          return content?.type === "text" ? content.text : ""
        },
        writeText: async (text) => {
          gate.check("clipboard:write")
          await this.options.adapters.clipboard.write({ type: "text", text })
        },
      },
      notifications: {
        show: async (options) => {
          gate.check("notification")
          await this.options.adapters.notifications.show(options)
        },
      },
      system: {
        openUrl: async (url) => {
          gate.check("system:open-url")
          await this.options.adapters.system.openUrl(url)
        },
        openPath: async (targetPath) => {
          gate.check("system:open-path")
          await this.options.adapters.system.openPath(targetPath)
        },
        captureScreen: async (options) => {
          gate.check("system:capture-screen")
          return this.options.adapters.system.captureScreen(pluginId, options)
        },
      },
      log: (...args) => {
        console.warn(`[plugin:${pluginId}]`, ...args)
      },
    }
  }

  async disposePlugin(pluginId: string): Promise<void> {
    const timers = this.watchers.get(pluginId)
    if (timers) {
      for (const timer of timers) clearInterval(timer)
      this.watchers.delete(pluginId)
    }
    await this.flushStorage(pluginId)
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.storage.keys()].map((pluginId) => this.flushStorage(pluginId)))
  }

  storageFilePath(pluginId: string): string {
    return path.join(
      this.options.userDataDir,
      "plugin-data",
      `${safePluginFileName(pluginId)}.json`
    )
  }

  private createStorageAPI(
    pluginId: string,
    gate: { check: (permission: string) => void }
  ): StorageAPI {
    return {
      get: async <T = unknown>(key: string) => {
        gate.check("storage:plugin")
        const state = await this.loadStorage(pluginId)
        return state.data[key] as T | undefined
      },
      set: async <T = unknown>(key: string, value: T) => {
        gate.check("storage:plugin")
        const state = await this.loadStorage(pluginId)
        state.data[key] = value
        await this.scheduleStorageFlush(pluginId)
      },
      delete: async (key: string) => {
        gate.check("storage:plugin")
        const state = await this.loadStorage(pluginId)
        delete state.data[key]
        await this.scheduleStorageFlush(pluginId)
      },
      list: async () => {
        gate.check("storage:plugin")
        const state = await this.loadStorage(pluginId)
        return Object.keys(state.data)
      },
    }
  }

  private async loadStorage(pluginId: string): Promise<StorageState> {
    const existing = this.storage.get(pluginId)
    if (existing?.loaded) return existing

    const state = existing ?? { loaded: false, data: {} }
    try {
      const raw = await fs.readFile(this.storageFilePath(pluginId), "utf-8")
      const parsed = JSON.parse(raw) as unknown
      state.data =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {}
    } catch (err) {
      if (!isFileNotFound(err) && !(err instanceof SyntaxError)) throw err
      state.data = {}
    }
    state.loaded = true
    this.storage.set(pluginId, state)
    return state
  }

  private async scheduleStorageFlush(pluginId: string): Promise<void> {
    if (this.storageFlushMs <= 0) {
      await this.flushStorage(pluginId)
      return
    }

    const state = this.storage.get(pluginId)
    if (!state || state.flushTimer) return

    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined
      void this.flushStorage(pluginId)
    }, this.storageFlushMs)
  }

  private async flushStorage(pluginId: string): Promise<void> {
    const state = this.storage.get(pluginId)
    if (!state?.loaded) return
    if (state.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = undefined
    }

    const filePath = this.storageFilePath(pluginId)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tempPath, `${JSON.stringify(state.data, null, 2)}\n`, "utf-8")
    await fs.rename(tempPath, filePath)
  }

  private watchClipboard(
    pluginId: string,
    listener: (content: ClipboardContent) => void
  ): () => void {
    let lastSerialized: string | undefined
    const timer = setInterval(() => {
      void this.options.adapters.clipboard
        .read()
        .then((content) => {
          if (!content) return
          const serialized = JSON.stringify(content)
          if (serialized === lastSerialized) return
          lastSerialized = serialized
          listener(content)
        })
        .catch((err) => {
          console.warn(`[plugin:${pluginId}] Clipboard watch read failed`, err)
        })
    }, this.clipboardPollMs)

    let timers = this.watchers.get(pluginId)
    if (!timers) {
      timers = new Set()
      this.watchers.set(pluginId, timers)
    }
    timers.add(timer)

    return () => {
      clearInterval(timer)
      timers.delete(timer)
      if (timers.size === 0) this.watchers.delete(pluginId)
    }
  }
}

function preferencesFromManifest(manifest: PluginManifest): Record<string, unknown> {
  const preferences: Record<string, unknown> = {}
  for (const preference of manifest.contributes.preferences ?? []) {
    if ("default" in preference) preferences[preference.id] = preference.default
  }
  return preferences
}

function safePluginFileName(pluginId: string): string {
  return pluginId.replace(/[^\w.-]/g, "_")
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
