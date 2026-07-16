/* eslint-disable react/naming-convention-context-name */
import type { PluginModule, ToolResult, View } from "@synapse/plugin-sdk"
import type { PluginBridge } from "./plugin-bridge"
import type {
  DiscoveredPlugin,
  PluginEventRequest,
  PluginInvokeRequest,
  PluginSandboxModule,
  PluginToolInvokeRequest,
  PluginTriggerDispatch,
} from "./types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import vm from "node:vm"
import { logger } from "../logging"
import { CapabilityDenied } from "./capability-gate"
import { PermissionDenied } from "./permissions"
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

/** Command/tool hook exceeded its wall-clock budget (not a plugin defect). */
export class PluginInvocationTimeoutError extends PluginSandboxError {
  constructor(message: string) {
    super(message)
    this.name = "PluginInvocationTimeoutError"
  }
}

export interface PluginSandboxOptions {
  bridge: PluginBridge
  loadTimeoutMs?: number
  invokeTimeoutMs?: number
  /**
   * `run` may await JIT capability prompts — keep this generous so a slow
   * user click does not trip the 5s hook budget used by search/action hooks.
   */
  commandRunTimeoutMs?: number
  /** Tools may run longer than UI command hooks; defaults to 30s. */
  toolInvokeTimeoutMs?: number
}

