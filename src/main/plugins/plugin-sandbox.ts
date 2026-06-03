/* eslint-disable react/naming-convention-context-name */
import type { PluginModule, View } from "@synapse/plugin-sdk"
import type { PluginBridge } from "./plugin-bridge"
import type {
  DiscoveredPlugin,
  PluginEventRequest,
  PluginInvokeRequest,
  PluginSandboxModule,
} from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import vm from "node:vm"
import { commandInvocation } from "./types"

type TimerCallback = (...args: unknown[]) => void
type SandboxHookPhase = PluginInvokeRequest["phase"] | "dispose"
type SandboxEventPhase = "onClipboardChange"

export class PluginSandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginSandboxError"
  }
}

export interface PluginSandboxOptions {
  bridge: PluginBridge
  loadTimeoutMs?: number
  invokeTimeoutMs?: number
}

interface LoadedPlugin extends PluginSandboxModule {
  sandboxVm: vm.Context
  timers: Set<ReturnType<typeof setTimeout>>
  intervals: Set<ReturnType<typeof setInterval>>
}

interface CommonJSModule {
  exports: unknown
}

interface SandboxHookRequest {
  commandId: string
  phase: SandboxHookPhase
  invocation?: unknown
  searchText?: string
  actionId?: string
  actionPayload?: unknown
}

interface SandboxEventHookRequest {
  phase: SandboxEventPhase
  eventPayload?: unknown
}

const invokeRequestKey = "__synapseInvokeRequest"
const invokeContextKey = "__synapseInvokeContext"
const invokeHookScript = `
(() => {
  const request = globalThis.${invokeRequestKey}
  const ctx = globalThis.${invokeContextKey}
  const handler = module.exports.commands[request.commandId]
  if (request.phase === "run") return handler.run(request.invocation, ctx)
  if (request.phase === "onSearchChange") return handler.onSearchChange(request.searchText, ctx)
  if (request.phase === "onAction") return handler.onAction(request.actionId, request.actionPayload, ctx)
  return handler.dispose(ctx)
})()
`

const eventRequestKey = "__synapseEventRequest"
const eventContextKey = "__synapseEventContext"
const eventHookScript = `
(() => {
  const request = globalThis.${eventRequestKey}
  const ctx = globalThis.${eventContextKey}
  if (request.phase === "onClipboardChange") {
    const handler = module.exports.events && module.exports.events.onClipboardChange
    if (!handler) return undefined
    return handler(request.eventPayload, ctx)
  }
  return undefined
})()
`

// Compiled once: the hook body has no per-call literals (it reads the
// request/ctx from injected globals), so the same Script is reused across
// every invoke. onSearchChange fires on every keystroke, so avoiding a
// recompile per call is a real saving.
const compiledInvokeHookScript = new vm.Script(invokeHookScript, {
  filename: "synapse-plugin:invoke-hook",
})

const compiledEventHookScript = new vm.Script(eventHookScript, {
  filename: "synapse-plugin:event-hook",
})

// P0 isolation is a lightweight compatibility boundary. node:vm lets the host
// curate globals and enforce timeouts, but it is not a strong security sandbox.
export class PluginSandbox {
  private readonly loaded = new Map<string, LoadedPlugin>()
  private readonly loadTimeoutMs: number
  private readonly invokeTimeoutMs: number

  constructor(private readonly options: PluginSandboxOptions) {
    this.loadTimeoutMs = options.loadTimeoutMs ?? 5_000
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 5_000
  }

