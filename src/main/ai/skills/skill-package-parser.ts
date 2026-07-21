import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as yaml from "js-yaml"
import {
  findCaseFoldCollisions,
  findExactDuplicatePaths,
  normalizeSkillRelativePath,
  UnsafeSkillPathError,
} from "./skill-paths"
import {
  SKILL_ALLOWED_TOOL_NAME_MAX_LENGTH,
  SKILL_ALLOWED_TOOLS_MAX_COUNT,
  SKILL_COMPATIBILITY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FRONTMATTER_MAX_BYTES,
  SKILL_MD_FILENAME,
  SKILL_MD_MAX_BYTES,
  SKILL_NAME_MAX_LENGTH,
  SKILL_PACKAGE_MAX_FILES,
  SKILL_PACKAGE_MAX_PATH_DEPTH,
  SKILL_PACKAGE_MAX_TOTAL_BYTES,
  SKILL_VERSION_MAX_LENGTH,
} from "./skill-types"

// Reads and validates one candidate skill package directory (design
// §"Discovery and conflicts"). This module never executes, evaluates, or
// `require`s anything found under the skill root: SKILL.md's frontmatter is
// parsed only far enough to extract a handful of bounded scalar/string-array
// fields, and the instructional body after the frontmatter is never even
// looked at beyond its byte length — it is captured as opaque bytes for
// skill-package-store.ts to hash-and-ingest untouched.

export class SkillPackageParseError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message)
    this.name = "SkillPackageParseError"
  }
}

export interface SkillPackageManifestEntry {
  relPath: string
  length: number
  sha256: string
}

export interface ParsedSkillFrontmatter {
  name: string
  description: string
  version?: string
  allowedTools?: string[]
  compatibility?: string
}

export interface ParsedSkillPackage {
  /** Canonical manifest entries, sorted by `relPath`. */
  manifest: SkillPackageManifestEntry[]
  /** Absolute source path for each manifest entry — never persisted; only
   *  consumed by skill-package-store.ts to stream the exact bytes in for
   *  ingestion. Keyed by the same `relPath` used in `manifest`. */
  sourcePaths: ReadonlyMap<string, string>
  frontmatter: ParsedSkillFrontmatter
  /** SHA-256 of SKILL.md's exact original bytes (frontmatter + body,
   *  untouched) — distinct from any per-entry hash in `manifest` only in
   *  that this is surfaced directly for `SkillDescriptor.contentHash`. */
  skillMdSha256: string
  totalBytes: number
}

export interface SkillPackageLimits {
  skillMdMaxBytes: number
  frontmatterMaxBytes: number
  maxFiles: number
  maxTotalBytes: number
  maxPathDepth: number
}

export const DEFAULT_SKILL_PACKAGE_LIMITS: SkillPackageLimits = {
  skillMdMaxBytes: SKILL_MD_MAX_BYTES,
  frontmatterMaxBytes: SKILL_FRONTMATTER_MAX_BYTES,
  maxFiles: SKILL_PACKAGE_MAX_FILES,
  maxTotalBytes: SKILL_PACKAGE_MAX_TOTAL_BYTES,
  maxPathDepth: SKILL_PACKAGE_MAX_PATH_DEPTH,
}

export interface ParseSkillPackageOptions {
  limits?: Partial<SkillPackageLimits>
}

/**
 * Reads and validates the complete bounded skill package rooted at
 * `skillRootDir`: walks the directory tree (bounded depth/count/size,
 * symlinks refused anywhere), validates every relative path, requires
 * `SKILL.md` at the top level, parses its frontmatter with YAML aliases and
 * custom tags disabled, and returns everything `skill-package-store.ts`
 * needs to hash-and-ingest the exact bytes. Rejects (rather than silently
 * repairs) any duplicate manifest entry, case-fold collision, symlink,
 * unsupported filesystem entry type, or over-limit package.
 */
