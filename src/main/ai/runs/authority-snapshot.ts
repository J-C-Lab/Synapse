import type { NormalizedCapability } from "@synapse/plugin-manifest"
import type { RegisteredToolDescriptor } from "../../plugins/types"
import type { ProviderToolSchema } from "../providers/types"
import type { CanonicalJson } from "./canonical-json"
import {
  declaredCredentialBrokerScopeContains,
  declaredNetworkScopeContains,
  getCapability,
} from "@synapse/plugin-manifest"
import { PLUGIN_HOST_VERSION } from "../../plugins/types"
import { canonicalHash } from "./canonical-json"

// Frozen, comparable authority for a durable run (design §"Freeze exact
// authority"). Two rules this module exists to enforce:
//   - equal hashes are never used to decide a subset relationship — only the
//     structural comparators below decide narrower/wider/incompatible;
//   - a missing or version-mismatched comparator fails closed (never treated
//     as "compatible by default").

export interface FrozenPrincipalSnapshot {
  kind: string
  actor: "user" | "background"
  subjectId?: string
  pluginId?: string
  invocationId?: string
}

export interface FrozenCapabilityGrant {
  id: string
  canonicalScope?: CanonicalJson
  scopeAdapterId: string
  scopeAdapterVersion: string
}

export type ReplayGuarantee = "none" | "dedupe-and-result-replay"

export interface FrozenToolAuthority {
  fqName: string
  safeName: string
  provenance: "host" | "plugin" | "mcp"
  ownerId: string
  ownerVersion: string
  modelSchemaHash: string
  annotationsHash: string
  /** Declared per-tool capability subset, or `undefined` when the tool was
   *  not independently scoped and instead inherits the owning plugin's full
   *  grant at call time. `undefined` must be read as "as wide as whatever
   *  the plugin currently holds", never as "requires nothing". */
  requiredCapabilities?: FrozenCapabilityGrant[]
  invocationAdapterId: string
  invocationAdapterVersion: string
  replayGuarantee: ReplayGuarantee
}

export interface FrozenAuthoritySnapshotV1 {
  schemaVersion: 1
  principal: FrozenPrincipalSnapshot
  capabilities: FrozenCapabilityGrant[]
  tools: FrozenToolAuthority[]
  /** Integrity only — never used to decide a subset/compatibility relationship. */
  integrityHash: string
}

// ---------------------------------------------------------------------------
// Versioned scope comparators for declared-scope-vs-declared-scope
// containment (recovery's "is the current grant narrower than the frozen
// one" question). This is a different operation from
// CapabilityScopeAdapter.contains() in @synapse/plugin-manifest, which
// checks one concrete call against a scope, not scope-vs-scope — network and
// credentials already expose a declared-scope comparator we can reuse
// directly; fs paths and hotkeys do not, so those two are implemented here.

