import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WorkspaceStore } from "./workspace-store"

function store() {
  return new WorkspaceStore(mkdtempSync(join(tmpdir(), "ws-store-")), () => 111)
}

describe("workspaceStore", () => {
  it("always lists a virtual default first, even with no file", async () => {
    const list = await store().list()
    expect(list[0]).toEqual({ id: "default", name: "Default", createdAt: 0 })
  })

  it("creates, slugifies, persists, and dedupes", async () => {
    const s = store()
    const a = await s.create("My Work")
    expect(a).toEqual({ id: "my-work", name: "My Work", createdAt: 111 })
    const b = await s.create("My Work")
    expect(b.id).toBe("my-work-2")
    expect((await s.list()).map((w) => w.id)).toEqual(["default", "my-work", "my-work-2"])
  })

  it("exists() is always true for default and false for unknown", async () => {
    const s = store()
    expect(await s.exists("default")).toBe(true)
    expect(await s.exists("ghost")).toBe(false)
  })

  it("rejects a blank name", async () => {
    await expect(store().create("   ")).rejects.toThrow(/name is required/i)
  })
})
