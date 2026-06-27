import type { FsPathScope, NormalizedCapability } from "@synapse/plugin-manifest"
import type {
  ClipboardContent,
  NetworkRequestInit,
  NotificationAPI,
  PluginContext,
  StorageAPI,
  SystemAPI,
  ToolCaller,
  ToolContext,
} from "@synapse/plugin-sdk"
import type {
  BudgetBreakerPort,
  CapabilityActor,
  CapabilityGatePort,
  CapabilityRequest,
} from "./capability-gate"
import type { CapabilityGovernance } from "./capability-governance"
import type { NetworkFetcher } from "./network-fetcher"
import type { PluginManifest, PluginSourceKind } from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import {
  getCapability,
  mergeDeclaredWithTriggerUses,
  patternForRootId,
} from "@synapse/plugin-manifest"
import { logger } from "../logging"
import { CapabilityGate as CapabilityGateImpl } from "./capability-gate"
import {
  buildGrantIdentity,
  callerToActor,
  createCapabilityGovernance,
} from "./capability-governance"
import { readVerifiedText, resolveVerifiedAbsolutePath } from "./fs-path-resolver"
import { createNetworkFetcher } from "./network-fetcher"

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
  invocationId?: string
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
  /** Trigger-origin budget breaker wired from the host trigger subsystem. */
  budgetBreaker?: BudgetBreakerPort
  /** Shared clipboard poll hub — bridge `watch()` registers here instead of its own timer. */
  registerClipboardListener?: (
    key: string,
    listener: (content: ClipboardContent) => void
  ) => () => void
}

/** Inputs the host supplies when building a `ToolContext` for one tool call. */
export interface ToolContextOptions {
  caller: ToolCaller
  signal: AbortSignal
  progress?: (pct: number, message?: string) => void
  /** Tool-declared capabilities; gates the context to this subset when present. */
  capabilities?: readonly NormalizedCapability[]
  toolName: string
}

