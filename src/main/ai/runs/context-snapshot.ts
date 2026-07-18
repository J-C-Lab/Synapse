import type { WorkspaceRootRecord } from "../execution/types"
import type { FrozenSkillCatalogEntrySnapshot } from "../skills/skill-catalog"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { loadWorkspaceInstructions } from "../context/workspace-instructions"
import { labelUntrustedContent } from "../guardrails/untrusted-content"

// Freezes the exact bytes a durable run's provider requests are built from
// (design §"Freeze exact system and workspace context"). Run creation reads
// the base system prompt and every workspace-instruction source exactly
// once, in stable order, already wrapped in its untrusted envelope (nonce
// baked in — labelUntrustedContent's nonce is random per call, so the
// envelope itself must be frozen, not just the raw instruction text).
// Resume then assembles requests only from the snapshot and never rereads a
// workspace-instruction file.
//
// Task 24 additionally freezes the bounded skill catalog projection (design
// §"Progressive disclosure": "The base prompt receives only a bounded
// catalog of id, name, description, source, trust label..."). This module
// never discovers skills itself — the caller passes an already-projected
// `FrozenSkillCatalogEntrySnapshot[]` (skill-catalog.ts's
// `projectSkillCatalogForContext`), which this module only freezes/hashes,
// exactly like it does for the base system prompt and workspace
// instructions. Full instructions are never part of this snapshot; only
// Task 25's activation path may later add instruction bytes, and it does so
// as its own separate run artifact, not by extending this one.

export const CONTEXT_SNAPSHOT_MAX_AGGREGATE_BYTES = 512 * 1024

export class ContextSnapshotTooLargeError extends Error {}

export interface FrozenWorkspaceInstructionSnapshot {
  rootId: string
  sourcePath: string
  sourceKind: "workspace-instruction"
  trust: "untrusted-workspace-instruction"
  normalizedText: string
  sha256: string
}

export interface FrozenContextSnapshotV1 {
  schemaVersion: 1
  baseSystemPrompt: { normalizedText: string; sha256: string }
  workspaceInstructions: FrozenWorkspaceInstructionSnapshot[]
  /** Canonical: always sorted by `id` (skill-catalog.ts's
   *  `projectSkillCatalogForContext` already sorts, but this module
   *  re-sorts defensively so `skillCatalogHash` never depends on a caller
   *  happening to preserve that order). */
  skillCatalog: FrozenSkillCatalogEntrySnapshot[]
  skillCatalogHash: string
  aggregateHash: string
}

export function contextSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Deterministic hash of a sorted skill catalog projection. Exported so a
 *  caller can recompute what `buildContextSnapshot` would freeze without
 *  duplicating the sort/serialize logic. */
export function skillCatalogHash(entries: readonly FrozenSkillCatalogEntrySnapshot[]): string {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return contextSha256(JSON.stringify(sorted))
}

/** Validates the complete frozen context payload using the same byte-level
 * hashes recorded at setup. */
export function contextSnapshotIntegrityMatches(snapshot: FrozenContextSnapshotV1): boolean {
  if (
    snapshot.baseSystemPrompt.sha256 !== contextSha256(snapshot.baseSystemPrompt.normalizedText)
  ) {
    return false
  }
  if (
    snapshot.workspaceInstructions.some(
      (instruction) => instruction.sha256 !== contextSha256(instruction.normalizedText)
    )
  ) {
    return false
  }
  if (snapshot.skillCatalogHash !== skillCatalogHash(snapshot.skillCatalog)) {
    return false
  }
  return (
    snapshot.aggregateHash ===
    contextSha256(
      [
        snapshot.baseSystemPrompt.sha256,
        ...snapshot.workspaceInstructions.map((instruction) => instruction.sha256),
        snapshot.skillCatalogHash,
      ].join("|")
    )
  )
}

export interface BuildContextSnapshotOptions {
  /** The fully composed base system prompt (guidance text, untrusted-context
   *  notice, etc. already concatenated) — this module owns none of that
   *  composition, only freezing its result and the instruction sources. */
  baseSystemText: string
  instructionWorkspaces: readonly WorkspaceRootRecord[]
  /** Already-projected bounded skill catalog metadata (skill-catalog.ts's
   *  `projectSkillCatalogForContext`) — defaults to empty so existing
   *  callers that don't yet discover skills are unaffected. This module
   *  never calls discovery itself; see this file's top-of-file note. */
  skillCatalog?: readonly FrozenSkillCatalogEntrySnapshot[]
}

export async function buildContextSnapshot(
  options: BuildContextSnapshotOptions
): Promise<FrozenContextSnapshotV1> {
  const baseSystemPrompt = {
    normalizedText: options.baseSystemText,
    sha256: contextSha256(options.baseSystemText),
  }

  // Matches AgentRuntime's existing rule: only primary-role workspaces
  // contribute instruction files.
  const primaryOnly = options.instructionWorkspaces.filter(
    (workspace) => workspace.role === "primary"
  )
  const instructions = await loadWorkspaceInstructions([...primaryOnly])

  const workspaceInstructions: FrozenWorkspaceInstructionSnapshot[] = instructions.map(
    (instruction) => {
      const sourcePath = `workspace:${instruction.workspaceId}/${instruction.fileName}`
      const normalizedText = labelUntrustedContent(sourcePath, instruction.text)
      return {
        rootId: instruction.workspaceId,
        sourcePath,
        sourceKind: "workspace-instruction" as const,
        trust: "untrusted-workspace-instruction" as const,
        normalizedText,
        sha256: contextSha256(normalizedText),
      }
    }
  )

  // Sorted by id so the frozen order — and therefore skillCatalogHash below
  // — never depends on incidental discovery/filesystem enumeration order;
  // skill-catalog.ts's own projectSkillCatalogForContext already sorts, but
  // this re-sort makes that a guarantee this module owns, not an assumption
  // borrowed from its caller.
  const skillCatalog = [...(options.skillCatalog ?? [])].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )
  const skillCatalogHashValue = skillCatalogHash(skillCatalog)

  const aggregateBytes =
    Buffer.byteLength(baseSystemPrompt.normalizedText, "utf8") +
    workspaceInstructions.reduce(
      (sum, entry) => sum + Buffer.byteLength(entry.normalizedText, "utf8"),
      0
    ) +
    Buffer.byteLength(JSON.stringify(skillCatalog), "utf8")
  if (aggregateBytes > CONTEXT_SNAPSHOT_MAX_AGGREGATE_BYTES) {
    throw new ContextSnapshotTooLargeError(
      `context snapshot (${aggregateBytes} bytes) exceeds the v1 aggregate limit of ` +
        `${CONTEXT_SNAPSHOT_MAX_AGGREGATE_BYTES} bytes`
    )
  }

  const aggregateHash = contextSha256(
    [
      baseSystemPrompt.sha256,
      ...workspaceInstructions.map((entry) => entry.sha256),
      skillCatalogHashValue,
    ].join("|")
  )

  return {
    schemaVersion: 1,
    baseSystemPrompt,
    workspaceInstructions,
    skillCatalog,
    skillCatalogHash: skillCatalogHashValue,
    aggregateHash,
  }
}

/** Rebuilds provider request context strictly from the snapshot — never
 *  reads a workspace-instruction file. Safe to call on resume/recovery. */
export function assembleFromContextSnapshot(snapshot: FrozenContextSnapshotV1): {
  system: string
  instructionContextText: string
} {
  return {
    system: snapshot.baseSystemPrompt.normalizedText,
    instructionContextText: snapshot.workspaceInstructions
      .map((entry) => entry.normalizedText)
      .join("\n\n"),
  }
}
