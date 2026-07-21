import type { ParseSkillPackageOptions } from "./skill-package-parser"
import type { SkillPackageStore } from "./skill-package-store"
import type { SkillDescriptor, SkillSourceKind, SkillTrust } from "./skill-types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { parseSkillPackage, SkillPackageParseError } from "./skill-package-parser"
import { isSafeSkillRelativePath } from "./skill-paths"
import { SKILL_MD_FILENAME } from "./skill-types"

// Explicit, bounded discovery (design §"Discovery and conflicts"): only the
// two roots the caller hands in are ever scanned — this module never
// recursively walks arbitrary disk locations, and reads no plugin
// contributions (v1 scope revision). Each root's immediate subdirectories
// are the candidate skill packages; parseSkillPackage does its own bounded
// walk *within* each candidate, which is a separate, already-bounded
// operation from this top-level listing.
//
// A candidate directory that fails to parse (missing/invalid SKILL.md,
// symlink escape, over limit, ...) never aborts the whole discovery pass —
// it is skipped and recorded as a diagnostic, so one broken skill directory
// cannot take down the entire catalog.

export interface SkillDiscoveryDiagnostic {
  source: SkillSourceKind
  dirName: string
  reason: string
  message: string
}

/** v1 only ever discovers these two source kinds — see this file's
 *  top-of-file note. Typed narrowly (rather than the full `SkillSourceKind`
 *  union) so a caller cannot even construct a `builtin`/`plugin`
 *  /`marketplace` discovery root; those sources have no discovery
 *  implementation in this checkpoint. */
export type DiscoverableSkillSource = Extract<SkillSourceKind, "user" | "workspace">

export interface SkillDiscoveryRoot {
  source: DiscoverableSkillSource
  rootDir: string
}

export interface SkillDiscoveryResult {
  descriptors: SkillDescriptor[]
  diagnostics: SkillDiscoveryDiagnostic[]
}

export interface DiscoverSkillsOptions {
  parseOptions?: ParseSkillPackageOptions
}

/** v1 only ever discovers these two sources — see this file's top-of-file
 *  note and the design doc's 2026-07-18 scope revision. `builtin`, `plugin`,
 *  and `marketplace` are not produced here. */
const SOURCE_TRUST: Record<DiscoverableSkillSource, SkillTrust> = {
  // The user's own skill directory: content they authored or explicitly
  // placed themselves.
  user: "user-authored",
  // A workspace's skill directory travels with the workspace (e.g. a cloned
  // repository) and was not necessarily authored by the current user —
  // treated as workspace-provided content, not automatically user-authored.
  workspace: "workspace-content",
}

/**
 * Discovers every skill package directly under `roots` (design: "the user
 * skill directory and the bound workspace skill directory"). A root that
 * does not exist yet yields zero skills from it, not an error. Ingests each
 * successfully parsed package into `packageStore` before building its
 * descriptor, so every returned `SkillDescriptor.packageRef` always points
 * at bytes already durably committed to the immutable store.
 */
export async function discoverSkills(
  roots: readonly SkillDiscoveryRoot[],
  packageStore: SkillPackageStore,
  options: DiscoverSkillsOptions = {}
): Promise<SkillDiscoveryResult> {
  const descriptors: SkillDescriptor[] = []
  const diagnostics: SkillDiscoveryDiagnostic[] = []

  for (const root of roots) {
    let entries
    try {
      entries = await fs.readdir(root.rootDir, { withFileTypes: true })
    } catch (err) {
      if (isNotFound(err)) continue // no skills directory yet — not an error
      diagnostics.push({
        source: root.source,
        dirName: root.rootDir,
        reason: "root_unreadable",
        message: (err as Error).message,
      })
      continue
    }

    for (const entry of entries) {
      // Discovery only ever considers immediate subdirectories as candidate
      // skill packages. A symlinked candidate is rejected outright here too
      // (in addition to parseSkillPackage's own root-level check) so the
      // diagnostic reason is attributable to discovery's own listing step.
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          diagnostics.push({
            source: root.source,
            dirName: entry.name,
            reason: "symlink_not_allowed",
            message: `candidate skill directory must not be a symlink/junction: ${entry.name}`,
          })
        }
        continue
      }
      if (!isSafeSkillRelativePath(entry.name)) {
        diagnostics.push({
          source: root.source,
          dirName: entry.name,
          reason: "unsafe_directory_name",
          message: `unsafe skill directory name: ${entry.name}`,
        })
        continue
      }

      const candidateDir = path.join(root.rootDir, entry.name)
      try {
        const parsed = await parseSkillPackage(candidateDir, options.parseOptions)
        const packageRef = await packageStore.ingest(parsed)
        descriptors.push(
          buildDescriptor({
            source: root.source,
            dirName: entry.name,
            sourceRef: candidateDir,
            parsed,
            packageRef,
          })
        )
      } catch (err) {
        diagnostics.push({
          source: root.source,
          dirName: entry.name,
          reason: err instanceof SkillPackageParseError ? err.reason : "discovery_error",
          message: (err as Error).message,
        })
      }
    }
  }

  return { descriptors, diagnostics }
}

function buildDescriptor(input: {
  source: DiscoverableSkillSource
  dirName: string
  sourceRef: string
  parsed: Awaited<ReturnType<typeof parseSkillPackage>>
  packageRef: SkillDescriptor["packageRef"]
}): SkillDescriptor {
  const { source, dirName, sourceRef, parsed, packageRef } = input
  return {
    // Source-stable: two sources with a directory of the same name (or two
    // skills whose frontmatter happens to share a `name`) never collide —
    // the id always carries the source kind alongside the on-disk directory
    // identity, never just the frontmatter name (design: "Assign
    // source-stable skill ids... coexists as two distinct ids").
    id: `${source}:${dirName}`,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    version: parsed.frontmatter.version,
    source,
    trust: SOURCE_TRUST[source],
    sourceRef,
    contentHash: parsed.skillMdSha256,
    packageRef,
    instructionsPath: SKILL_MD_FILENAME,
    allowedTools: parsed.frontmatter.allowedTools,
    compatibility: parsed.frontmatter.compatibility,
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