/** The capability slice shared by command and tool contexts. */
type PluginCapabilities = Pick<
  PluginContext,
  "storage" | "clipboard" | "notifications" | "system" | "network" | "fs" | "log"
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
  // Per-plugin set of in-flight network fetchers, one per invocation. Held so a
  // network:https revoke (or disposePlugin) can abortAll() every running fetch.
  private readonly fetchers = new Map<string, Set<NetworkFetcher>>()
  private readonly storageFlushMs: number
  private readonly clipboardPollMs: number
  private readonly governance: CapabilityGovernance
  private readonly sourceKindFor: (pluginId: string) => PluginSourceKind
  private readonly createGate?: PluginBridgeOptions["createGate"]
  private readonly budgetBreaker?: BudgetBreakerPort
  private readonly registerClipboardListener?: PluginBridgeOptions["registerClipboardListener"]
  private readonly clipboardWatchUnlisten = new Map<string, Set<() => void>>()

  constructor(private readonly options: PluginBridgeOptions) {
    this.storageFlushMs = options.storageFlushMs ?? 250
    this.clipboardPollMs = options.clipboardPollMs ?? 500
    this.governance =
      options.governance ?? createCapabilityGovernance({ userDataDir: options.userDataDir })
    this.sourceKindFor = options.sourceKindFor ?? (() => "user")
    this.createGate = options.createGate
    this.budgetBreaker = options.budgetBreaker
    this.registerClipboardListener = options.registerClipboardListener
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
      ...this.createCapabilities(pluginId, manifest, gate, invocation),
    }
  }

  /**
   * Build a headless `ToolContext` for one tool invocation. Reuses the same
   * permission-gated capabilities as commands, drops `locale`/`theme` (tools
   * have no UI), and adds `caller`/`signal`/`progress`. When the tool declares
   * its own `capabilities`, the gate is restricted to that subset.
   */
  createToolContext(
    pluginId: string,
    manifest: PluginManifest,
    options: ToolContextOptions
  ): ToolContext {
    const gate = this.gateFor(pluginId, manifest, options.capabilities)
    const invocation: InvocationContext = {
      actor: callerToActor(options.caller),
      trigger: `tool:${options.toolName}`,
      signal: options.signal,
    }

    return {
      pluginId,
      preferences: this.resolvePreferences(pluginId, manifest),
      ...this.createCapabilities(pluginId, manifest, gate, invocation),
      caller: options.caller,
      signal: options.signal,
      progress: options.progress,
    }
  }

  private gateFor(
    pluginId: string,
    manifest: PluginManifest,
    declaredCapabilities: readonly NormalizedCapability[] = mergeDeclaredWithTriggerUses(
      manifest.capabilities,
      manifest.triggers
    )
  ): CapabilityGatePort {
    const sourceKind = this.sourceKindFor(pluginId)
    if (this.createGate) {
      return this.createGate(
        pluginId,
        { ...manifest, capabilities: [...declaredCapabilities] },
        sourceKind
      )
    }

    const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
    return new CapabilityGateImpl({
      identity,
      declared: [...declaredCapabilities],
      grants: this.governance.grants,
      prompt: this.governance.prompt,
      approve: this.governance.approve,
      audit: this.governance.audit,
      budgetBreaker: this.budgetBreaker,
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
    manifest: PluginManifest,
    gate: CapabilityGatePort,
    invocation: InvocationContext
  ): PluginCapabilities {
    const ensure = (
      request: Omit<CapabilityRequest, "actor" | "trigger" | "signal" | "invocationId">
    ) =>
      gate.ensure({
        ...request,
        actor: invocation.actor,
        trigger: invocation.trigger,
        signal: invocation.signal,
        invocationId: invocation.invocationId,
      })

    // The fetcher runs its own gate.ensure inside fetch(), so network needs no
    // separate ensure() wrapper here. Track it per-plugin for revoke teardown.
    const fetcher = createNetworkFetcher({
      gate,
      actor: invocation.actor,
      trigger: invocation.trigger,
      pluginId,
      invocationId: invocation.invocationId,
    })
    this.registerFetcher(pluginId, fetcher)

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
          // system:open-url is unscoped, so the gate rejects a requestedScope.
          // Fold the URL into the operation instead — capability-audit sanitizes
          // it to an origin, preserving forensic visibility without leaking paths.
          await ensure({ capability: "system:open-url", operation: `open ${url}` })
          await this.options.adapters.system.openUrl(url)
        },
        openPath: async (targetPath) => {
          // system:open-path is unscoped; carry the path in the operation so the
          // audit trail records what was opened (sanitized to a basename).
          await ensure({
            capability: "system:open-path",
            operation: `open ${targetPath}`,
          })
          await this.options.adapters.system.openPath(targetPath)
        },
        captureScreen: async (options) => {
          await ensure({ capability: "system:capture-screen", operation: "capture" })
          return this.options.adapters.system.captureScreen(pluginId, options)
        },
      },
      network: {
        fetch: (url, init) => fetcher.fetch(url, withInvocationSignal(init, invocation.signal)),
        fetchStream: (url, init) =>
          fetcher.fetchStream(url, withInvocationSignal(init, invocation.signal)),
      },
      fs: this.createFsAPI(pluginId, manifest, ensure),
      log: (...args) => {
        logger.child(`plugin:${pluginId}`).warn(args.map((arg) => String(arg)).join(" "))
      },
    }
  }

  private createFsAPI(
    pluginId: string,
    manifest: PluginManifest,
    ensure: (
      request: Omit<CapabilityRequest, "actor" | "trigger" | "signal" | "invocationId">
    ) => Promise<void>
  ): PluginContext["fs"] {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const pathScopes = pathScopesFromManifest(manifest)

    return {
      resolvePath: async (rootId, relativePath) => {
        await ensure({
          capability: "fs:resolvePath",
          operation: "resolve",
          requestedScope: { rootId, relativePath },
        })
        const pattern = patternForRootId(rootId, pathScopes)
        if (!pattern) throw new Error(`Unknown fs rootId for ${pluginId}: ${rootId}`)
        return resolveVerifiedAbsolutePath(homeDir, pattern, relativePath)
      },
      readText: async (rootId, relativePath) => {
        await ensure({
          capability: "fs:read",
          operation: "read",
          requestedScope: { rootId, relativePath },
        })
        const pattern = patternForRootId(rootId, pathScopes)
        if (!pattern) throw new Error(`Unknown fs rootId for ${pluginId}: ${rootId}`)
        return readVerifiedText(homeDir, pattern, relativePath)
      },
    }
  }

  private registerFetcher(pluginId: string, fetcher: NetworkFetcher): void {
    let set = this.fetchers.get(pluginId)
    if (!set) {
      set = new Set()
      this.fetchers.set(pluginId, set)
    }
    set.add(fetcher)
  }

  /** Abort + drop every tracked network fetcher for a plugin (revoke teardown). */
  private abortFetchers(pluginId: string): void {
    const set = this.fetchers.get(pluginId)
    if (!set) return
    for (const fetcher of set) fetcher.abortAll()
    this.fetchers.delete(pluginId)
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
    this.abortFetchers(pluginId)
    await this.flushStorage(pluginId)
  }

  /** Tear down bridge-level resources for a revoked capability. */
  revokeCapability(pluginId: string, capability: string): void {
    if (capability === "clipboard:watch") this.stopClipboardWatchers(pluginId)
    // Abort every in-flight HTTPS fetch so a revoke cancels live egress.
    if (capability === "network:https") this.abortFetchers(pluginId)
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
    // storage:plugin is unscoped, so the gate rejects a requestedScope. The
    // per-key value is folded into the operation suffix for audit context
    // instead (keys aren't secrets; capability-audit still scrubs the string).
    const ensure = (operation: string, key?: string) =>
      gate.ensure({
        capability: "storage:plugin",
        actor: invocation.actor,
        trigger: invocation.trigger,
        operation: key === undefined ? operation : `${operation} ${key}`,
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
    const hubUnlisteners = this.clipboardWatchUnlisten.get(pluginId)
    if (hubUnlisteners) {
      for (const unlisten of hubUnlisteners) unlisten()
      this.clipboardWatchUnlisten.delete(pluginId)
    }
    const timers = this.watchers.get(pluginId)
    if (!timers) return
    for (const timer of timers) clearInterval(timer)
    this.watchers.delete(pluginId)
  }

  private watchClipboard(
    pluginId: string,
    listener: (content: ClipboardContent) => void
  ): () => void {
    if (this.registerClipboardListener) {
      const key = `bridge:${pluginId}:${Math.random().toString(36).slice(2)}`
      const unlisten = this.registerClipboardListener(key, listener)
      let unlisteners = this.clipboardWatchUnlisten.get(pluginId)
      if (!unlisteners) {
        unlisteners = new Set()
        this.clipboardWatchUnlisten.set(pluginId, unlisteners)
      }
      unlisteners.add(unlisten)
      return () => {
        unlisten()
        unlisteners!.delete(unlisten)
        if (unlisteners!.size === 0) this.clipboardWatchUnlisten.delete(pluginId)
      }
    }

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

/**
 * Merge the invocation's AbortSignal with the caller's `init.signal` so host-side
 * cancellation (tool timeout / plugin reload) also aborts the fetch. When the
 * caller supplied no signal, just pin the invocation signal onto the init.
 */
function withInvocationSignal(
  init: NetworkRequestInit | undefined,
  invocationSignal: AbortSignal | undefined
): NetworkRequestInit | undefined {
  if (!invocationSignal) return init
  if (!init?.signal) return { ...init, signal: invocationSignal }
  return { ...init, signal: AbortSignal.any([invocationSignal, init.signal]) }
}

function pathScopesFromManifest(manifest: PluginManifest): FsPathScope[] {
  const scopes: FsPathScope[] = []
  for (const cap of mergeDeclaredWithTriggerUses(manifest.capabilities, manifest.triggers)) {
    if (cap.scope && getCapability(cap.id)?.scopeEnforced) {
      scopes.push(cap.scope as FsPathScope)
    }
  }
  for (const trigger of manifest.triggers ?? []) {
    if (trigger.type === "fs.watch") scopes.push({ paths: trigger.scope.paths })
  }
  return scopes
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
