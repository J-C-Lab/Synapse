// Pure path-safety checks for skill package manifest entries and discovered
// directory names (design §"Discovery and conflicts": "paths remain within
// the declared skill root"; Task 24 checklist: "Reject absolute/traversal
// /reserved/device paths, case-fold collisions, ... duplicate manifest
// entries"). No I/O here — symlink/junction escape is checked at read time
// by the caller (skill-package-parser.ts / skill-package-store.ts), the same
// division of labor artifact-store.ts uses between its SAFE_ID charset check
// (pure) and resolveContainedPath (I/O, post-realpath).

export class UnsafeSkillPathError extends Error {
  constructor(rawPath: string, reason: string) {
    super(`unsafe skill path "${rawPath}": ${reason}`)
    this.name = "UnsafeSkillPathError"
  }
}

// Windows reserved device names are reserved case-insensitively and with or
// without a trailing extension (`NUL`, `nul.txt`, `Nul.tar.gz` all resolve to
// the same device on Windows). Checked regardless of host platform so a
// package built on Linux/macOS still can't smuggle an entry that would
// silently misbehave once a Windows machine restores it from the store.
const RESERVED_WINDOWS_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com0",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt0",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
])

function isReservedSegment(segment: string): boolean {
  const base = segment.split(".")[0]!.toLowerCase()
  return RESERVED_WINDOWS_NAMES.has(base)
}

/**
 * Normalizes a manifest-declared relative path to posix-style forward
 * slashes and validates it is safe: no absolute prefix, no drive letter, no
 * UNC prefix, no traversal (`..`), no empty/`.`/reserved-device segments, no
 * trailing dot/space on any segment (Windows silently strips these, which
 * would let two distinct manifest entries collide on disk), no embedded NUL,
 * and no colon (Windows alternate-data-stream syntax). Throws
 * `UnsafeSkillPathError` on the first violation; a caller that gets a return
 * value back never needs a second round of validation on it.
 */
export function normalizeSkillRelativePath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new UnsafeSkillPathError(String(rawPath), "empty path")
  }
  if (rawPath.includes("\0")) {
    throw new UnsafeSkillPathError(rawPath, "contains a NUL byte")
  }
  const posixPath = rawPath.replace(/\\/g, "/")
  if (posixPath.startsWith("/") || posixPath.startsWith("~")) {
    throw new UnsafeSkillPathError(rawPath, "absolute path is not allowed")
  }
  // Windows drive letter (`C:...`) or UNC (`//server/share`) prefix.
  if (/^[a-z]:/i.test(posixPath) || posixPath.startsWith("//")) {
    throw new UnsafeSkillPathError(rawPath, "drive-qualified or UNC path is not allowed")
  }

  const segments = posixPath.split("/")
  const normalizedSegments: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue // collapse redundant separators
    if (segment === "..") {
      throw new UnsafeSkillPathError(rawPath, "path traversal (..) is not allowed")
    }
    if (segment.includes(":")) {
      throw new UnsafeSkillPathError(rawPath, "colon is not allowed in a path segment")
    }
    if (/[\s.]$/.test(segment)) {
      throw new UnsafeSkillPathError(rawPath, "path segment may not end with a space or dot")
    }
    if (isReservedSegment(segment)) {
      throw new UnsafeSkillPathError(rawPath, `"${segment}" is a reserved device name`)
    }
    normalizedSegments.push(segment)
  }
  if (normalizedSegments.length === 0) {
    throw new UnsafeSkillPathError(rawPath, "path has no non-empty segments")
  }
  return normalizedSegments.join("/")
}

export function isSafeSkillRelativePath(rawPath: string): boolean {
  try {
    normalizeSkillRelativePath(rawPath)
    return true
  } catch {
    return false
  }
}

/** How many `/`-separated segments a normalized relative path has — used by
 *  skill-package-parser.ts to enforce `SKILL_PACKAGE_MAX_PATH_DEPTH`. */
export function skillPathDepth(normalizedRelPath: string): number {
  return normalizedRelPath.split("/").length
}

/**
 * Finds groups of two-or-more manifest paths that collide once case-folded
 * — a case-insensitive filesystem (the default on Windows and macOS) can
 * only ever materialize one of them, silently shadowing the other. Returns
 * one array per colliding group (each with length >= 2); an empty result
 * means no collisions.
 */
export function findCaseFoldCollisions(paths: readonly string[]): string[][] {
  const byFold = new Map<string, string[]>()
  for (const p of paths) {
    const folded = p.toLowerCase()
    const group = byFold.get(folded)
    if (group) group.push(p)
    else byFold.set(folded, [p])
  }
  return [...byFold.values()].filter((group) => group.length > 1)
}

/** Finds exact (byte-identical) duplicate entries in a manifest path list —
 *  distinct from `findCaseFoldCollisions`, which catches near-duplicates
 *  that only collide after case folding. A well-formed filesystem walk
 *  cannot itself produce an exact duplicate, but a manifest built from an
 *  untrusted/attacker-controlled listing must never be trusted to be
 *  well-formed. */
export function findExactDuplicatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const p of paths) {
    if (seen.has(p)) duplicates.add(p)
    else seen.add(p)
  }
  return [...duplicates]
}