export async function parseSkillPackage(
  skillRootDir: string,
  options: ParseSkillPackageOptions = {}
): Promise<ParsedSkillPackage> {
  const limits: SkillPackageLimits = { ...DEFAULT_SKILL_PACKAGE_LIMITS, ...options.limits }
  const files = await walkSkillPackageFiles(skillRootDir, limits)

  const relPaths = files.map((f) => f.relPath)
  const exactDuplicates = findExactDuplicatePaths(relPaths)
  if (exactDuplicates.length > 0) {
    throw new SkillPackageParseError(
      "duplicate_manifest_entry",
      `duplicate manifest entries: ${exactDuplicates.join(", ")}`
    )
  }
  const caseCollisions = findCaseFoldCollisions(relPaths)
  if (caseCollisions.length > 0) {
    throw new SkillPackageParseError(
      "case_fold_collision",
      `manifest entries collide once case-folded: ${caseCollisions.map((g) => g.join(" / ")).join(", ")}`
    )
  }

  const skillMdEntry = files.find((f) => f.relPath === SKILL_MD_FILENAME)
  if (!skillMdEntry) {
    throw new SkillPackageParseError(
      "missing_skill_md",
      `no ${SKILL_MD_FILENAME} at package root: ${skillRootDir}`
    )
  }

  const totalBytes = files.reduce((sum, f) => sum + f.length, 0)
  if (totalBytes > limits.maxTotalBytes) {
    throw new SkillPackageParseError(
      "package_too_large",
      `package is ${totalBytes} bytes, exceeding the limit of ${limits.maxTotalBytes}`
    )
  }

  const skillMdBuffer = await fs.readFile(skillMdEntry.absPath)
  if (skillMdBuffer.length !== skillMdEntry.length) {
    // The file changed size between the initial walk/hash and this read (a
    // TOCTOU race) — never trust the earlier measurement once it disagrees
    // with the bytes actually read back.
    throw new SkillPackageParseError(
      "skill_md_changed",
      `${SKILL_MD_FILENAME} changed size while being read`
    )
  }
  if (skillMdBuffer.length > limits.skillMdMaxBytes) {
    throw new SkillPackageParseError(
      "skill_md_too_large",
      `${SKILL_MD_FILENAME} is ${skillMdBuffer.length} bytes, exceeding the limit of ${limits.skillMdMaxBytes}`
    )
  }
  const skillMdSha256 = createHash("sha256").update(skillMdBuffer).digest("hex")
  const frontmatter = parseSkillMdFrontmatter(skillMdBuffer.toString("utf-8"), limits)

  const manifest: SkillPackageManifestEntry[] = files
    .map((f) => ({ relPath: f.relPath, length: f.length, sha256: f.sha256 }))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))

  const sourcePaths = new Map(files.map((f) => [f.relPath, f.absPath]))

  return { manifest, sourcePaths, frontmatter, skillMdSha256, totalBytes }
}

interface WalkedFile {
  relPath: string
  absPath: string
  length: number
  sha256: string
}

/** Non-recursive-arbitrary bounded walk: only ever descends inside
 *  `skillRootDir` itself (never follows a symlink/junction out of it —
 *  every entry is rejected outright the moment it is found to be a
 *  symlink, rather than attempting to safely resolve where it points), and
 *  fails closed the instant any bound (depth, file count, total bytes) is
 *  exceeded rather than truncating silently. */
