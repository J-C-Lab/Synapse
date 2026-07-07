import type { Baseline } from "./baselines"
import type { ScoreResult } from "./fixture-types"
import { checkAgainstBaseline } from "./baselines"

/**
 * Downgrades a result to failed if its metrics regress below the baseline,
 * independent of whatever the scorer's own fixture-level check already found.
 * Concatenates rather than overwrites `detail` so a fixture that fails BOTH
 * its own threshold and the baseline doesn't silently lose one of the two
 * reasons.
 */
export function applyBaseline(result: ScoreResult, baseline: Baseline): ScoreResult {
  const bl = checkAgainstBaseline(result.metrics ?? {}, baseline)
  if (bl.ok) return result
  const baselineDetail = `baseline: ${bl.regressions.join(",")}`
  return {
    ...result,
    passed: false,
    detail: [result.detail, baselineDetail].filter(Boolean).join("; "),
  }
}
