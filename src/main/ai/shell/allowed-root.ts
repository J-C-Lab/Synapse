import * as path from "node:path"

/** True if `candidate` (absolute) is the same as, or nested under, one of `roots`. */
export function isWithinAllowedRoot(candidate: string, roots: readonly string[]): boolean {
  const target = path.resolve(candidate)
  return roots.some((root) => {
    const base = path.resolve(root)
    if (target === base) return true
    const withSep = base.endsWith(path.sep) ? base : base + path.sep
    return target.startsWith(withSep)
  })
}

export type ResolveCwdResult = { ok: true; cwd: string } | { ok: false; reason: string }

/**
 * Resolve the working directory for a shell call. `candidate` may be absolute or
 * relative (resolved against `defaultCwd`). The result must lie within `roots`.
 */
export function resolveCwd(
  candidate: string | undefined,
  defaultCwd: string,
  roots: readonly string[]
): ResolveCwdResult {
  const resolved =
    candidate === undefined || candidate.trim() === ""
      ? path.resolve(defaultCwd)
      : path.resolve(defaultCwd, candidate)
  if (!isWithinAllowedRoot(resolved, roots)) {
    return { ok: false, reason: `cwd is outside the allowed roots: ${resolved}` }
  }
  return { ok: true, cwd: resolved }
}
