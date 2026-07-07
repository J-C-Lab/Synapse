import type { ScoreResult } from "./fixture-types"
import { describe, expect, it } from "vitest"
import { buildScorecard, toJUnit } from "./scorecard"

const results: ScoreResult[] = [
  { id: "ok", tier: "T0", tags: [], passed: true, gated: true },
  { id: "bad", tier: "T0", tags: [], passed: false, gated: true, detail: "mismatch" },
  { id: "note", tier: "T0", tags: ["finding"], passed: false, gated: false },
]

describe("scorecard", () => {
  it("aggregates gated failures and pass rate", () => {
    const card = buildScorecard("demo", results, () => 1000)
    expect(card.aggregates.gatedFailures).toBe(1)
    expect(card.aggregates.total).toBe(3)
    expect(card.generatedAt).toBe(1000)
  })

  it("renders JUnit with a failure for the gated miss only", () => {
    const xml = toJUnit(buildScorecard("demo", results, () => 1000))
    expect(xml).toContain('tests="3"')
    expect(xml).toContain('failures="1"')
    expect(xml).toContain('name="bad"')
  })
})
