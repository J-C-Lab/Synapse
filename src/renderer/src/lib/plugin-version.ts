/** Compares two dotted-numeric version strings. Positive if `a` is newer than `b`. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number)
  const partsB = b.split(".").map(Number)
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
