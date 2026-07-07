import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { checkAgainstBaseline, loadBaseline } from "./baselines"

describe("checkAgainstBaseline", () => {
  it("passes when metrics meet or beat the baseline", () => {
    const r = checkAgainstBaseline(
      { recall: 1, precisionAt3: 0.5 },
      { recall: 1, precisionAt3: 0.3 }
    )
    expect(r.ok).toBe(true)
  })
  it("fails and names the metric that regressed", () => {
    const r = checkAgainstBaseline({ recall: 0.5 }, { recall: 1 })
    expect(r.ok).toBe(false)
    expect(r.regressions).toContain("recall")
  })
})

describe("loadBaseline", () => {
  it("reads and parses a baseline JSON file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "baselines-"))
    try {
      const file = join(dir, "rag.json")
      writeFileSync(file, JSON.stringify({ recall: 1, precisionAt3: 0.3 }))

      expect(loadBaseline(file)).toEqual({ recall: 1, precisionAt3: 0.3 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns an empty baseline when the file does not exist", () => {
    expect(loadBaseline(join(tmpdir(), "does-not-exist-baseline.json"))).toEqual({})
  })
})
