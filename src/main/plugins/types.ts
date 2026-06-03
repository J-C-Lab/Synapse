// Manifest types live in the shared @synapse/plugin-manifest package so the
// host and the plugin CLI validate `synapse.json` against one source of truth.
// Imported for local use below and re-exported so existing `./types` imports
// across the main process keep working unchanged.
import type {
  CommandMode,
  ManifestCommand,
  ManifestPreference,
  ManifestPreferenceOption,
  ManifestPreferenceType,
  PluginActivationEvent,
  PluginManifest,
} from "@synapse/plugin-manifest"

import type {
  ClipboardContent,
  CommandInvocation,
  LocalizedString,
  PluginModule,
  View,
} from "@synapse/plugin-sdk"

export type {
  CommandMode,
  ManifestCommand,
  ManifestPreference,
  ManifestPreferenceOption,
  ManifestPreferenceType,
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

export interface PluginSandboxModule {
  pluginId: string
  manifest: PluginManifest
  module: PluginModule
}

export interface PluginSandboxRuntime {
  loadPlugin: (entry: DiscoveredPlugin) => Promise<PluginSandboxModule>
  unloadPlugin: (pluginId: string) => Promise<void>
  invokeCommand: (request: PluginInvokeRequest) => Promise<View | void>
  disposeCommand: (pluginId: string, commandId: string) => Promise<void>
  dispatchEvent: (request: PluginEventRequest) => Promise<void>
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
