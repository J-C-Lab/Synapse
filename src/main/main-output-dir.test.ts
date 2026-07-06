import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { resolveMainOutputDir } from "./main-output-dir"

describe("resolveMainOutputDir", () => {
  it("walks up from lazy chunks to the main bundle directory", () => {
    const mainDir = path.join("/app", "out", "main")
    const exists = (filePath: string) => filePath === path.join(mainDir, "index.js")
    expect(resolveMainOutputDir(path.join(mainDir, "chunks"), exists)).toBe(mainDir)
  })

  it("returns the start directory when it already contains index.js", () => {
    const mainDir = path.join("/app", "out", "main")
    const exists = (filePath: string) => filePath === path.join(mainDir, "index.js")
    expect(resolveMainOutputDir(mainDir, exists)).toBe(mainDir)
  })
})