interface LoadedPlugin extends PluginSandboxModule {
  sandboxVm: vm.Context
  timers: Set<ReturnType<typeof setTimeout>>
  intervals: Set<ReturnType<typeof setInterval>>
  capabilityAbort: AbortController
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

const toolRequestKey = "__synapseToolRequest"
const toolContextKey = "__synapseToolContext"
const toolHookScript = `
(() => {
  const request = globalThis.${toolRequestKey}
  const ctx = globalThis.${toolContextKey}
  const handler = module.exports.tools[request.toolName]
  return handler(request.input, ctx)
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

const compiledToolHookScript = new vm.Script(toolHookScript, {
  filename: "synapse-plugin:tool-hook",
})

// P0 isolation is a lightweight compatibility boundary. node:vm lets the host
// curate globals and enforce timeouts, but it is not a strong security sandbox.
export class PluginSandbox {
  private readonly loaded = new Map<string, LoadedPlugin>()
  private readonly loadTimeoutMs: number
  private readonly invokeTimeoutMs: number
  private readonly commandRunTimeoutMs: number
  private readonly toolInvokeTimeoutMs: number

  constructor(private readonly options: PluginSandboxOptions) {
    this.loadTimeoutMs = options.loadTimeoutMs ?? 5_000
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 5_000
    this.commandRunTimeoutMs = options.commandRunTimeoutMs ?? 120_000
    this.toolInvokeTimeoutMs = options.toolInvokeTimeoutMs ?? 30_000
  }

  async loadPlugin(entry: DiscoveredPlugin): Promise<PluginSandboxModule> {
    if (entry.status !== "valid" || !entry.manifest) {
      throw new PluginSandboxError(`Cannot load plugin with status ${entry.status}`)
    }

    await this.unloadPlugin(entry.pluginId)

    const mainPath = resolveInside(entry.rootDir, entry.manifest.main)
    const code = await fs.readFile(mainPath, "utf-8")
    const moduleObject: CommonJSModule = { exports: {} }
    const runtime = this.options.bridge.createContext(entry.pluginId, entry.manifest, {
      source: "runless",
      actor: "user",
      trigger: "plugin:load",
    })
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
      capabilityAbort: new AbortController(),
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

    const pluginCtx = this.options.bridge.createContext(request.pluginId, plugin.manifest, {
      source: "runless",
      actor: "user",
      trigger: `command:${request.commandId}`,
      signal: plugin.capabilityAbort.signal,
    })
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
        ),
        this.commandRunTimeoutMs
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

  async invokeTool(request: PluginToolInvokeRequest): Promise<ToolResult> {
    const plugin = this.loaded.get(request.pluginId)
    if (!plugin) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)

    const handler = plugin.module.tools?.[request.toolName]
    if (typeof handler !== "function") {
      throw new PluginSandboxError(`Plugin tool is not exported: ${request.toolName}`)
    }

    // A per-call controller fires on timeout; it is linked with the caller's
    // signal so either source cancels the running tool.
    const controller = new AbortController()
    const signal = linkAbortSignals(
      controller.signal,
      linkAbortSignals(plugin.capabilityAbort.signal, request.options.signal)
    )
    const timer = setTimeout(() => {
      controller.abort(new PluginSandboxError(`Plugin tool exceeded ${this.toolInvokeTimeoutMs}ms`))
    }, this.toolInvokeTimeoutMs)

    const toolCtx = this.options.bridge.createToolContext(request.pluginId, plugin.manifest, {
      caller: request.options.caller,
      signal,
      progress: request.options.progress,
      capabilities: request.capabilities,
      toolName: request.toolName,
    })

    try {
      const result = await Promise.race([
        Promise.resolve(
          this.runToolHookInContext(
            plugin,
            { toolName: request.toolName, input: request.input },
            toolCtx
          )
        ),
        rejectWhenAborted(signal),
      ])
      return normalizeToolResult(result)
    } catch (err) {
      // Infrastructure (timeout/cancel/bad-shape) and policy (permission)
      // errors propagate; a fault inside the handler is surfaced to the model
      // as an error result rather than throwing — see ToolHandler docs.
      if (
        err instanceof PluginSandboxError ||
        err instanceof PermissionDenied ||
        err instanceof CapabilityDenied
      )
        throw err
      return {
        content: [{ type: "text", text: errorMessage(err) }],
        isError: true,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async disposeCommand(pluginId: string, commandId: string): Promise<void> {
    const plugin = this.loaded.get(pluginId)
    const handler = plugin?.module.commands[commandId]
    if (!plugin || !handler?.dispose) return
    const pluginCtx = this.options.bridge.createContext(pluginId, plugin.manifest, {
      source: "runless",
      actor: "user",
      trigger: `command:${commandId}:dispose`,
    })
    await this.withTimeout(
      this.runHookInContext(plugin, { commandId, phase: "dispose" }, pluginCtx)
    )
  }

  async dispatchEvent(request: PluginEventRequest): Promise<void> {
    const plugin = this.loaded.get(request.pluginId)
    if (!plugin) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)
    if (request.event === "clipboard:change" && !plugin.module.events?.onClipboardChange) return

    const pluginCtx = this.options.bridge.createContext(request.pluginId, plugin.manifest, {
      source: "runless",
      actor: "background",
      trigger: "clipboard:change",
      signal: plugin.capabilityAbort.signal,
    })
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

  async dispatchTrigger(request: PluginTriggerDispatch): Promise<void> {
    const plugin = this.loaded.get(request.pluginId)
    if (!plugin) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)

    const exportName = request.handler.slice("triggers.".length)
    const handler = plugin.module.triggers?.[exportName]
    if (typeof handler !== "function") return

    const pluginCtx = this.options.bridge.createContext(request.pluginId, plugin.manifest, {
      source: "runless",
      actor: "background",
      trigger: request.trigger,
      signal: request.signal,
      invocationId: request.invocationId,
    })
    await this.withTimeout(Promise.resolve(handler(request.event, pluginCtx)))
  }

  getLoadedModule(pluginId: string): PluginSandboxModule | undefined {
    const plugin = this.loaded.get(pluginId)
    if (!plugin) return undefined
    return { pluginId: plugin.pluginId, manifest: plugin.manifest, module: plugin.module }
  }

  /**
   * Abort background work for a loaded plugin after a capability revoke.
   *
   * **Intentionally plugin-wide, not capability-scoped:** the `capability`
   * argument is reserved for future per-capability hooks; today revoke always:
   * - aborts the plugin's shared `capabilityAbort` signal (cancels in-flight tools)
   * - clears **all** sandbox `setTimeout` / `setInterval` handles for the plugin
   *
   * Rationale: sandbox timers are not tagged with a capability id; leaving them
   * running after revoke risks re-arming revoked access. The trade-off is that
   * revoking e.g. `clipboard:watch` also kills unrelated background intervals
   * and elevated tool calls still in progress.
   */
  abortPluginCapability(pluginId: string, capability: string): void {
    const plugin = this.loaded.get(pluginId)
    if (!plugin) return
    void capability // reserved for per-capability teardown in later specs

    plugin.capabilityAbort.abort()
    plugin.capabilityAbort = new AbortController()

    for (const timer of plugin.timers) clearTimeout(timer)
    for (const interval of plugin.intervals) clearInterval(interval)
    plugin.timers.clear()
    plugin.intervals.clear()
  }

  /** Test seam: counts timers/intervals the sandbox tracks for a loaded plugin. */
  trackedWorkCounts(pluginId: string): { timers: number; intervals: number } {
    const plugin = this.loaded.get(pluginId)
    if (!plugin) return { timers: 0, intervals: 0 }
    return { timers: plugin.timers.size, intervals: plugin.intervals.size }
  }

  private async withTimeout<T>(
    value: Promise<T> | T,
    timeoutMs = this.invokeTimeoutMs
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve(value),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PluginInvocationTimeoutError(`Plugin call exceeded ${timeoutMs}ms`)),
            timeoutMs
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
        // The vm's synchronous watchdog and withTimeout's async wall-clock
        // watchdog describe the same public failure: a command hook exceeded
        // its invocation budget. Keep the typed error stable regardless of
        // which watchdog wins under CPU contention.
        throw new PluginInvocationTimeoutError(`Plugin call exceeded ${this.invokeTimeoutMs}ms`)
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

  private runToolHookInContext(
    plugin: LoadedPlugin,
    request: { toolName: string; input: unknown },
    toolCtx: unknown
  ): Promise<ToolResult> | ToolResult {
    const sandboxGlobals = plugin.sandboxVm as Record<string, unknown>
    sandboxGlobals[toolRequestKey] = request
    sandboxGlobals[toolContextKey] = toolCtx
    try {
      // The vm timeout only bounds synchronous execution; the async portion is
      // bounded by the AbortController/timeout in invokeTool.
      return compiledToolHookScript.runInContext(plugin.sandboxVm, {
        timeout: this.toolInvokeTimeoutMs,
      }) as Promise<ToolResult> | ToolResult
    } catch (err) {
      if (isVmTimeout(err)) {
        throw new PluginSandboxError(`Plugin tool exceeded ${this.toolInvokeTimeoutMs}ms`)
      }
      throw err
    } finally {
      delete sandboxGlobals[toolRequestKey]
      delete sandboxGlobals[toolContextKey]
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
      log: (...args: unknown[]) =>
        logger.child(`plugin:${pluginId}`).info(args.map((arg) => String(arg)).join(" ")),
      warn: (...args: unknown[]) =>
        logger.child(`plugin:${pluginId}`).warn(args.map((arg) => String(arg)).join(" ")),
      error: (...args: unknown[]) =>
        logger.child(`plugin:${pluginId}`).error(args.map((arg) => String(arg)).join(" ")),
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
  const tools = (value as { tools?: unknown }).tools
  if (tools !== undefined) {
    if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
      throw new PluginSandboxError("Plugin entry tools must be an object")
    }
    for (const [toolName, handler] of Object.entries(tools)) {
      if (typeof handler !== "function") {
        throw new PluginSandboxError(`Plugin tool ${toolName} must be a function`)
      }
    }
  }
  return value as PluginModule
}

/**
 * Combine the per-call timeout signal with an optional caller signal so either
 * source can cancel the tool. Prefers the native `AbortSignal.any` and falls
 * back to manual wiring on older runtimes.
 */
function linkAbortSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary
  if (typeof AbortSignal.any === "function") return AbortSignal.any([primary, secondary])

  const controller = new AbortController()
  if (primary.aborted) controller.abort(primary.reason)
  else if (secondary.aborted) controller.abort(secondary.reason)
  else {
    primary.addEventListener("abort", () => controller.abort(primary.reason), { once: true })
    secondary.addEventListener("abort", () => controller.abort(secondary.reason), { once: true })
  }
  return controller.signal
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      const reason = signal.reason
      reject(reason instanceof Error ? reason : new PluginSandboxError("Plugin tool was cancelled"))
    }
    if (signal.aborted) fail()
    else signal.addEventListener("abort", fail, { once: true })
  })
}

// Errors thrown inside the vm belong to a different realm, so `instanceof
// Error` is unreliable here. Duck-type the message instead so the model sees
// "nope" rather than "Error: nope".
function errorMessage(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message
  }
  return String(err)
}

function normalizeToolResult(value: unknown): ToolResult {
  if (!value || typeof value !== "object") {
    throw new PluginSandboxError("Plugin tool must return a ToolResult object")
  }
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) {
    throw new PluginSandboxError("Plugin tool result must include a content array")
  }
  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      typeof (block as { type?: unknown }).type !== "string"
    ) {
      throw new PluginSandboxError("Plugin tool result content blocks must have a string type")
    }
  }
  return value as ToolResult
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
