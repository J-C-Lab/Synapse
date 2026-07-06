import { describe, expect, it } from "vitest"
import { bm25Scores, tokenize } from "./bm25"

describe("tokenize", () => {
  it("lowercases and splits alphanumeric/identifier runs", () => {
    expect(tokenize("Deploy the TS2741 fix in mcp_stdio")).toEqual([
      "deploy",
      "the",
      "ts2741",
      "fix",
      "in",
      "mcp_stdio",
    ])
  })

  it("emits unigrams and bigrams for CJK runs (no whitespace to split on)", () => {
    // 退款 → {退, 款, 退款} — so a Chinese query term matches without word breaks.
    // Order is irrelevant (bag of terms); assert membership.
    expect(new Set(tokenize("退款"))).toEqual(new Set(["退", "款", "退款"]))
  })
})

describe("bm25Scores", () => {
  const docs = (entries: Record<string, string>) =>
    Object.entries(entries).map(([id, text]) => ({ id, text }))

  it("scores a doc containing the query term above one that doesn't", () => {
    const scores = bm25Scores("deploy", docs({ a: "deploy the app", b: "unrelated coffee note" }))
    expect(scores.get("a")!).toBeGreaterThan(0)
    expect(scores.get("b")).toBe(0)
  })

  it("weights rarer terms more heavily (idf)", () => {
    // "common" appears in 3 docs, "rare" in 1. A doc matching only the rare
    // term should outscore a doc matching only the common one.
    const scores = bm25Scores(
      "common rare",
      docs({
        d1: "common word here",
        d2: "common word there",
        d3: "common word everywhere",
        dr: "rare token alone",
      })
    )
    expect(scores.get("dr")!).toBeGreaterThan(scores.get("d1")!)
  })

  it("matches an exact high-entropy identifier the way keyword search should", () => {
    const scores = bm25Scores(
      "TS2741",
      docs({ hit: "fix for TS2741 missing property", miss: "general error handling notes" })
    )
    expect(scores.get("hit")!).toBeGreaterThan(0)
    expect(scores.get("miss")).toBe(0)
  })

  it("returns an empty map for a blank query", () => {
    expect(bm25Scores("   ", docs({ a: "anything" })).size).toBe(0)
  })
})
