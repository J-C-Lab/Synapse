import type { LocalizedString } from "@deskit/plugin-sdk"

export type CommandMode = "view" | "no-view"

export type PluginActivationEvent = "clipboard:change"

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
    activationEvents?: PluginActivationEvent[]
    commands: ManifestCommand[]
    preferences?: ManifestPreference[]
  }
  permissions: string[]
}
