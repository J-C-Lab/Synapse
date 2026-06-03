import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConversationStore } from "./conversation-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ai-conv-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function store(now = () => 1000): ConversationStore {
  return new ConversationStore(dir, now)
}

describe("conversationStore", () => {
  it("saves and reads back a conversation", async () => {
    const s = store()
    await s.save({
      id: "abc",
      title: "Test",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      createdAt: 1,
      updatedAt: 1,
    })
    const loaded = await s.get("abc")
    expect(loaded?.title).toBe("Test")
    expect(loaded?.updatedAt).toBe(1000) // stamped on save
    expect(loaded?.messages[0]?.content[0]).toMatchObject({ type: "text", text: "hi" })
  })

  it("lists summaries newest-first and deletes", async () => {
    let clock = 0
    const s = new ConversationStore(dir, () => ++clock)
    await s.save({ id: "old", messages: [], createdAt: 0, updatedAt: 0 })
    await s.save({ id: "new", messages: [], createdAt: 0, updatedAt: 0 })

    const summaries = await s.list()
    expect(summaries.map((entry) => entry.id)).toEqual(["new", "old"])

    await s.delete("old")
    expect((await s.list()).map((entry) => entry.id)).toEqual(["new"])
  })

  it("returns undefined for a missing conversation and empty list for no dir", async () => {
    expect(await store().get("missing")).toBeUndefined()
    const fresh = new ConversationStore(path.join(dir, "does-not-exist"))
    expect(await fresh.list()).toEqual([])
  })

  it("rejects unsafe conversation ids", async () => {
    await expect(store().get("../escape")).rejects.toThrow(/Invalid conversation id/)
  })
})
