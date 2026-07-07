import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadFixtures } from "./fixture-types"

describe("loadFixtures", () => {
  it("loads *.json fixtures from a dir and skips non-json", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-fx-"))
    writeFileSync(
      join(dir, "a.json"),
      JSON.stringify({ id: "a", title: "A", tier: "T0", tags: [] })
    )
    writeFileSync(join(dir, "readme.txt"), "ignore me")
    const loaded = loadFixtures(dir)
    expect(loaded.map((f) => f.id)).toEqual(["a"])
  })

  it("throws on a fixture missing an id", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-fx2-"))
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ title: "no id" }))
    expect(() => loadFixtures(dir)).toThrow(/id/)
  })
})
