import type { CommandInvocation, LocalizedString, PluginModule, View } from "@deskit/plugin-sdk"

export const PLUGIN_HOST_VERSION = "0.1.0"

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

export type CommandMode = "view" | "no-view"

export interface ManifestCommand {
  id: string
  title: LocalizedString
  subtitle?: LocalizedString
  keywords?: string[]
  mode: CommandMode
  icon?: string
}

export type ManifestPreferenceType = "text" | "number" | "checkbox" | "select"

export interface ManifestPreferenceOption {
  value: string
  label: LocalizedString
}

export interface ManifestPreference {
  id: string
  type: ManifestPreferenceType
  label: LocalizedString
  default?: unknown
  options?: ManifestPreferenceOption[]
}

export interface PluginManifest {
  $schema?: string
  id: string
  name: string
  displayName: LocalizedString
  description: LocalizedString
  version: string
  author: string
  icon?: string
  engines: { deskit: string }
  main: string
  contributes: {
    commands: ManifestCommand[]
    preferences?: ManifestPreference[]
  }
  permissions: string[]
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
