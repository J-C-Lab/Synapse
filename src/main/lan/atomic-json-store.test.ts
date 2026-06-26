import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readJsonFile, writeJsonFile } from "./atomic-json-store"

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-atomic-json-"))
  file = path.join(dir, "state.json")
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("writeJsonFile", () => {
  it("uses unique temp files for concurrent writes to the same destination", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeJsonFile(file, { index })))
    const value = await readJsonFile(file)
    expect(value).toEqual(expect.objectContaining({ index: expect.any(Number) }))
  })

  it("serializes writes that spell the same path differently", async () => {
    const relative = path.join(dir, ".", "state.json")
    await Promise.all([
      writeJsonFile(file, { from: "absolute" }),
      writeJsonFile(relative, { from: "relative" }),
    ])
    const value = await readJsonFile(file)
    expect(value).toEqual(expect.objectContaining({ from: expect.any(String) }))
  })
})