async function walkSkillPackageFiles(
  skillRootDir: string,
  limits: SkillPackageLimits
): Promise<WalkedFile[]> {
  let rootStat
  try {
    rootStat = await fs.lstat(skillRootDir)
  } catch (err) {
    throw new SkillPackageParseError(
      "root_missing",
      `skill root is not accessible: ${skillRootDir} (${(err as Error).message})`
    )
  }
  if (rootStat.isSymbolicLink()) {
    throw new SkillPackageParseError(
      "symlink_not_allowed",
      `skill root itself must not be a symlink/junction: ${skillRootDir}`
    )
  }
  if (!rootStat.isDirectory()) {
    throw new SkillPackageParseError(
      "root_not_directory",
      `skill root is not a directory: ${skillRootDir}`
    )
  }

  const files: WalkedFile[] = []
  let totalBytes = 0
  const queue: Array<{ absDir: string; relDir: string; depth: number }> = [
    { absDir: skillRootDir, relDir: "", depth: 1 },
  ]

  while (queue.length > 0) {
    const { absDir, relDir, depth } = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch (err) {
      throw new SkillPackageParseError(
        "unreadable_directory",
        `unable to list ${absDir}: ${(err as Error).message}`
      )
    }
    for (const entry of entries) {
      const rawRelPath = relDir ? `${relDir}/${entry.name}` : entry.name
      let normalizedRelPath: string
      try {
        normalizedRelPath = normalizeSkillRelativePath(rawRelPath)
      } catch (err) {
        if (err instanceof UnsafeSkillPathError) {
          throw new SkillPackageParseError("unsafe_path", err.message)
        }
        throw err
      }
      const absPath = path.join(absDir, entry.name)

      if (entry.isSymbolicLink()) {
        throw new SkillPackageParseError(
          "symlink_not_allowed",
          `symlink/junction is not allowed inside a skill package: ${normalizedRelPath}`
        )
      }
      if (entry.isDirectory()) {
        if (depth + 1 > limits.maxPathDepth) {
          throw new SkillPackageParseError(
            "path_too_deep",
            `path exceeds the maximum depth of ${limits.maxPathDepth}: ${normalizedRelPath}`
          )
        }
        queue.push({ absDir: absPath, relDir: normalizedRelPath, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) {
        // Refuse anything that is not a plain file or directory (FIFO,
        // socket, character/block device, ...) rather than silently
        // skipping it — an attacker-controlled directory choosing what a
        // discovery pass "happens to ignore" is exactly the surface this
        // walk exists to close.
        throw new SkillPackageParseError(
          "unsupported_entry_type",
          `unsupported filesystem entry type: ${normalizedRelPath}`
        )
      }
      if (files.length >= limits.maxFiles) {
        throw new SkillPackageParseError(
          "too_many_files",
          `package has more than ${limits.maxFiles} files`
        )
      }
      const { length, sha256 } = await hashFile(absPath, limits.maxTotalBytes - totalBytes)
      totalBytes += length
      files.push({ relPath: normalizedRelPath, absPath, length, sha256 })
    }
  }
  return files
}

/** Hashes one file's exact bytes, bailing out as soon as it would push the
 *  package past `remainingBudget` rather than reading an unbounded amount
 *  first and rejecting afterward. Re-verifies via `fstat` on the already
 *  -open descriptor (immune to a symlink swapped in between the `readdir`
 *  dirent check and this `open` call) that the underlying entry is still a
 *  regular file. */
async function hashFile(
  absPath: string,
  remainingBudget: number
): Promise<{ length: number; sha256: string }> {
  const hash = createHash("sha256")
  let length = 0
  const handle = await fs.open(absPath, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new SkillPackageParseError("unsupported_entry_type", `not a regular file: ${absPath}`)
    }
    const chunkSize = 64 * 1024
    const buffer = Buffer.alloc(chunkSize)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      length += bytesRead
      if (length > remainingBudget) {
        throw new SkillPackageParseError(
          "package_too_large",
          `package exceeds its total-size limit while reading ${absPath}`
        )
      }
    }
  } finally {
    await handle.close()
  }
  return { length, sha256: hash.digest("hex") }
}

const FRONTMATTER_DELIMITER = "---"

/** Splits SKILL.md into its YAML frontmatter block and validates it. The
 *  body (everything after the closing `---`) is never inspected here at
 *  all — the whole-file byte bound already enforced by the caller is the
 *  only check that ever applies to it. */
function parseSkillMdFrontmatter(
  fullText: string,
  limits: SkillPackageLimits
): ParsedSkillFrontmatter {
  const lines = fullText.split(/\r\n|\n/)
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new SkillPackageParseError(
      "missing_frontmatter",
      `${SKILL_MD_FILENAME} must start with a "---" YAML frontmatter block`
    )
  }
  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
      endIndex = i
      break
    }
  }
  if (endIndex === -1) {
    throw new SkillPackageParseError(
      "unterminated_frontmatter",
      `${SKILL_MD_FILENAME} frontmatter block is never closed with "---"`
    )
  }
  const frontmatterText = lines.slice(1, endIndex).join("\n")
  if (Buffer.byteLength(frontmatterText, "utf-8") > limits.frontmatterMaxBytes) {
    throw new SkillPackageParseError(
      "frontmatter_too_large",
      `frontmatter exceeds the limit of ${limits.frontmatterMaxBytes} bytes`
    )
  }

  assertNoAliasesOrCustomTags(frontmatterText)

  let parsed: unknown
  try {
    parsed = yaml.load(frontmatterText, { schema: yaml.FAILSAFE_SCHEMA })
  } catch (err) {
    throw new SkillPackageParseError(
      "invalid_yaml",
      `frontmatter is not valid YAML: ${(err as Error).message}`
    )
  }
  return validateFrontmatterShape(parsed)
}

