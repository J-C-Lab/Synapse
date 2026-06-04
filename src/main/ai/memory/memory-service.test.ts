import type { Embedder } from "./openai-embedding-provider"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cosineSimilarity, MemoryService } from "./memory-service"
import { MemoryStore } from "./memory-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-mem-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function store(): MemoryStore {
  return new MemoryStore(path.join(dir, "memory.json"))
}

// Deterministic fake embedder: maps known phrases to fixed vectors.
function fakeEmbedder(map: Record<string, number[]>): Embedder {
  return {
    embed: async (texts) => texts.map((text) => map[text] ?? [0, 0, 0]),
  }
}

let counter = 0
function service(embedder: Embedder): MemoryService {
  counter = 0
  return new MemoryService(
    store(),
    embedder,
    () => 1000,
    () => `id${++counter}`
  )
}

describe("memoryService", () => {
  it("saves with an embedding and recalls by cosine similarity", async () => {
    const vectors = {
      cats: [1, 0, 0],
      dogs: [0, 1, 0],
      "feline pets": [0.9, 0.1, 0],
    }
    const svc = service(fakeEmbedder(vectors))
    await svc.save({ text: "cats" })
    await svc.save({ text: "dogs" })

    const hits = await svc.search("feline pets")
    expect(hits[0]?.entry.text).toBe("cats")
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it("falls back to lexical search when embeddings are unavailable", async () => {
    const svc = service({ embed: async () => null })
    await svc.save({ text: "the deploy script lives in scripts/deploy.sh" })
    await svc.save({ text: "unrelated note about coffee" })

    const hits = await svc.search("deploy script")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.entry.text).toContain("deploy")
  })

  it("lists newest first and deletes by id", async () => {
    let clock = 0
    const svc = new MemoryService(
      store(),
      { embed: async () => null },
      () => ++clock,
      () => `id${++counter}`
    )
    counter = 0
    const first = await svc.save({ text: "first" })
    await svc.save({ text: "second" })

    const list = await svc.list()
    expect(list.map((entry) => entry.text)).toEqual(["second", "first"])

    expect(await svc.delete(first.id)).toBe(true)
    expect(await svc.delete("missing")).toBe(false)
    expect(await svc.list()).toHaveLength(1)
  })

  it("rejects empty text", async () => {
    const svc = service({ embed: async () => null })
    await expect(svc.save({ text: "   " })).rejects.toThrow(/empty/)
  })
})

describe("cosineSimilarity", () => {
  it("is 1 for identical and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })
})
