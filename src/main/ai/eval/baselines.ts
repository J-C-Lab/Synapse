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

export function checkAgainstBaseline(
  metrics: Record<string, number>,
  baseline: Baseline
): { ok: boolean; regressions: string[] } {
  const regressions = Object.entries(baseline)
    .filter(([key, min]) => (metrics[key] ?? -Infinity) < min)
    .map(([key]) => key)
  return { ok: regressions.length === 0, regressions }
}
