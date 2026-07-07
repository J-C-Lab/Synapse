import type { ScoreResult } from "./fixture-types"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildScorecard, toJUnit, writeScorecard } from "./scorecard"

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

  it("escapes XML-unsafe characters in ids, detail, and suite name", () => {
    const unsafe: ScoreResult[] = [
      {
        id: 'inject"<id>',
        tier: "T0",
        tags: [],
        passed: false,
        gated: true,
        detail: "expected <tag> got <other> & more",
      },
    ]
    const xml = toJUnit(buildScorecard('su&ite"', unsafe, () => 1000))
    expect(xml).not.toContain("<tag>")
    expect(xml).not.toContain("<other>")
    expect(xml).toContain("&lt;tag&gt;")
    expect(xml).toContain("&lt;other&gt;")
    expect(xml).toContain("&amp;")
    expect(xml).toContain("inject&quot;&lt;id&gt;")
    expect(xml).toContain("su&amp;ite&quot;")
  })

  it("writes a JSON scorecard and a matching JUnit file to a nested, not-yet-existing dir", () => {
    const root = mkdtempSync(join(tmpdir(), "scorecard-write-"))
    const dir = join(root, "nested", "eval")
    const card = buildScorecard("demo", results, () => 1000)

    writeScorecard(dir, card)

    expect(existsSync(join(dir, "demo.json"))).toBe(true)
    expect(existsSync(join(dir, "demo.junit.xml"))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, "demo.json"), "utf8"))).toEqual(card)
    expect(readFileSync(join(dir, "demo.junit.xml"), "utf8")).toBe(`${toJUnit(card)}\n`)
  })
})
