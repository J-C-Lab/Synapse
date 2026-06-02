// @deskit/plugin-manifest
//
// Shared plugin-manifest contract for DesKit. Owns the manifest TypeScript
// types, the zod validation schema, and engine-compatibility logic so the
// DesKit host (main process) and the plugin CLI validate `deskit.json`
// against a single source of truth.

export { isEngineCompatible } from "./engine"

export { manifestSchema, ManifestValidationError, parseManifest } from "./schema"

export type {
  CommandMode,
  ManifestCommand,
  ManifestPreference,
  ManifestPreferenceOption,
  ManifestPreferenceType,
  PluginActivationEvent,
  PluginManifest,
} from "./types"