  async loadPlugin(entry: DiscoveredPlugin): Promise<PluginSandboxModule> {
    if (entry.status !== "valid" || !entry.manifest) {
      throw new PluginSandboxError(`Cannot load plugin with status ${entry.status}`)
    }

    await this.unloadPlugin(entry.pluginId)

    const mainPath = resolveInside(entry.rootDir, entry.manifest.main)
    const code = await fs.readFile(mainPath, "utf-8")
    const moduleObject: CommonJSModule = { exports: {} }
    const runtime = this.options.bridge.createContext(entry.pluginId, entry.manifest)
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const intervals = new Set<ReturnType<typeof setInterval>>()
    const sandboxVm = vm.createContext(
      {
        ...createSandboxGlobals(entry.pluginId, timers, intervals),
        module: moduleObject,
        exports: moduleObject.exports,
        synapse: runtime,
      },
      {
        name: `synapse-plugin:${entry.pluginId}`,
      }
    )
    const script = new vm.Script(
      `(function (module, exports, synapse) {\n${code}\n})(module, exports, synapse)`,
      {
        filename: mainPath,
      }
    )
    script.runInContext(sandboxVm, { timeout: this.loadTimeoutMs })

    const pluginModule = normalizePluginModule(moduleObject.exports)
    const loaded: LoadedPlugin = {
      pluginId: entry.pluginId,
      manifest: entry.manifest,
      module: pluginModule,
      sandboxVm,
      timers,
      intervals,
    }
    this.loaded.set(entry.pluginId, loaded)
    return loaded
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.loaded.get(pluginId)
    if (!plugin) return

    for (const commandId of Object.keys(plugin.module.commands)) {
      await this.disposeCommand(pluginId, commandId)
    }
    for (const timer of plugin.timers) clearTimeout(timer)
    for (const interval of plugin.intervals) clearInterval(interval)
    plugin.timers.clear()
    plugin.intervals.clear()
    this.loaded.delete(pluginId)
    await this.options.bridge.disposePlugin(pluginId)
  }

  async invokeCommand(request: PluginInvokeRequest): Promise<View | void> {
    const plugin = this.loaded.get(request.pluginId)
    if (!plugin) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)

    const handler = plugin.module.commands[request.commandId]
    if (!handler) {
      throw new PluginSandboxError(`Plugin command is not exported: ${request.commandId}`)
    }

    const pluginCtx = this.options.bridge.createContext(request.pluginId, plugin.manifest)
    if (request.phase === "run") {
      return this.withTimeout(
        this.runHookInContext(
          plugin,
          {
            commandId: request.commandId,
            phase: "run",
            invocation: commandInvocation(request.commandId, request.payload),
          },
          pluginCtx
        )
      )
    }
    if (request.phase === "onSearchChange") {
      if (!handler.onSearchChange) return undefined
      return this.withTimeout(
        this.runHookInContext(
          plugin,
          {
            commandId: request.commandId,
            phase: "onSearchChange",
            searchText: String(request.payload ?? ""),
          },
          pluginCtx
        )
      )
    }
    if (!handler.onAction) return undefined
    const action = normalizeActionPayload(request.payload)
    return this.withTimeout(
      this.runHookInContext(
        plugin,
        {
          commandId: request.commandId,
          phase: "onAction",
          actionId: action.actionId,
          actionPayload: action.payload,
        },
        pluginCtx
      )
    )
  }

  async disposeCommand(pluginId: string, commandId: string): Promise<void> {
    const plugin = this.loaded.get(pluginId)
    const handler = plugin?.module.commands[commandId]
    if (!plugin || !handler?.dispose) return
    const pluginCtx = this.options.bridge.createContext(pluginId, plugin.manifest)
    await this.withTimeout(
      this.runHookInContext(plugin, { commandId, phase: "dispose" }, pluginCtx)
    )
  }

  async dispatchEvent(request: PluginEventRequest): Promise<void> {
    const plugin = this.loaded.get(request.pluginId)
    if (!plugin) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)
    if (request.event === "clipboard:change" && !plugin.module.events?.onClipboardChange) return

    const pluginCtx = this.options.bridge.createContext(request.pluginId, plugin.manifest)
    await this.withTimeout(
      this.runEventHookInContext(
        plugin,
        {
          phase: "onClipboardChange",
          eventPayload: request.payload,
        },
        pluginCtx
      )
    )
  }

  getLoadedModule(pluginId: string): PluginSandboxModule | undefined {
    const plugin = this.loaded.get(pluginId)
    if (!plugin) return undefined
    return { pluginId: plugin.pluginId, manifest: plugin.manifest, module: plugin.module }
  }

  private async withTimeout<T>(value: Promise<T> | T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve(value),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PluginSandboxError(`Plugin call exceeded ${this.invokeTimeoutMs}ms`)),
            this.invokeTimeoutMs
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private runHookInContext<T>(
    plugin: LoadedPlugin,
    request: SandboxHookRequest,
    pluginCtx: unknown
  ): Promise<T> | T {
    const sandboxGlobals = plugin.sandboxVm as Record<string, unknown>
    sandboxGlobals[invokeRequestKey] = request
    sandboxGlobals[invokeContextKey] = pluginCtx
    try {
      return compiledInvokeHookScript.runInContext(plugin.sandboxVm, {
        timeout: this.invokeTimeoutMs,
      }) as Promise<T> | T
    } catch (err) {
      if (isVmTimeout(err)) {
        throw new PluginSandboxError(`Plugin call exceeded ${this.invokeTimeoutMs}ms`)
      }
      throw err
    } finally {
      delete sandboxGlobals[invokeRequestKey]
      delete sandboxGlobals[invokeContextKey]
    }
  }

  private runEventHookInContext<T>(
    plugin: LoadedPlugin,
    request: SandboxEventHookRequest,
    pluginCtx: unknown
  ): Promise<T> | T {
    const sandboxGlobals = plugin.sandboxVm as Record<string, unknown>
    sandboxGlobals[eventRequestKey] = request
    sandboxGlobals[eventContextKey] = pluginCtx
    try {
      return compiledEventHookScript.runInContext(plugin.sandboxVm, {
        timeout: this.invokeTimeoutMs,
      }) as Promise<T> | T
    } catch (err) {
      if (isVmTimeout(err)) {
        throw new PluginSandboxError(`Plugin call exceeded ${this.invokeTimeoutMs}ms`)
      }
      throw err
    } finally {
      delete sandboxGlobals[eventRequestKey]
      delete sandboxGlobals[eventContextKey]
    }
  }
}