interface ScopeComparator {
  adapterId: string
  adapterVersion: string
  contains: (containerScope: unknown, subsetScope: unknown) => boolean
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function fsPathPatternContains(containerPattern: string, subsetPattern: string): boolean {
  if (containerPattern === subsetPattern) return true
  if (!containerPattern.endsWith("/**")) return false
  const root = containerPattern.slice(0, -3)
  if (subsetPattern.endsWith("/**")) {
    const subsetRoot = subsetPattern.slice(0, -3)
    return subsetRoot === root || subsetRoot.startsWith(`${root}/`)
  }
  return subsetPattern === root || subsetPattern.startsWith(`${root}/`)
}

/** Declared-scope containment for fs:read/fs:write/fs:watch/fs:resolvePath. */
function fsPathDeclaredScopeContains(containerScope: unknown, subsetScope: unknown): boolean {
  const containerPaths =
    typeof containerScope === "object" &&
    containerScope !== null &&
    isStringArray((containerScope as Record<string, unknown>).paths)
      ? (containerScope as { paths: string[] }).paths
      : []
  const subsetPaths =
    typeof subsetScope === "object" &&
    subsetScope !== null &&
    isStringArray((subsetScope as Record<string, unknown>).paths)
      ? (subsetScope as { paths: string[] }).paths
      : []
  return subsetPaths.every((subsetPattern) =>
    containerPaths.some((containerPattern) =>
      fsPathPatternContains(containerPattern, subsetPattern)
    )
  )
}

/** hotkey:global has no meaningful "narrower" scope — one accelerator either
 *  matches or it does not. */
function hotkeyDeclaredScopeContains(containerScope: unknown, subsetScope: unknown): boolean {
  return (
    canonicalHash(containerScope as CanonicalJson) === canonicalHash(subsetScope as CanonicalJson)
  )
}

const SCOPE_COMPARATORS: Readonly<Record<string, ScopeComparator>> = {
  "fs:read": {
    adapterId: "fs-path-declared-v1",
    adapterVersion: "1",
    contains: fsPathDeclaredScopeContains,
  },
  "fs:write": {
    adapterId: "fs-path-declared-v1",
    adapterVersion: "1",
    contains: fsPathDeclaredScopeContains,
  },
  "fs:watch": {
    adapterId: "fs-path-declared-v1",
    adapterVersion: "1",
    contains: fsPathDeclaredScopeContains,
  },
  "fs:resolvePath": {
    adapterId: "fs-path-declared-v1",
    adapterVersion: "1",
    contains: fsPathDeclaredScopeContains,
  },
  "network:https": {
    adapterId: "network-https-declared-v1",
    adapterVersion: "1",
    contains: declaredNetworkScopeContains,
  },
  "credentials:broker": {
    adapterId: "credentials-broker-declared-v1",
    adapterVersion: "1",
    contains: declaredCredentialBrokerScopeContains,
  },
  "hotkey:global": {
    adapterId: "hotkey-declared-v1",
    adapterVersion: "1",
    contains: hotkeyDeclaredScopeContains,
  },
}

function scopeComparatorFor(grant: FrozenCapabilityGrant): ScopeComparator | undefined {
  return SCOPE_COMPARATORS[grant.id]
}

// ---------------------------------------------------------------------------
// Freezing

function freezeCapabilityGrant(capability: NormalizedCapability): FrozenCapabilityGrant {
  const descriptor = getCapability(capability.id)
  const comparator = SCOPE_COMPARATORS[capability.id]
  if (!descriptor?.scopeEnforced || !descriptor.scopeAdapter || !comparator) {
    return { id: capability.id, scopeAdapterId: "none", scopeAdapterVersion: "1" }
  }
  return {
    id: capability.id,
    // Adapter canonicalize() output is always JSON-plain for our capability
    // set (string arrays/records); safe to treat as CanonicalJson here.
    canonicalScope: descriptor.scopeAdapter.canonicalize(capability.scope) as CanonicalJson,
    scopeAdapterId: comparator.adapterId,
    scopeAdapterVersion: comparator.adapterVersion,
  }
}

function deriveOwnerId(
  descriptor: Pick<RegisteredToolDescriptor, "fqName" | "pluginId" | "provenance">
): string {
  if (descriptor.provenance === "host") return "synapse-host"
  if (descriptor.provenance === "plugin") return descriptor.pluginId
  const withoutPrefix = descriptor.fqName.slice("mcp:".length)
  const slash = withoutPrefix.indexOf("/")
  return `mcp:${slash === -1 ? withoutPrefix : withoutPrefix.slice(0, slash)}`
}

function deriveOwnerVersion(descriptor: Pick<RegisteredToolDescriptor, "provenance">): string {
  // Only the host's own version is reliably known at this layer today; a
  // plugin/MCP server's declared version is not yet threaded through
  // RegisteredToolDescriptor. "unknown" is honest rather than fabricated
  // precision — a later task can plumb the real value through.
  return descriptor.provenance === "host" ? PLUGIN_HOST_VERSION : "unknown"
}

function deriveInvocationAdapterId(
  descriptor: Pick<RegisteredToolDescriptor, "provenance">
): string {
  if (descriptor.provenance === "host") return "host-tool"
  if (descriptor.provenance === "plugin") return "plugin-sandbox"
  return "mcp-client"
}

/** Maps a live tool descriptor's provenance to the frozen/invocation-recovery
 *  vocabulary ("mcp-client" -> "mcp"); reused by tool-registry.ts's
 *  invocation-adapter wiring so the two never drift apart. */
export function frozenProvenance(
  provenance: RegisteredToolDescriptor["provenance"]
): FrozenToolAuthority["provenance"] {
  return provenance === "mcp-client" ? "mcp" : provenance
}

export function freezeToolAuthority(input: {
  descriptor: RegisteredToolDescriptor
  safeName: string
  modelSchema: ProviderToolSchema
}): FrozenToolAuthority {
  const { descriptor, safeName, modelSchema } = input
  return {
    fqName: descriptor.fqName,
    safeName,
    provenance: frozenProvenance(descriptor.provenance),
    ownerId: deriveOwnerId(descriptor),
    ownerVersion: deriveOwnerVersion(descriptor),
    modelSchemaHash: canonicalHash(modelSchema as unknown as CanonicalJson),
    annotationsHash: canonicalHash(
      (descriptor.manifestTool.annotations ?? {}) as unknown as CanonicalJson
    ),
    requiredCapabilities: descriptor.manifestTool.capabilities?.map(freezeCapabilityGrant),
    invocationAdapterId: deriveInvocationAdapterId(descriptor),
    invocationAdapterVersion: "1",
    // Every existing tool adapter starts unreplayable; nothing today proves
    // dedupe-and-result-replay, so nothing may claim it.
    replayGuarantee: "none",
  }
}

export function freezeAuthoritySnapshot(input: {
  principal: FrozenPrincipalSnapshot
  capabilities: readonly NormalizedCapability[]
  tools: ReadonlyArray<{
    descriptor: RegisteredToolDescriptor
    safeName: string
    modelSchema: ProviderToolSchema
  }>
}): FrozenAuthoritySnapshotV1 {
  const capabilities = input.capabilities
    .map(freezeCapabilityGrant)
    .sort((a, b) => a.id.localeCompare(b.id))
  const tools = input.tools
    .map((tool) => freezeToolAuthority(tool))
    .sort((a, b) => a.fqName.localeCompare(b.fqName))
  const integrityHash = canonicalHash({
    schemaVersion: 1,
    principal: input.principal as unknown as CanonicalJson,
    capabilities: capabilities as unknown as CanonicalJson,
    tools: tools as unknown as CanonicalJson,
  })
  return { schemaVersion: 1, principal: input.principal, capabilities, tools, integrityHash }
}

/** Rebinds the capability side of an already-live tool snapshot while
 * preserving its integrity hash. Recovery uses this for a subagent: its
 * executable tools are its own frozen ceiling intersected with its parent's
 * live ceiling, while the parent remains the source of capability grants. */
export function withFrozenAuthorityCapabilities(
  authority: FrozenAuthoritySnapshotV1,
  capabilities: readonly FrozenCapabilityGrant[]
): FrozenAuthoritySnapshotV1 {
  const nextCapabilities = [...capabilities].sort((a, b) => a.id.localeCompare(b.id))
  return {
    ...authority,
    capabilities: nextCapabilities,
    integrityHash: canonicalHash({
      schemaVersion: 1,
      principal: authority.principal as unknown as CanonicalJson,
      capabilities: nextCapabilities as unknown as CanonicalJson,
      tools: authority.tools as unknown as CanonicalJson,
    }),
  }
}

// ---------------------------------------------------------------------------
// Recovery comparison

export type CapabilityGrantComparison =
  | "unchanged-or-wider"
  | "narrowed"
  | "revoked"
  | "adapter-missing"
  | "adapter-version-mismatch"

/**
 * Whether a frozen capability grant is still safely usable given the current
 * grant of the same id. Never uses hash equality to decide containment —
 * only the registered comparator's structural `contains()` does that.
 */
export function compareCapabilityGrant(
  frozen: FrozenCapabilityGrant,
  current: FrozenCapabilityGrant | undefined
): CapabilityGrantComparison {
  if (!current) return "revoked"

  if (frozen.canonicalScope === undefined) {
    // Unscoped capability: presence under the same id is the entire check.
    return "unchanged-or-wider"
  }

  const comparator = scopeComparatorFor(frozen)
  if (!comparator) return "adapter-missing"
  if (
    comparator.adapterId !== frozen.scopeAdapterId ||
    comparator.adapterVersion !== frozen.scopeAdapterVersion
  ) {
    return "adapter-version-mismatch"
  }
  if (current.canonicalScope === undefined) return "revoked"
  if (
    comparator.adapterId !== current.scopeAdapterId ||
    comparator.adapterVersion !== current.scopeAdapterVersion
  ) {
    // The current grant's own recorded adapter identity disagrees with the
    // live registry too — its scope shape cannot be trusted for comparison.
    return "adapter-version-mismatch"
  }

  if (comparator.contains(current.canonicalScope, frozen.canonicalScope))
    return "unchanged-or-wider"
  if (comparator.contains(frozen.canonicalScope, current.canonicalScope)) return "narrowed"
  // Neither side fully contains the other — an unpredictable reshape, not a
  // provable subset. Fail closed rather than guess.
  return "revoked"
}

/** The identity-only subset of {@link compareToolAuthority}'s first check
 *  (schema/annotations/owner/adapter — never capability narrowing, which
 *  needs a live capabilities map this call's callers don't have). Used at
 *  dispatch/approval/invoke time (P1-5) to make the run's frozen tool
 *  catalog actually load-bearing, not just a comparison artifact recovery
 *  classification reads — a tool call is only ever approved or executed
 *  against the exact identity the run's authority froze at creation, never
 *  whatever a live safeName happens to resolve to right now. */
export function toolIdentityMatches(
  frozen: FrozenToolAuthority,
  current: FrozenToolAuthority
): boolean {
  return (
    current.modelSchemaHash === frozen.modelSchemaHash &&
    current.annotationsHash === frozen.annotationsHash &&
    current.ownerId === frozen.ownerId &&
    current.invocationAdapterId === frozen.invocationAdapterId &&
    current.invocationAdapterVersion === frozen.invocationAdapterVersion
  )
}

export type ToolAuthorityComparison =
  | { kind: "unchanged" }
  | { kind: "narrowed" }
  | { kind: "removed" }
  | { kind: "changed" }
  | { kind: "blocked"; reason: "adapter-incompatible" }

/**
 * Whether a frozen tool is still safely resumable given the current
 * authority. Identity/schema/annotation/adapter drift is "changed" (needs
 * review); a narrowed or revoked required capability narrows or removes the
 * tool; an incompatible capability comparator blocks it outright.
 */
export function compareToolAuthority(
  frozen: FrozenToolAuthority,
  current: FrozenToolAuthority | undefined,
  currentCapabilities: ReadonlyMap<string, FrozenCapabilityGrant>
): ToolAuthorityComparison {
  if (!current) return { kind: "removed" }

  if (
    current.modelSchemaHash !== frozen.modelSchemaHash ||
    current.annotationsHash !== frozen.annotationsHash ||
    current.ownerId !== frozen.ownerId ||
    current.invocationAdapterId !== frozen.invocationAdapterId ||
    current.invocationAdapterVersion !== frozen.invocationAdapterVersion
  ) {
    return { kind: "changed" }
  }

  if (!frozen.requiredCapabilities) return { kind: "unchanged" }

  let anyNarrowed = false
  for (const grant of frozen.requiredCapabilities) {
    const outcome = compareCapabilityGrant(grant, currentCapabilities.get(grant.id))
    if (outcome === "adapter-missing" || outcome === "adapter-version-mismatch") {
      return { kind: "blocked", reason: "adapter-incompatible" }
    }
    if (outcome === "revoked") return { kind: "removed" }
    if (outcome === "narrowed") anyNarrowed = true
  }
  return anyNarrowed ? { kind: "narrowed" } : { kind: "unchanged" }
}

/** Never upgrades: the effective guarantee is the weaker of the two sides. */
export function effectiveReplayGuarantee(
  frozen: ReplayGuarantee,
  current: ReplayGuarantee
): ReplayGuarantee {
  return frozen === "dedupe-and-result-replay" && current === "dedupe-and-result-replay"
    ? "dedupe-and-result-replay"
    : "none"
}

/** Principal identity must match exactly — never a subset relationship. */
export function principalMatches(
  frozen: FrozenPrincipalSnapshot,
  current: FrozenPrincipalSnapshot
): boolean {
  return (
    canonicalHash(frozen as unknown as CanonicalJson) ===
    canonicalHash(current as unknown as CanonicalJson)
  )
}
