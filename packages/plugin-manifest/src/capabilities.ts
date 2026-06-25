import type { JsonSchema, NormalizedCapability } from "./types"
import { createHash } from "node:crypto"

// The capability registry — the single source of truth for what a plugin may be
// granted, and how risky each capability is. A capability is governed, not just
// declared: tier drives whether a grant is automatic (install), consent (JIT
// prompt), or elevated (JIT prompt + per-call approval when the agent or a
// background task drives it). Red-line abilities (arbitrary shell, raw fs,
// cross-plugin access, the agent's keys) are intentionally absent — they cannot
// be declared, and the vm sandbox cannot reach them either.

export type CapabilityTier = "auto" | "consent" | "elevated"

/**
 * The per-capability scope contract. A scope-enforced capability owns one of
 * these so every place that handles its scope — validation, grant merging,
 * containment checks during a JIT prompt, audit summaries — goes through the
 * same logic instead of re-implementing the capability's scope semantics.
 * Scopes are `unknown` at this boundary because only the adapter knows the shape.
 */
export interface CapabilityScopeAdapter {
  /** Throw if `scope` is not a structurally valid scope for this capability. */
  validate: (scope: unknown) => void
  /**
   * Return a stable, normalized form so equal scopes compare equal. The
   * declaration hash serializes scopes through a key-stable serializer, so
   * canonicalize need not emit object keys in any particular order — deep value
   * equality of the returned scope is sufficient for a stable hash.
   */
  canonicalize: (scope: unknown) => unknown
  /** Combine multiple granted scopes into one widest-allowed scope. */
  merge: (scopes: unknown[]) => unknown
  /** True if `containerScope` fully permits everything `requestedScope` asks for. */
  contains: (containerScope: unknown, requestedScope: unknown) => boolean
  /** Strip any fields that must not be persisted or shown (defense in depth). */
  sanitizeScope: (scope: unknown) => unknown
  /** Normalize an operation string against an optional scope for safe use/audit. */
  sanitizeOperation: (operation: string, requestedScope?: unknown) => string
  /** Human-readable one-line description of the scope (for prompts and audit). */
  summarize: (scope: unknown) => string
}

export interface CapabilityDescriptor {
  id: string
  tier: CapabilityTier
  /**
   * Reserved scope shape. Only honored once `scopeEnforced` is true and an
   * adapter actually constrains the call — never presented as a restriction
   * before then (no false "limited to X" signal).
   */
  scopeSchema?: JsonSchema
  scopeEnforced: boolean
  /**
   * The scope contract for a scope-enforced capability. Intentionally `undefined`
   * until the capability's adapter is wired (Task 12) — until then a declaration
   * of this capability has no way to be constrained and is rejected.
   */
  scopeAdapter?: CapabilityScopeAdapter
}

const ALL: CapabilityDescriptor[] = [
  { id: "storage:plugin", tier: "auto", scopeEnforced: false },
  { id: "notification", tier: "auto", scopeEnforced: false },
  { id: "clipboard:read", tier: "consent", scopeEnforced: false },
  { id: "clipboard:write", tier: "consent", scopeEnforced: false },
  // Continuous background surveillance of everything the user copies — split out
  // from clipboard:read so an on-demand reader cannot silently monitor.
  { id: "clipboard:watch", tier: "elevated", scopeEnforced: false },
  { id: "system:open-url", tier: "consent", scopeEnforced: false },
  { id: "system:open-path", tier: "consent", scopeEnforced: false },
  { id: "system:capture-screen", tier: "elevated", scopeEnforced: false },
  // Scope-enforced: an adapter is wired in Task 12. Until then `scopeAdapter` is
  // undefined, which keeps network declarations rejected during Phase 1.
  { id: "network:https", tier: "elevated", scopeEnforced: true, scopeAdapter: undefined },
]

export const CAPABILITIES: ReadonlyMap<string, CapabilityDescriptor> = new Map(
  ALL.map((cap) => [cap.id, cap])
)

export function getCapability(id: string): CapabilityDescriptor | undefined {
  return CAPABILITIES.get(id)
}

export function capabilityIds(): string[] {
  return [...CAPABILITIES.keys()]
}

/**
 * Collapse a raw declaration into the canonical capability set: one entry per
 * id, scopes canonicalized and merged through the capability's adapter, sorted
 * by id. Capabilities without an adapter carry no scope (their scope cannot yet
 * be constrained), so duplicates simply collapse to a single unscoped entry.
 */
export function normalizeCapabilities(
  declared: readonly NormalizedCapability[]
): NormalizedCapability[] {
  const byId = new Map<string, NormalizedCapability>()
  for (const cap of declared) {
    const adapter = getCapability(cap.id)?.scopeAdapter
    const scope = adapter ? adapter.canonicalize(cap.scope) : undefined
    const existing = byId.get(cap.id)
    if (!existing) {
      byId.set(cap.id, scope === undefined ? { id: cap.id } : { id: cap.id, scope })
    } else if (adapter) {
      byId.set(cap.id, { id: cap.id, scope: adapter.merge([existing.scope, scope]) })
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Deterministic JSON serializer that sorts object keys at every level (arrays
 * keep their order). Two deep-equal values always serialize to the same string,
 * regardless of key insertion order — required because the declaration hash is a
 * security-identity hash and a scope adapter may emit object keys in any order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

/**
 * Stable hash over a plugin's declared-capability set. Part of the grant
 * identity: if an update changes what the plugin declares, the hash changes and
 * prior grants are invalidated — a wider update cannot inherit narrower trust.
 * Hashes over the canonical set (ids + scopes) via a key-stable serializer, so
 * order and duplicates in the raw declaration (and object-key order within a
 * scope) do not affect identity, but a scope change does.
 */
export function capabilityDeclarationHash(declared: readonly NormalizedCapability[]): string {
  return createHash("sha256")
    .update(stableStringify(normalizeCapabilities(declared)))
    .digest("hex")
    .slice(0, 16)
}
