import type { LocalizedString } from "@synapse/plugin-sdk"

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

/**
 * A JSON Schema (draft 2020-12 subset) describing a tool's input or output.
 * Synapse requires the top level to be an object schema, matching the MCP
 * convention for `tool.inputSchema` / `tool.outputSchema`. Arbitrary nested
 * JSON Schema keywords are permitted via the index signature.
 */
export interface JsonSchema {
  type: "object"
  properties?: Record<string, unknown>
  required?: string[]
  description?: string
  [keyword: string]: unknown
}

/**
 * MCP-style behavioural hints. They are advisory metadata for the model and,
 * in Synapse, drive the approval flow (see the AI foundation design): a
 * `readOnlyHint` tool may auto-run, while `destructiveHint` /
 * `requiresConfirmation` force a human approval step.
 */
export interface ToolAnnotations {
  /** No side effects — safe to auto-run without confirmation. */
  readOnlyHint?: boolean
  /** May make irreversible changes — force human approval. */
  destructiveHint?: boolean
  /** Repeating the call with the same args has no additional effect. */
  idempotentHint?: boolean
  /** Always require human approval, overriding the default for this tool. */
  requiresConfirmation?: boolean
}

/**
 * A headless tool a plugin exposes to AI agents. Fields map 1:1 onto MCP's
 * `tool` shape so plugin tools can be surfaced over MCP with near-zero
 * translation. The model-visible name is `${pluginId}/${name}`.
 */
export interface ManifestTool {
  /** LLM-visible name, unique within the plugin. Namespaced as `${pluginId}/${name}`. */
  name: string
  /** Human-facing title (localised, display only). */
  title?: LocalizedString
  /**
   * Description the model reads to decide when/how to call the tool. Write it
   * for the model (English, state purpose and boundaries) — call quality
   * depends on it. Not localised.
   */
  description: string
  /** Input JSON Schema (= MCP `tool.inputSchema`). */
  inputSchema: JsonSchema
  /** Output JSON Schema (= MCP `tool.outputSchema`), when results are structured. */
  outputSchema?: JsonSchema
  /** Behavioural hints driving approval and UI. */
  annotations?: ToolAnnotations
  /**
   * Permission strings this tool needs. Must be a subset of the plugin's
   * top-level `permissions` (enforced at validation and at runtime).
   */
  permissions?: string[]
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
  engines: { synapse: string }
  main: string
  contributes: {
    activationEvents?: PluginActivationEvent[]
    commands: ManifestCommand[]
    preferences?: ManifestPreference[]
    tools?: ManifestTool[]
  }
  permissions: string[]
}
