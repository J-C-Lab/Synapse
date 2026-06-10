import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MemoryStore } from "./memory-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-memstore-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("memoryStore", () => {
  it("adds, reads back across instances, and removes", async () => {
    const file = path.join(dir, "memory.json")
    const a = new MemoryStore(file)
    await a.add({ id: "1", text: "hello", tags: ["x"], createdAt: 1, embedding: [0.1, 0.2] })

    const reloaded = await new MemoryStore(file).all()
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]).toMatchObject({
      id: "1",
      text: "hello",
      tags: ["x"],
      embedding: [0.1, 0.2],
    })

    expect(await new MemoryStore(file).remove("1")).toBe(true)
  })

  it("adds many entries in one write", async () => {
    const file = path.join(dir, "memory.json")
    const store = new MemoryStore(file)
    await store.addMany([
      { id: "1", text: "a", tags: [], createdAt: 1 },
      { id: "2", text: "b", tags: [], createdAt: 2 },
    ])
    const reloaded = await new MemoryStore(file).all()
    expect(reloaded.map((entry) => entry.id)).toEqual(["1", "2"])
  })

  it("removes many entries by id in one write and reports the count", async () => {
    const file = path.join(dir, "memory.json")
    const store = new MemoryStore(file)
    await store.addMany([
      { id: "1", text: "a", tags: [], createdAt: 1 },
      { id: "2", text: "b", tags: [], createdAt: 2 },
      { id: "3", text: "c", tags: [], createdAt: 3 },
    ])

    expect(await store.removeMany(["1", "3", "missing"])).toBe(2)
    expect((await new MemoryStore(file).all()).map((entry) => entry.id)).toEqual(["2"])
  })

  it("drops malformed entries when loading", async () => {
    const file = path.join(dir, "memory.json")
    await fs.writeFile(
      file,
      JSON.stringify([{ id: "ok", text: "fine" }, { id: "no-text" }, { text: "no-id" }, "garbage"]),
      "utf-8"
    )
    const entries = await new MemoryStore(file).all()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: "ok", text: "fine", tags: [] })
  })
})
