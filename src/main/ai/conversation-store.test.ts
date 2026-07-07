import { promises as fs, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConversationStore } from "./conversation-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-ai-conv-"))
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
      workspaceId: "default",
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
    await s.save({ id: "old", workspaceId: "default", messages: [], createdAt: 0, updatedAt: 0 })
    await s.save({ id: "new", workspaceId: "default", messages: [], createdAt: 0, updatedAt: 0 })

    const summaries = await s.list()
    expect(summaries.map((entry) => entry.id)).toEqual(["new", "old"])

    await s.delete("old")
    expect((await s.list()).map((entry) => entry.id)).toEqual(["new"])
  })

  it("returns undefined for a missing conversation and empty list for no dir", async () => {
    expect(await store().get("missing")).toBeUndefined()
    const fresh = new ConversationStore(join(dir, "does-not-exist"))
    expect(await fresh.list()).toEqual([])
  })

  it("rejects unsafe conversation ids", async () => {
    await expect(store().get("../escape")).rejects.toThrow(/Invalid conversation id/)
  })

  it("defaults a missing workspaceId to 'default' on read", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "conv-ws-"))
    writeFileSync(
      join(legacyDir, "c1.json"),
      JSON.stringify({ id: "c1", messages: [], createdAt: 1, updatedAt: 1 })
    )
    const legacyStore = new ConversationStore(legacyDir)
    expect((await legacyStore.get("c1"))?.workspaceId).toBe("default")
  })

  it("round-trips an explicit workspaceId", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "conv-ws2-"))
    const wsStore = new ConversationStore(wsDir)
    await wsStore.save({
      id: "c2",
      workspaceId: "work",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })
    expect((await wsStore.get("c2"))?.workspaceId).toBe("work")
  })

  it("includes workspaceId in list summaries", async () => {
    const s = store()
    await s.save({ id: "c3", workspaceId: "work", messages: [], createdAt: 1, updatedAt: 1 })
    expect((await s.list())[0]).toMatchObject({ id: "c3", workspaceId: "work" })
  })
})
