/**
 * Whether a manifest's `engines.synapse` range is satisfied by `hostVersion`.
 *
 * Supports `"*"` (any), an exact `x.y.z`, and caret `^x.y.z` ranges using
 * npm-style caret semantics (0.x and 0.0.x lock more tightly).
 */
export function isEngineCompatible(range: string, hostVersion: string): boolean {
  if (range === "*") return true

  const host = parseSemver(hostVersion)
  if (!host) return false

  if (range.startsWith("^")) {
    const min = parseSemver(range.slice(1))
    if (!min || compareSemver(host, min) < 0) return false
    return compareSemver(host, caretUpperBound(min)) < 0
  }

  const exact = parseSemver(range)
  return exact ? compareSemver(host, exact) === 0 : false
}

interface Semver {
  major: number
  minor: number
  patch: number
}

function parseSemver(value: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function caretUpperBound(min: Semver): Semver {
  if (min.major > 0) return { major: min.major + 1, minor: 0, patch: 0 }
  if (min.minor > 0) return { major: 0, minor: min.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: min.patch + 1 }
}
