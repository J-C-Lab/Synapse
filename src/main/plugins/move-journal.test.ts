import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MoveJournal } from "./move-journal"

describe("move-journal", () => {
  let dir: string
  let journalPath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-journal-"))
    journalPath = path.join(dir, "move-journal.json")
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("commits an entry before the write and returns a host-minted journalId", async () => {
    const journal = new MoveJournal(journalPath)
    const id = await journal.commit({
      pluginId: "com.example.org",
      fromRootId: "r1",
      fromRel: "a.txt",
      toRootId: "r1",
      toRel: "images/a.txt",
      size: 3,
    })

    expect(id).toMatch(/.+/)
    const entry = await journal.get(id)
    expect(entry?.fromRel).toBe("a.txt")
    expect(entry?.pluginId).toBe("com.example.org")
  })

  it("looks up by id and scopes lookup to the owning plugin", async () => {
    const journal = new MoveJournal(journalPath)
    const id = await journal.commit({
      pluginId: "com.example.org",
      fromRootId: "r1",
      fromRel: "a.txt",
      toRootId: "r1",
      toRel: "b.txt",
      size: 1,
    })

    expect(await journal.getForPlugin(id, "com.example.org")).toBeDefined()
    expect(await journal.getForPlugin(id, "other.plugin")).toBeUndefined()
  })

  it("marks an entry rolled back so it cannot be reversed twice", async () => {
    const journal = new MoveJournal(journalPath)
    const id = await journal.commit({
      pluginId: "p",
      fromRootId: "r1",
      fromRel: "a.txt",
      toRootId: "r1",
      toRel: "b.txt",
      size: 1,
    })

    await journal.markRolledBack(id)
    expect((await journal.get(id))?.rolledBackAt).toBeTypeOf("number")
  })
})
