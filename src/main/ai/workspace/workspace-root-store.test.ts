import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WorkspaceRootStore } from "./workspace-root-store"

function store() {
  return new WorkspaceRootStore(mkdtempSync(join(tmpdir(), "ws-root-store-")), () => 111)
}

describe("workspaceRootStore", () => {
  it("starts empty for listAll and listForWorkspace", async () => {
    const s = store()
    expect(await s.listAll()).toEqual([])
    expect(await s.listForWorkspace("default")).toEqual([])
  })

  it("creates a record with a fresh id and the given role", async () => {
    const s = store()
    const record = await s.create("default", "Project", "/home/proj", "primary")
    expect(record).toEqual({
      id: expect.any(String),
      workspaceId: "default",
      name: "Project",
      root: "/home/proj",
      role: "primary",
      createdAt: 111,
    })
    expect(record.id).not.toBe("")
  })

  it("listForWorkspace returns only that workspace's records", async () => {
    const s = store()
    await s.create("a", "A root", "/a", "primary")
    await s.create("b", "B root", "/b", "primary")
    const forA = await s.listForWorkspace("a")
    expect(forA).toHaveLength(1)
    expect(forA[0]?.workspaceId).toBe("a")
  })

  it("listAll returns everything regardless of owner", async () => {
    const s = store()
    await s.create("a", "A root", "/a", "primary")
    await s.create("b", "B root", "/b", "primary")
    expect(await s.listAll()).toHaveLength(2)
  })

  it("two roots sharing a folder basename keep distinct, stable ids", async () => {
    const s = store()
    const first = await s.create("a", "proj", "/x/proj", "primary")
    const second = await s.create("a", "proj", "/y/proj", "additional")
    expect(first.id).not.toBe(second.id)
    const listedTwice = await s.listAll()
    const listedAgain = await s.listAll()
    expect(listedTwice.map((r) => r.id)).toEqual(listedAgain.map((r) => r.id))
  })

  it("remove deletes only the targeted record", async () => {
    const s = store()
    const a = await s.create("w", "A", "/a", "primary")
    const b = await s.create("w", "B", "/b", "additional")
    await s.remove(a.id)
    const remaining = await s.listForWorkspace("w")
    expect(remaining.map((r) => r.id)).toEqual([b.id])
  })

  it("create with role primary demotes an existing primary in the same workspace", async () => {
    const s = store()
    const first = await s.create("w", "A", "/a", "primary")
    const second = await s.create("w", "B", "/b", "primary")
    const roots = await s.listForWorkspace("w")
    expect(roots.find((r) => r.id === first.id)?.role).toBe("additional")
    expect(roots.find((r) => r.id === second.id)?.role).toBe("primary")
  })

  it("setPrimary promotes the target and demotes whatever else was primary", async () => {
    const s = store()
    const a = await s.create("w", "A", "/a", "primary")
    const b = await s.create("w", "B", "/b", "additional")
    await s.setPrimary(b.id)
    const roots = await s.listForWorkspace("w")
    expect(roots.find((r) => r.id === a.id)?.role).toBe("additional")
    expect(roots.find((r) => r.id === b.id)?.role).toBe("primary")
  })

  it("setPrimary only demotes roots in the same workspace", async () => {
    const s = store()
    const primaryInOther = await s.create("other", "O", "/o", "primary")
    await s.create("w", "A", "/a", "additional")
    const target = await s.create("w", "B", "/b", "additional")
    await s.setPrimary(target.id)
    const others = await s.listForWorkspace("other")
    expect(others.find((r) => r.id === primaryInOther.id)?.role).toBe("primary")
  })

  it("setPrimary throws for an unknown id", async () => {
    await expect(store().setPrimary("ghost")).rejects.toThrow(/not found/i)
  })

  it("remove leaves the workspace with no primary — no auto-promotion", async () => {
    const s = store()
    const primary = await s.create("w", "A", "/a", "primary")
    await s.create("w", "B", "/b", "additional")
    await s.remove(primary.id)
    const roots = await s.listForWorkspace("w")
    expect(roots.some((r) => r.role === "primary")).toBe(false)
  })
})
