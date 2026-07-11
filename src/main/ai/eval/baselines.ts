import { existsSync, readFileSync } from "node:fs"

/** Baseline = the minimum acceptable value per metric (higher is better). */
export type Baseline = Record<string, number>

export function loadBaseline(file: string): Baseline {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Baseline
  } catch (err) {
    throw new Error(
      `Baseline ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Like loadBaseline(), but throws instead of silently returning `{}` when
 * the file is missing. A gate whose baseline file doesn't exist would
 * otherwise pass vacuously (checkAgainstBaseline against an empty object
 * has nothing to fail against) — exactly the "gate that never gates" bug
 * this baseline exists to prevent, just moved one file over. Use this for
 * any baseline a real assertion depends on; loadBaseline() stays as-is
 * for genuinely optional lookups.
 */
export function loadRequiredBaseline(file: string): Baseline {
  if (!existsSync(file)) {
    throw new Error(`Required baseline file does not exist: ${file}`)
  }
  const baseline = loadBaseline(file)
  const entries = Object.entries(baseline)
  if (entries.length === 0) {
    throw new Error(`Required baseline file is empty: ${file}`)
  }
  for (const [metric, threshold] of entries) {
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      throw new TypeError(
        `Required baseline ${file} has a non-finite numeric threshold for "${metric}"`
      )
    }
  }
  return baseline
}

export function checkAgainstBaseline(
  metrics: Record<string, number>,
  baseline: Baseline
): { ok: boolean; regressions: string[] } {
  const regressions = Object.entries(baseline)
    .filter(([key, min]) => (metrics[key] ?? -Infinity) < min)
    .map(([key]) => key)
  return { ok: regressions.length === 0, regressions }
}
