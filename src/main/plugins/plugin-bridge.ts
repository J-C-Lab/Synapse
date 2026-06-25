import type {
  ClipboardContent,
  NotificationAPI,
  PluginContext,
  StorageAPI,
  SystemAPI,
  ToolCaller,
  ToolContext,
} from "@synapse/plugin-sdk"
import type { CapabilityActor, CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import type { CapabilityGovernance } from "./capability-governance"
import type { PluginManifest, PluginSourceKind } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { logger } from "../logging"
import { CapabilityGate as CapabilityGateImpl } from "./capability-gate"
import {
  buildGrantIdentity,
  callerToActor,
  createCapabilityGovernance,
} from "./capability-governance"

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

/** Context passed into each capability `ensure()` call for one plugin invocation. */
export interface InvocationContext {
  actor: CapabilityActor
  trigger: string
  signal?: AbortSignal
}

export interface PluginBridgeOptions {
  userDataDir: string
  adapters: PluginBridgeAdapters
  runtime?: () => PluginRuntimeSnapshot
  preferences?: (pluginId: string, manifest: PluginManifest) => Record<string, unknown>
  storageFlushMs?: number
  clipboardPollMs?: number
  governance?: CapabilityGovernance
  /** Resolves a plugin's source kind for grant-identity fingerprinting. */
  sourceKindFor?: (pluginId: string) => PluginSourceKind
  /** Test seam: replace per-plugin gate construction. */
  createGate?: (
    pluginId: string,
    manifest: PluginManifest,
    sourceKind: PluginSourceKind
  ) => CapabilityGatePort
}

/** Inputs the host supplies when building a `ToolContext` for one tool call. */
export interface ToolContextOptions {
  caller: ToolCaller
  signal: AbortSignal
  progress?: (pct: number, message?: string) => void
  /** Tool-declared permissions; gates the context to this subset when present. */
  permissions?: string[]
  toolName: string
}

/** The capability slice shared by command and tool contexts. */
type PluginCapabilities = Pick<
  PluginContext,
  "storage" | "clipboard" | "notifications" | "system" | "log"
>

interface StorageState {
  loaded: boolean
  data: Record<string, unknown>
  flushTimer?: ReturnType<typeof setTimeout>
}

const defaultRuntime: PluginRuntimeSnapshot = {
  locale: "en",
  theme: { mode: "light", accent: "neutral" },
}

const defaultInvocation: InvocationContext = {
  actor: "user",
  trigger: "plugin:runtime",
}

export class PluginBridge {
  private readonly storage = new Map<string, StorageState>()
  private readonly watchers = new Map<string, Set<ReturnType<typeof setInterval>>>()
  private readonly storageFlushMs: number
  private readonly clipboardPollMs: number
  private readonly governance: CapabilityGovernance
  private readonly sourceKindFor: (pluginId: string) => PluginSourceKind
  private readonly createGate?: PluginBridgeOptions["createGate"]

  constructor(private readonly options: PluginBridgeOptions) {
    this.storageFlushMs = options.storageFlushMs ?? 250
    this.clipboardPollMs = options.clipboardPollMs ?? 500
    this.governance =
      options.governance ?? createCapabilityGovernance({ userDataDir: options.userDataDir })
    this.sourceKindFor = options.sourceKindFor ?? (() => "user")
    this.createGate = options.createGate
  }

  createContext(
    pluginId: string,
    manifest: PluginManifest,
    invocation: InvocationContext = defaultInvocation
  ): PluginContext {
    const runtime = this.options.runtime?.() ?? defaultRuntime
    const gate = this.gateFor(pluginId, manifest)

    return {
      pluginId,
      locale: runtime.locale,
      theme: runtime.theme,
      preferences: this.resolvePreferences(pluginId, manifest),
      ...this.createCapabilities(pluginId, gate, invocation),
    }
  }

  /**
   * Build a headless `ToolContext` for one tool invocation. Reuses the same
   * permission-gated capabilities as commands, drops `locale`/`theme` (tools
   * have no UI), and adds `caller`/`signal`/`progress`. When the tool declares
   * its own `permissions`, the gate is restricted to that subset.
   */
  createToolContext(
    pluginId: string,
    manifest: PluginManifest,
    options: ToolContextOptions
  ): ToolContext {
    const effective = options.permissions
      ? { ...manifest, permissions: options.permissions }
      : manifest
    const gate = this.gateFor(pluginId, effective)
    const invocation: InvocationContext = {
      actor: callerToActor(options.caller),
      trigger: `tool:${options.toolName}`,
      signal: options.signal,
    }

    return {
      pluginId,
      preferences: this.resolvePreferences(pluginId, manifest),
      ...this.createCapabilities(pluginId, gate, invocation),
      caller: options.caller,
      signal: options.signal,
      progress: options.progress,
    }
  }

  private gateFor(pluginId: string, manifest: PluginManifest): CapabilityGatePort {
    const sourceKind = this.sourceKindFor(pluginId)
    if (this.createGate) return this.createGate(pluginId, manifest, sourceKind)

    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    return new CapabilityGateImpl({
      identity,
      declared: new Set(manifest.permissions),
      grants: this.governance.grants,
      prompt: this.governance.prompt,
      approve: this.governance.approve,
      audit: this.governance.audit,
    })
  }

  private resolvePreferences(pluginId: string, manifest: PluginManifest): Record<string, unknown> {
    return {
      ...preferencesFromManifest(manifest),
      ...(this.options.preferences?.(pluginId, manifest) ?? {}),
    }
  }

  private createCapabilities(
    pluginId: string,
    gate: CapabilityGatePort,
    invocation: InvocationContext
  ): PluginCapabilities {
    const ensure = (request: Omit<CapabilityRequest, "actor" | "trigger" | "signal">) =>
      gate.ensure({
        ...request,
        actor: invocation.actor,
        trigger: invocation.trigger,
        signal: invocation.signal,
      })

    return {
      storage: this.createStorageAPI(pluginId, gate, invocation),
      clipboard: {
        read: async () => {
          await ensure({ capability: "clipboard:read", operation: "read" })
          return this.options.adapters.clipboard.read()
        },
        write: async (content) => {
          await ensure({ capability: "clipboard:write", operation: "write" })
          await this.options.adapters.clipboard.write(content)
        },
        watch: (listener) => this.watchClipboardWithGate(pluginId, gate, invocation, listener),
        readText: async () => {
          await ensure({ capability: "clipboard:read", operation: "read" })
          const content = await this.options.adapters.clipboard.read()
          return content?.type === "text" ? content.text : ""
        },
        writeText: async (text) => {
          await ensure({ capability: "clipboard:write", operation: "write" })
          await this.options.adapters.clipboard.write({ type: "text", text })
        },
      },
      notifications: {
        show: async (options) => {
          await ensure({ capability: "notification", operation: "show" })
          await this.options.adapters.notifications.show(options)
        },
      },
      system: {
        openUrl: async (url) => {
          await ensure({ capability: "system:open-url", operation: "open", requestedScope: url })
          await this.options.adapters.system.openUrl(url)
        },
        openPath: async (targetPath) => {
          await ensure({
            capability: "system:open-path",
            operation: "open",
            requestedScope: targetPath,
          })
          await this.options.adapters.system.openPath(targetPath)
        },
        captureScreen: async (options) => {
          await ensure({ capability: "system:capture-screen", operation: "capture" })
          return this.options.adapters.system.captureScreen(pluginId, options)
        },
      },
      log: (...args) => {
        logger.child(`plugin:${pluginId}`).warn(args.map((arg) => String(arg)).join(" "))
      },
    }
  }

  private watchClipboardWithGate(
    pluginId: string,
    gate: CapabilityGatePort,
    invocation: InvocationContext,
    listener: (content: ClipboardContent) => void
  ): () => void {
    let unwatch: (() => void) | undefined
    let cancelled = false

    void gate
      .ensure({
        capability: "clipboard:watch",
        actor: invocation.actor,
        trigger: invocation.trigger,
        operation: "watch",
        signal: invocation.signal,
      })
      .then(() => {
        if (cancelled) return
        unwatch = this.watchClipboard(pluginId, listener)
      })
      .catch((err) => {
        logger.child(`plugin:${pluginId}`).warn("clipboard watch denied", { err })
      })

    return () => {
      cancelled = true
      unwatch?.()
    }
  }

  async disposePlugin(pluginId: string): Promise<void> {
    this.stopClipboardWatchers(pluginId)
    await this.flushStorage(pluginId)
  }

  /** Tear down bridge-level clipboard.watch polling for a plugin. */
  revokeCapability(pluginId: string, capability: string): void {
    if (capability === "clipboard:watch") this.stopClipboardWatchers(pluginId)
  }

  hasClipboardWatchers(pluginId: string): boolean {
    return (this.watchers.get(pluginId)?.size ?? 0) > 0
  }

  clearPluginData(pluginId: string): void {
    const state = this.storage.get(pluginId)
    if (state?.flushTimer) clearTimeout(state.flushTimer)
    this.storage.delete(pluginId)
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

  async readClipboardForHost(): Promise<ClipboardContent | undefined> {
    return this.options.adapters.clipboard.read()
  }

  private createStorageAPI(
    pluginId: string,
    gate: CapabilityGatePort,
    invocation: InvocationContext
  ): StorageAPI {
    const ensure = (operation: string, key?: string) =>
      gate.ensure({
        capability: "storage:plugin",
        actor: invocation.actor,
        trigger: invocation.trigger,
        operation,
        requestedScope: key,
        signal: invocation.signal,
      })

    return {
      get: async <T = unknown>(key: string) => {
        await ensure("get", key)
        const state = await this.loadStorage(pluginId)
        return state.data[key] as T | undefined
      },
      set: async <T = unknown>(key: string, value: T) => {
        await ensure("set", key)
        const state = await this.loadStorage(pluginId)
        state.data[key] = value
        await this.scheduleStorageFlush(pluginId)
      },
      delete: async (key: string) => {
        await ensure("delete", key)
        const state = await this.loadStorage(pluginId)
        delete state.data[key]
        await this.scheduleStorageFlush(pluginId)
      },
      list: async () => {
        await ensure("list")
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

  private stopClipboardWatchers(pluginId: string): void {
    const timers = this.watchers.get(pluginId)
    if (!timers) return
    for (const timer of timers) clearInterval(timer)
    this.watchers.delete(pluginId)
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
          logger.child(`plugin:${pluginId}`).warn("clipboard watch read failed", { err })
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
