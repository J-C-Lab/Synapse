import type { NormalizedCapability } from "./types"
import { getCapability, normalizeCapabilities } from "./capabilities"

/**
 * v1 -> v2 boundary normalizer. v1 manifests only ever declared unscoped
 * permission strings; this converts them into the normalized capability shape.
 * Scoped capabilities (e.g. network:https) are v2-only and cannot be expressed
 * by a bare v1 permission string, so they are rejected here rather than being
 * silently granted an empty scope.
 */
export function normalizeLegacyCapabilities(
  permissions: readonly string[]
): NormalizedCapability[] {
  for (const id of permissions) {
    const desc = getCapability(id)
    if (!desc) throw new Error(`Unknown v1 permission: ${id}`)
    if (desc.scopeEnforced) {
      throw new Error(`v1 manifest cannot declare ${id} (scoped capabilities are v2-only)`)
    }
  }
  return normalizeCapabilities(permissions.map((id) => ({ id })))
}
