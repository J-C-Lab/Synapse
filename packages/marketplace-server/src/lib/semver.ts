interface Parsed {
  major: number
  minor: number
  patch: number
}

function parse(version: string): Parsed | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Compare two semver strings by their release triple: negative if a < b, 0 if
 * equal, positive if a > b. Pre-release/build metadata is ignored for ordering
 * (sufficient for publish monotonicity in M2).
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch
}
