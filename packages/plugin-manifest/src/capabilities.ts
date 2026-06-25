import type { JsonSchema } from "./types"
import { createHash } from "node:crypto"

// The capability registry — the single source of truth for what a plugin may be
// granted, and how risky each capability is. A capability is governed, not just
// declared: tier drives whether a grant is automatic (install), consent (JIT
// prompt), or elevated (JIT prompt + per-call approval when the agent or a
// background task drives it). Red-line abilities (arbitrary shell, raw fs,
// cross-plugin access, the agent's keys) are intentionally absent — they cannot
// be declared, and the vm sandbox cannot reach them either.

export type CapabilityTier = "auto" | "consent" | "elevated"

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
 * Stable hash over a plugin's declared-capability set. Part of the grant
 * identity: if an update changes what the plugin declares, the hash changes and
 * prior grants are invalidated — a wider update cannot inherit narrower trust.
 */
export function capabilityDeclarationHash(declared: readonly string[]): string {
  const normalized = [...new Set(declared)].sort().join("\n")
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}
