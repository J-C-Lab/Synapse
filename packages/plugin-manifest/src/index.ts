// @synapsepkg/plugin-manifest
//
// Shared plugin-manifest contract for Synapse. Owns the manifest TypeScript
// types, the zod validation schema, and engine-compatibility logic so the
// Synapse host (main process) and the plugin CLI validate `synapse.json`
// against a single source of truth.

export { isEngineCompatible } from "./engine"

export { manifestSchema, ManifestValidationError, parseManifest } from "./schema"

export type {
  CommandMode,
  JsonSchema,
  ManifestCommand,
  ManifestPreference,
  ManifestPreferenceOption,
  ManifestPreferenceType,
  ManifestTool,
  PluginActivationEvent,
  PluginManifest,
  ToolAnnotations,
} from "./types"
