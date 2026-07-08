/**
 * Parses the leading numeric run of a dot-separated version segment, e.g. `"0-beta"` -> `0`,
 * `"10"` -> `10`. Segments with no leading digits (malformed input) fall back to `0`. This keeps
 * `compareVersions` from ever producing `NaN`, which would otherwise silently break `hasUpdate`.
 */
function parseSegment(segment: string): number {
  const match = /^\d+/.exec(segment)
  return match ? Number(match[0]) : 0
}

/**
 * Compares two dotted-numeric version strings. Positive if `a` is newer than `b`.
 *
 * Only the leading numeric run of each dot-segment is compared — prerelease/build-metadata
 * suffixes (e.g. `-beta`, `+build.5`) are not given semver precedence. A version and its own
 * prerelease (e.g. `"1.2.0"` vs `"1.2.0-beta"`) compare as equal. This is a deliberate
 * simplification for a status-indicator use case, not a full semver implementation.
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(parseSegment)
  const partsB = b.split(".").map(parseSegment)
  const length = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** True if `latestVersion` is strictly newer than `installedVersion`. */
export function hasUpdate(installedVersion: string, latestVersion: string): boolean {
  return compareVersions(latestVersion, installedVersion) > 0
}
