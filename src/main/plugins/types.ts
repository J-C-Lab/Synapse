// Manifest types live in the shared @synapse/plugin-manifest package so the
// host and the plugin CLI validate `synapse.json` against one source of truth.
// Imported for local use below and re-exported so existing `./types` imports
// across the main process keep working unchanged.
import type {
  AgentTriggerBudget,
  CommandMode,
  ManifestCommand,
  ManifestPreference,
  ManifestPreferenceOption,
  ManifestPreferenceType,
  ManifestTool,
  NormalizedCapability,
  PluginActivationEvent,
  PluginManifest,
  TriggerUse,
} from "@synapse/plugin-manifest"

import type {
  ClipboardContent,
  CommandInvocation,
  LocalizedString,
  PluginModule,
  ToolCaller,
  ToolResult,
  View,
} from "@synapse/plugin-sdk"

export type {
  CommandMode,
  ManifestCommand,
  ManifestPreference,
  ManifestPreferenceOption,
  ManifestPreferenceType,
  ManifestTool,
  PluginActivationEvent,
  PluginManifest,
}

export const PLUGIN_HOST_VERSION = "0.2.0"

export type PluginSourceKind = "builtin" | "user" | "dev"

export interface PluginSource {
  kind: PluginSourceKind
  priority: number
}

export const pluginSourcePriority: Record<PluginSourceKind, number> = {
  builtin: 3,
  user: 2,
  dev: 1,
}

export type DiscoveredPluginStatus = "valid" | "invalid" | "shadowed"

export interface DiscoveredPlugin {
  pluginId: string
  rootDir: string
  source: PluginSource
  status: DiscoveredPluginStatus
  manifest?: PluginManifest
  error?: string
  shadowedBy?: PluginSourceKind
}

export type PluginRuntimeStatus = "active" | "disabled" | "invalid" | "crashed" | "shadowed"

export interface PluginRegistryEntry {
  pluginId: string
  rootDir: string
  source: PluginSource
  status: PluginRuntimeStatus
  manifest?: PluginManifest
  preferences?: Record<string, unknown>
  error?: string
  shadowedBy?: PluginSourceKind
  loadedAt?: number
}

export interface PluginCommandResult {
  kind: "plugin-command"
  pluginId: string
  commandId: string
  title: LocalizedString
  subtitle?: LocalizedString
  icon?: string
  mode: CommandMode
  score: number
  matches: number[]
}

export type PluginInvokePhase = "run" | "onSearchChange" | "onAction"

export interface PluginInvokeRequest {
  pluginId: string
  commandId: string
  phase: PluginInvokePhase
  payload?: unknown
}

export interface PluginEventRequest {
  pluginId: string
  event: "clipboard:change"
  payload: { content: ClipboardContent }
}

export interface PluginTriggerDispatch {
  pluginId: string
  triggerId: string
  /** Capability-gate trigger label, e.g. "timer:t". */
  trigger: string
  /** Manifest handler path, e.g. "triggers.onTick". */
  handler: string
  invocationId: string
  event: unknown
  signal: AbortSignal
}

export interface PluginAgentTriggerDispatchRequest {
  pluginId: string
  triggerId: string
  /** Capability-gate trigger label, e.g. "fs.watch:downloads". */
  trigger: string
  invocationId: string
  event: unknown
  signal: AbortSignal
  allowedUses: TriggerUse[]
  agent: AgentTriggerBudget
}

export interface PluginAgentTriggerDispatch {
  (request: PluginAgentTriggerDispatchRequest): Promise<void>
}

export interface PluginSandboxModule {
  pluginId: string
  manifest: PluginManifest
  module: PluginModule
}

/** Options every tool invocation carries through host → sandbox. */
export interface ToolInvocationOptions {
  /** Where the call came from (built-in agent / external MCP / user). */
  caller: ToolCaller
  /** How the execution tool passed approval (auto vs user-confirmed ask). */
  executionAuditDecision?: "allow" | "approved"
  /** Caller-supplied cancellation. The sandbox links it with its own timeout. */
  signal?: AbortSignal
  /** Progress sink forwarded to the tool's `ctx.progress`. */
  progress?: (pct: number, message?: string) => void
}

/** What the sandbox needs to execute one tool handler. */
export interface PluginToolInvokeRequest {
  pluginId: string
  toolName: string
  input: unknown
  /**
   * Tool-declared capabilities. When set, the tool's `ToolContext` is gated to
   * this subset (least privilege); when omitted it inherits the plugin's full
   * capability set.
   */
  capabilities?: NormalizedCapability[]
  options: ToolInvocationOptions
}

/** A manifest tool of an active plugin, addressable by its `${pluginId}/${name}`. */
export interface RegisteredToolDescriptor {
  fqName: string
  pluginId: string
  manifestTool: ManifestTool
}

/** A registered tool plus a bound runner — the public shape AI callers consume. */
export interface RegisteredTool extends RegisteredToolDescriptor {
  run: (input: unknown, options: ToolInvocationOptions) => Promise<ToolResult>
}

export interface PluginSandboxRuntime {
  loadPlugin: (entry: DiscoveredPlugin) => Promise<PluginSandboxModule>
  unloadPlugin: (pluginId: string) => Promise<void>
  invokeCommand: (request: PluginInvokeRequest) => Promise<View | void>
  invokeTool: (request: PluginToolInvokeRequest) => Promise<ToolResult>
  disposeCommand: (pluginId: string, commandId: string) => Promise<void>
  dispatchEvent: (request: PluginEventRequest) => Promise<void>
  dispatchTrigger: (request: PluginTriggerDispatch) => Promise<void>
  abortPluginCapability: (pluginId: string, capability: string) => void
}

/** The canonical model-visible name for a plugin tool. */
export function toolFqName(pluginId: string, toolName: string): string {
  return `${pluginId}/${toolName}`
}

export interface RunPayload {
  initialQuery?: string
}

export function commandInvocation(commandId: string, payload: unknown): CommandInvocation {
  const initialQuery =
    payload &&
    typeof payload === "object" &&
    typeof (payload as RunPayload).initialQuery === "string"
      ? (payload as RunPayload).initialQuery
      : undefined
  return initialQuery ? { commandId, initialQuery } : { commandId }
}