// Disables YAML anchors, aliases, and tags outright rather than trying to
// safely support them: SKILL.md frontmatter is expected to be a flat
// mapping of simple string/string-array fields, so there is no legitimate
// need for either feature. js-yaml's alias support builds shared-reference
// structures whose "cost" only shows up once something downstream clones or
// serializes them without a bound; this rejects the construct outright
// rather than relying on every future reader of a SkillDescriptor's
// frontmatter to prove that never happens.
//
// YAML only treats `&`/`*`/`!` as special in true *indicator position* —
// immediately after a mapping key's `:` separator, immediately after a
// block-sequence `-`, or immediately after a flow-collection `[`/`{`/`,` —
// never merely "preceded by whitespace somewhere in the line". An earlier
// version of this guard flagged any `&`/`*`/`!` preceded by whitespace or a
// comma anywhere in the line, which misfired on ordinary unquoted prose
// like "Salt & pepper", "Compute a * b", or "Good, & useful". This version
// only inspects the true indicator positions, so prose containing those
// characters — quoted or not — is left alone, while a real anchor/alias/tag
// construct in the position YAML would actually parse it is still rejected.
function assertNoAliasesOrCustomTags(frontmatterText: string): void {
  const stripped = frontmatterText
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|'')*'/g, "''")
  for (const rawLine of stripped.split(/\r\n|\n/)) {
    const trimmed = rawLine.replace(/^\s+/, "")
    if (trimmed.length === 0) continue

    // Block-sequence item: "- &anchor", "-  *alias", "- !!tag".
    if (/^-\s*[&*!]/.test(trimmed)) {
      throwAliasOrTagDisabled()
    }

    // Block-mapping value: "key: <value>" — only a colon that is actually
    // followed by whitespace/end-of-line (the real YAML key/value
    // separator) counts, so a colon embedded in prose never reaches here.
    const mappingMatch = /^[^:#]+:(?:\s|$)([\s\S]*)$/.exec(trimmed)
    if (mappingMatch) {
      const value = mappingMatch[1]!.replace(/^\s+/, "")
      if (/^[&*!]/.test(value)) throwAliasOrTagDisabled()
      assertNoFlowEntryIndicators(value)
    } else {
      assertNoFlowEntryIndicators(trimmed)
    }
  }
}

/** Within an actual flow collection (`[...]`/`{...}`) on this line, every
 *  entry-start position — right after `[`, `{`, or `,`, skipping
 *  whitespace — is a true indicator position too (e.g.
 *  `allowed-tools: [&x, *x]`). Only scanned when the text contains a real
 *  bracket; a bare comma in ordinary prose never triggers this. */
function assertNoFlowEntryIndicators(text: string): void {
  if (!/[[{]/.test(text)) return
  if (/[[{,]\s*[&*!]/.test(text)) throwAliasOrTagDisabled()
}

function throwAliasOrTagDisabled(): never {
  throw new SkillPackageParseError(
    "alias_or_tag_disabled",
    "frontmatter may not use YAML anchors, aliases, or custom tags"
  )
}

function validateFrontmatterShape(parsed: unknown): ParsedSkillFrontmatter {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillPackageParseError(
      "invalid_frontmatter_shape",
      "frontmatter must be a YAML mapping"
    )
  }
  const record = parsed as Record<string, unknown>

  const name = requireBoundedString(record.name, "name", SKILL_NAME_MAX_LENGTH)
  const description = requireBoundedString(
    record.description,
    "description",
    SKILL_DESCRIPTION_MAX_LENGTH
  )
  const version = optionalBoundedString(record.version, "version", SKILL_VERSION_MAX_LENGTH)
  const compatibility = optionalBoundedString(
    record.compatibility,
    "compatibility",
    SKILL_COMPATIBILITY_MAX_LENGTH
  )
  const allowedTools = optionalStringArray(
    record["allowed-tools"],
    "allowed-tools",
    SKILL_ALLOWED_TOOLS_MAX_COUNT,
    SKILL_ALLOWED_TOOL_NAME_MAX_LENGTH
  )

  return {
    name,
    description,
    ...(version !== undefined ? { version } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(compatibility !== undefined ? { compatibility } : {}),
  }
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new SkillPackageParseError(
      "invalid_frontmatter_field",
      `frontmatter "${field}" is required and must be a string`
    )
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new SkillPackageParseError(
      "invalid_frontmatter_field",
      `frontmatter "${field}" must not be empty`
    )
  }
  if (trimmed.length > maxLength) {
    throw new SkillPackageParseError(
      "frontmatter_field_too_long",
      `frontmatter "${field}" exceeds ${maxLength} characters`
    )
  }
  return trimmed
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number
): string | undefined {
  if (value === undefined) return undefined
  return requireBoundedString(value, field, maxLength)
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxCount: number,
  maxItemLength: number
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new SkillPackageParseError(
      "invalid_frontmatter_field",
      `frontmatter "${field}" must be a list of strings`
    )
  }
  if (value.length > maxCount) {
    throw new SkillPackageParseError(
      "frontmatter_field_too_long",
      `frontmatter "${field}" exceeds ${maxCount} entries`
    )
  }
  return value.map((item, index) => requireBoundedString(item, `${field}[${index}]`, maxItemLength))
}
