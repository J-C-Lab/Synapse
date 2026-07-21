import type { SkillDiscoveryDiagnostic, SkillDiscoveryRoot } from "./skill-discovery"
import type { SkillPackageStore } from "./skill-package-store"
import type { SkillDescriptor, SkillSourceKind, SkillTrust } from "./skill-types"
import { discoverSkills } from "./skill-discovery"

// Aggregates discovery output into the catalog shape a run consumes (design
// §"Discovery and conflicts", §"Progressive disclosure"). This module owns
// two things discovery itself deliberately does not: naming-conflict
// detection across sources, and projecting the bounded metadata that is
// ever allowed into a fresh run's context — id, name, description, source,
// trust. It never projects `allowedTools`, `instructionsPath`,
// `packageRef`, or anything else that would let a run reconstruct or
// pre-fetch full instructions without going through the (later, Task 25)
// activate_skill path.

/** Two or more descriptors sharing the same frontmatter `name` are a
 *  visible conflict, never a silent last-source-wins resolution (design:
 *  "Source order affects recommendation ranking but does not silently
 *  replace an identically named skill... conflicts appear in
 *  diagnostics"). There is deliberately no preferred-source setting here —
 *  see this checkpoint's scope note. */
export interface SkillNameConflict {
  name: string
  ids: string[]
}

export interface SkillCatalogSnapshot {
  descriptors: SkillDescriptor[]
  conflicts: SkillNameConflict[]
  diagnostics: SkillDiscoveryDiagnostic[]
}

/** The only shape ever allowed into a fresh run's frozen context — see
 *  context-snapshot.ts. Deliberately excludes everything else on
 *  `SkillDescriptor` (full instructions are never injected eagerly). */
export interface FrozenSkillCatalogEntrySnapshot {
  id: string
  name: string
  description: string
  source: SkillSourceKind
  trust: SkillTrust
}

/** Builds the full catalog snapshot by discovering both v1 sources and
 *  detecting name conflicts across them. `roots` is caller-supplied so this
 *  module stays decoupled from how a "bound workspace" is chosen — that
 *  decision belongs to the caller (e.g. a future run-setup wiring), not to
 *  the catalog itself. */
export async function buildSkillCatalog(
  roots: readonly SkillDiscoveryRoot[],
  packageStore: SkillPackageStore
): Promise<SkillCatalogSnapshot> {
  const { descriptors, diagnostics } = await discoverSkills(roots, packageStore)
  return { descriptors, conflicts: findNameConflicts(descriptors), diagnostics }
}

/** Groups descriptors by frontmatter `name` and returns every group with
 *  more than one distinct id — a same-source duplicate cannot occur (a
 *  filesystem directory listing cannot contain two entries with the same
 *  name), so every conflict returned here is necessarily cross-source. */
export function findNameConflicts(descriptors: readonly SkillDescriptor[]): SkillNameConflict[] {
  const byName = new Map<string, Set<string>>()
  for (const descriptor of descriptors) {
    const ids = byName.get(descriptor.name) ?? new Set<string>()
    ids.add(descriptor.id)
    byName.set(descriptor.name, ids)
  }
  const conflicts: SkillNameConflict[] = []
  for (const [name, ids] of byName) {
    if (ids.size > 1) conflicts.push({ name, ids: [...ids].sort() })
  }
  return conflicts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Projects the bounded catalog metadata a fresh run's context is allowed
 *  to carry (design §"Progressive disclosure": "The base prompt receives
 *  only a bounded catalog of id, name, description, source, trust label,
 *  and recommended tools" — `allowedTools`/recommendation ranking are Task
 *  25's concern once activation exists; this checkpoint projects the fixed
 *  subset it is itself responsible for). Sorted by `id` so the projection
 *  is deterministic regardless of discovery/filesystem enumeration order —
 *  context-snapshot.ts's hash must never depend on incidental ordering.
 */
export function projectSkillCatalogForContext(
  descriptors: readonly SkillDescriptor[]
): FrozenSkillCatalogEntrySnapshot[] {
  return [...descriptors]
    .map((descriptor) => ({
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description,
      source: descriptor.source,
      trust: descriptor.trust,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Convenience lookup by id — a thin, pure helper so callers (e.g. a future
 *  activate_skill handler) don't hand-roll a `find` over the descriptor
 *  list at every call site. */
export function findSkillDescriptor(
  descriptors: readonly SkillDescriptor[],
  id: string
): SkillDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.id === id)
}
