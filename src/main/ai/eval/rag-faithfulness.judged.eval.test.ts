import { describe, expect, it } from "vitest"
import { buildCorrectnessContext, ragScorecardFromResults } from "./rag-faithfulness.judged.eval"

describe("buildCorrectnessContext", () => {
  it("includes the fixture's expectedAnswerContains and the actual answer", () => {
    const context = buildCorrectnessContext(
      "no matching information in this workspace",
      "I cannot find enough information in the provided context."
    )
    expect(context).toContain("no matching information in this workspace")
    expect(context).toContain("I cannot find enough information in the provided context.")
  })
})

describe("ragScorecardFromResults", () => {
  it("a result whose id is in check.regressions is not passed; others are", () => {
    const results = [
      { id: "recall-basic", correctness: 1 as const },
      { id: "scope-isolation", correctness: 0 as const },
    ]
    const check = { ok: false, regressions: ["scope-isolation"] }
    const card = ragScorecardFromResults(results, check)
    const recallBasic = card.results.find((r) => r.id === "recall-basic")!
    const scopeIsolation = card.results.find((r) => r.id === "scope-isolation")!
    expect(recallBasic.passed).toBe(true)
    expect(scopeIsolation.passed).toBe(false)
    expect(recallBasic.gated).toBe(true)
    expect(scopeIsolation.gated).toBe(true)
  })
})
