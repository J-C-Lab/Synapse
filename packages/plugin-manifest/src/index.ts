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

export {
  credentialBrokerAdapter,
  declaredCredentialBrokerScopeContains,
  injectScopesOverlap,
} from "./credential-scope"
export type { CredentialBrokerRequestedScope, CredentialBrokerScope } from "./credential-scope"
export {
  CREDENTIAL_ID_RE,
  credentialDeclarationHash,
  validateCredentialDeclarations,
} from "./credentials"
export type { CredentialDeclaration, CredentialInjectScheme } from "./credentials"
export {
  nextCronFire,
  normalizeCronExpression,
  parseCronExpression,
  summarizeCronExpression,
  validateCronExpression,
} from "./cron-schedule"

export type { CronFields, ValidateCronOptions } from "./cron-schedule"

export { isEngineCompatible } from "./engine"

export {
  DEFAULT_IGNORE_EXTENSIONS,
  defaultWatchEvents,
  expandHomePath,
  fsPathAdapter,
  isRealPathWithinRoot,
  patternForRootId,
  resolveAbsolutePath,
  rootIdForPattern,
  validateSettle,
  validateWatchEvents,
  watchDirectoryForPattern,
} from "./fs-path-scope"

export type {
  FsPathRequestedScope,
  FsPathScope,
  FsWatchEventKind,
  FsWatchSettleConfig,
  FsWatchTriggerScope,
} from "./fs-path-scope"

export {
  BUILTIN_RESERVED_ACCELERATORS,
  canonicalizeAccelerator,
  hotkeyScopeAdapter,
  isReservedAccelerator,
  validateHotkeyTriggerScope,
} from "./hotkey-scope"

export type { HotkeyScope, HotkeyTriggerScope } from "./hotkey-scope"

export { declaredNetworkScopeContains, networkHttpsAdapter } from "./network-scope"

export type { NetworkHttpsRequestedScope, NetworkHttpsScope } from "./network-scope"

export { normalizeLegacyCapabilities } from "./normalize-legacy"

export { validateOAuthEndpoint } from "./oauth-endpoints"

export { manifestSchema, ManifestValidationError, parseManifest } from "./schema"

export {
  mergeDeclaredWithTriggerUses,
  normalizeTriggers,
  triggerDeclarationHash,
  triggerUseToCapability,
  validateTriggers,
} from "./triggers"

export type {
  AgentTriggerBudget,
  ClipboardContentType,
  ClipboardTriggerDeclaration,
  ClipboardTriggerScope,
  FsWatchTriggerDeclaration,
  HotkeyTriggerDeclaration,
  ScheduledTriggerDeclaration,
  TriggerBudget,
  TriggerDeclaration,
  TriggerLimits,
  TriggerType,
  TriggerUse,
} from "./triggers"

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
