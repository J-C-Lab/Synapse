// Host-only skill vocabulary (design §"Progressive skill runtime",
// Checkpoint D). Mirrors the shape frozen in the design doc byte-for-byte —
// see docs/superpowers/specs/2026-07-15-durable-agent-harness-evolution-design.md
// around line 1360. `SkillTrust`'s four literals must stay in lockstep with
// the inline union already hardcoded on `SkillActivationSnapshot.trust` in
// ../runs/checkpoint-schema.ts (written before this file existed, per that
// file's own "forward-declared" comment).
//
// v1 (2026-07-18 scope revision) only ever produces `source: "user"` or
// `source: "workspace"` descriptors — `builtin`/`plugin`/`marketplace` stay
// part of the type union so later checkpoints can add them without a
// breaking change, but nothing in this checkpoint constructs them.
//
// Pure types + bounds constants only — no I/O, no fs, no YAML. Every other
// module in this directory imports its limits from here so a single review
// of this file is enough to audit every size/count ceiling the catalog
// enforces.

export type SkillSourceKind = "builtin" | "user" | "workspace" | "plugin" | "marketplace"
export type SkillTrust = "host" | "user-authored" | "third-party" | "workspace-content"

export interface SkillPackageRef {
  uri: `skillpkg://sha256/${string}`
  packageHash: string
  manifestHash: string
  capturedBytes: number
  fileCount: number
}

export interface SkillDescriptor {
  /** Source-stable, not only frontmatter name — see skill-discovery.ts. */
  id: string
  name: string
  description: string
  version?: string
  source: SkillSourceKind
  trust: SkillTrust
  sourceRef: string
  contentHash: string
  packageRef: SkillPackageRef
  instructionsPath: "SKILL.md"
  allowedTools?: string[]
  compatibility?: string
}

/** Builds the one URI shape every package ref uses, mirroring
 *  artifact-types.ts's `artifactUri` — centralized so no call site
 *  hand-assembles (and potentially mis-assembles) the string a forged-ref
 *  check would compare against. */
export function skillPackageUri(packageHash: string): SkillPackageRef["uri"] {
  return `skillpkg://sha256/${packageHash}`
}

export const SKILL_MD_FILENAME = "SKILL.md"

/** Design §"Discovery and conflicts": "A SKILL.md is limited to 1 MiB." */
export const SKILL_MD_MAX_BYTES = 1024 * 1024

/** Frontmatter is a small structured header, not the instructional body —
 *  bounded far below the whole-file ceiling so a pathological frontmatter
 *  block can never itself approach the 1 MiB limit before YAML parsing even
 *  starts. */
export const SKILL_FRONTMATTER_MAX_BYTES = 64 * 1024

export const SKILL_NAME_MAX_LENGTH = 128
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024
export const SKILL_VERSION_MAX_LENGTH = 64
export const SKILL_COMPATIBILITY_MAX_LENGTH = 256
export const SKILL_ALLOWED_TOOLS_MAX_COUNT = 64
export const SKILL_ALLOWED_TOOL_NAME_MAX_LENGTH = 128

/** Per-package ingestion bounds — the "decompression/alias bomb" defense for
 *  plain file counts/sizes (there is no compression in this format; the
 *  attack surface is a package that declares an unbounded number of files or
 *  an unbounded total size). */
export const SKILL_PACKAGE_MAX_FILES = 64
export const SKILL_PACKAGE_MAX_TOTAL_BYTES = 8 * 1024 * 1024
export const SKILL_PACKAGE_MAX_PATH_DEPTH = 8

export const SKILL_SOURCE_REF_MAX_LENGTH = 4096
