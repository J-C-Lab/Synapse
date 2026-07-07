import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHeadlessMemoryService } from "./headless-memory"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-headless-mem-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("createHeadlessMemoryService", () => {
  it("saves and recalls a memory via lexical search, with no embedder key configured", async () => {
    const memory = createHeadlessMemoryService(dir)
    await memory.save({ text: "the deploy key rotates every quarter" })

    const hits = await memory.search("deploy key rotates")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.entry.text).toBe("the deploy key rotates every quarter")
    // Lexical-only: no embedder ran, so no vector was stored.
    expect(hits[0]?.entry.embedding).toBeUndefined()
  })

  it("persists to the shared per-userDataDir memory file", async () => {
    const first = createHeadlessMemoryService(dir)
    await first.save({ text: "persisted fact" })

    const second = createHeadlessMemoryService(dir)
    const entries = await second.list()
    expect(entries.map((e) => e.text)).toContain("persisted fact")
  })
})
