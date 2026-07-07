import type { ScoreResult } from "./fixture-types"
import { describe, expect, it } from "vitest"
import { applyBaseline } from "./apply-baseline"

const passingResult: ScoreResult = {
  id: "r1",
  tier: "T1",
  tags: [],
  passed: true,
  gated: true,
  metrics: { recall: 1, scopeIsolation: 1 },
}

describe("applyBaseline", () => {
  it("passes a result through unchanged when it meets the baseline", () => {
    expect(applyBaseline(passingResult, { recall: 1 })).toEqual(passingResult)
  })

  it("downgrades a result whose metrics regress below the baseline", () => {
    const r = applyBaseline(passingResult, { scopeIsolation: 1.5 })
    expect(r.passed).toBe(false)
    expect(r.detail).toBe("baseline: scopeIsolation")
  })

  it("concatenates the baseline detail onto an existing fixture-level detail rather than overwriting it", () => {
    const alreadyFailing: ScoreResult = {
      ...passingResult,
      passed: false,
      detail: "precision@3 0.00 < 0.30",
    }
    const r = applyBaseline(alreadyFailing, { scopeIsolation: 1.5 })
    expect(r.detail).toBe("precision@3 0.00 < 0.30; baseline: scopeIsolation")
  })
})