function createSandboxGlobals(
  pluginId: string,
  timers: Set<ReturnType<typeof setTimeout>>,
  intervals: Set<ReturnType<typeof setInterval>>
): vm.Context {
  return {
    console: {
      log: (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
      error: (...args: unknown[]) => console.error(`[plugin:${pluginId}]`, ...args),
    },
    setTimeout: (handler: TimerCallback, timeout?: number, ...args: unknown[]) => {
      const timer = setTimeout(handler, timeout, ...args)
      timers.add(timer)
      return timer
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer)
      clearTimeout(timer)
    },
    setInterval: (handler: TimerCallback, timeout?: number, ...args: unknown[]) => {
      const interval = setInterval(handler, timeout, ...args)
      intervals.add(interval)
      return interval
    },
    clearInterval: (interval: ReturnType<typeof setInterval>) => {
      intervals.delete(interval)
      clearInterval(interval)
    },
    URL,
    TextEncoder,
    TextDecoder,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    structuredClone,
    crypto: {
      randomUUID: () => globalThis.crypto.randomUUID(),
      getRandomValues: (array: Uint8Array) => globalThis.crypto.getRandomValues(array),
    },
  } as vm.Context
}

function normalizePluginModule(value: unknown): PluginModule {
  if (!value || typeof value !== "object") {
    throw new PluginSandboxError("Plugin entry must export an object")
  }
  const commands = (value as { commands?: unknown }).commands
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    throw new PluginSandboxError("Plugin entry must export a commands object")
  }
  for (const [commandId, handler] of Object.entries(commands)) {
    if (
      !handler ||
      typeof handler !== "object" ||
      typeof (handler as { run?: unknown }).run !== "function"
    ) {
      throw new PluginSandboxError(`Plugin command ${commandId} must export a run function`)
    }
  }
  return value as PluginModule
}

function normalizeActionPayload(payload: unknown): { actionId: string; payload: unknown } {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { actionId?: unknown }).actionId !== "string"
  ) {
    throw new PluginSandboxError("onAction payload must include an actionId")
  }
  return {
    actionId: (payload as { actionId: string }).actionId,
    payload: (payload as { payload?: unknown }).payload,
  }
}

function resolveInside(rootDir: string, relativePath: string): string {
  const root = path.resolve(rootDir)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new PluginSandboxError("Plugin main path escapes the plugin directory")
  }
  return target
}

function isVmTimeout(err: unknown): boolean {
  // node:vm reports a synchronous timeout with this fixed message; there is
  // no error code to match on, so the string check is the documented signal.
  return Boolean(
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string" &&
    /Script execution timed out/.test((err as { message: string }).message)
  )
}
