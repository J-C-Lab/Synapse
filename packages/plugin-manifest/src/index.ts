// @synapsepkg/plugin-manifest
//
// Shared plugin-manifest contract for Synapse. Owns the manifest TypeScript
// types, the zod validation schema, and engine-compatibility logic so the
// Synapse host (main process) and the plugin CLI validate `synapse.json`
// against a single source of truth.

export {
  CAPABILITIES,
  capabilityDeclarationHash,
  capabilityIds,
  getCapability,
  normalizeCapabilities,
  stableStringify,
} from "./capabilities"

export type { CapabilityDescriptor, CapabilityScopeAdapter, CapabilityTier } from "./capabilities"

export { isEngineCompatible } from "./engine"

export { networkHttpsAdapter } from "./network-scope"

export type { NetworkHttpsRequestedScope, NetworkHttpsScope } from "./network-scope"

export { normalizeLegacyCapabilities } from "./normalize-legacy"

export { manifestSchema, ManifestValidationError, parseManifest } from "./schema"

export type {
  CommandMode,
  JsonSchema,
  ManifestCommand,
  ManifestPreference,
  ManifestPreferenceOption,
  ManifestPreferenceType,
  ManifestTool,
  NormalizedCapability,
  PluginActivationEvent,
  PluginManifest,
  ToolAnnotations,
} from "./types"
