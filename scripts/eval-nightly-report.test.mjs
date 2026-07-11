import { describe, expect, it } from "vitest"
import { renderStatus } from "./eval-nightly-report.mjs"

describe("renderStatus", () => {
  it("not configured, regardless of outcome or card contents", () => {
    const result = renderStatus({
      configured: false,
      evalOutcome: "success",
      asrCard: null,
      ragCard: null,
    })
    expect(result.state).toBe("not-configured")
    expect(result.summary).toMatch(/not configured/i)
  })

  it("clean when configured, outcome success, both cards present with no regressions", () => {
    const asrCard = { aggregates: { total: 4, passed: 4 } }
    const ragCard = { aggregates: { total: 2, passed: 2 } }
    const result = renderStatus({ configured: true, evalOutcome: "success", asrCard, ragCard })
    expect(result.state).toBe("clean")
  })

  it("regressed when configured, outcome failure, a card shows a below-baseline result", () => {
    const asrCard = {
      aggregates: { total: 4, passed: 3 },
      results: [{ id: "tool-description-0", passed: false, gated: false }],
    }
    const ragCard = {
      aggregates: { total: 2, passed: 1 },
      results: [{ id: "scope-isolation", passed: false, gated: true }],
    }
    const result = renderStatus({ configured: true, evalOutcome: "failure", asrCard, ragCard })
    expect(result.state).toBe("regressed")
    expect(result.summary).toContain("scope-isolation")
  })

  it("incomplete when configured but a scorecard is missing", () => {
    const result = renderStatus({
      configured: true,
      evalOutcome: "failure",
      asrCard: null,
      ragCard: { aggregates: { total: 2, passed: 2 } },
    })
    expect(result.state).toBe("incomplete")
  })

  it("a failure outcome with clean-looking cards still renders as incomplete, not clean", () => {
    const asrCard = { aggregates: { total: 4, passed: 4 } }
    const ragCard = { aggregates: { total: 2, passed: 2 } }
    const result = renderStatus({ configured: true, evalOutcome: "failure", asrCard, ragCard })
    expect(result.state).toBe("incomplete")
  })
})
