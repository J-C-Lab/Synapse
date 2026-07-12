import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_WORKSPACE, WorkspaceStore } from "./workspace-store"

let dir: string
let store: WorkspaceStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "workspace-store-"))
  store = new WorkspaceStore(dir, () => 111)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("list/get/exists", () => {
  it("list() excludes archived by default; includeArchived includes them", async () => {
    const w = await store.create("Project A")
    expect((await store.list()).map((x) => x.id)).toEqual(["default", w.id])
    expect((await store.list({ includeArchived: true })).map((x) => x.id)).toEqual([
      "default",
      w.id,
    ])
  })

  it("get()/exists() resolve DEFAULT_WORKSPACE", async () => {
    expect(await store.get("default")).toEqual(DEFAULT_WORKSPACE)
    expect(await store.exists("default")).toBe(true)
  })

  it("get()/exists() return undefined/false for an unknown id", async () => {
    expect(await store.get("nope")).toBeUndefined()
    expect(await store.exists("nope")).toBe(false)
  })

  it("always lists a virtual default first, even with no file", async () => {
    const list = await store.list()
    expect(list[0]).toEqual(DEFAULT_WORKSPACE)
  })

  it("creates, slugifies, persists, and dedupes", async () => {
    const a = await store.create("My Work")
    expect(a).toEqual({ id: "my-work", name: "My Work", createdAt: 111 })
    const b = await store.create("My Work")
    expect(b.id).toBe("my-work-2")
    expect((await store.list()).map((w) => w.id)).toEqual(["default", "my-work", "my-work-2"])
  })

  it("rejects a blank name on create", async () => {
    await expect(store.create("   ")).rejects.toThrow(/name is required/i)
  })
})

describe("rename", () => {
  it("updates name, leaves id untouched", async () => {
    const w = await store.create("Project A")
    const renamed = await store.rename(w.id, "Project A (renamed)")
    expect(renamed.id).toBe(w.id)
    expect(renamed.name).toBe("Project A (renamed)")
    expect(await store.get(w.id)).toEqual(renamed)
  })

  it("rejects an empty name", async () => {
    const w = await store.create("Project A")
    await expect(store.rename(w.id, "   ")).rejects.toThrow("Workspace name is required")
  })

  it("rejects id === 'default'", async () => {
    await expect(store.rename("default", "New Name")).rejects.toThrow(
      "Cannot rename the default workspace"
    )
  })

  it("rejects an unknown id", async () => {
    await expect(store.rename("nope", "New Name")).rejects.toThrow("Unknown workspace: nope")
  })
})

describe("archive/unarchive", () => {
  it("archive() sets archived: true; the workspace disappears from the default list() but not includeArchived", async () => {
    const w = await store.create("Project A")
    const archived = await store.archive(w.id)
    expect(archived.archived).toBe(true)
    expect((await store.list()).map((x) => x.id)).toEqual(["default"])
    expect((await store.list({ includeArchived: true })).map((x) => x.id)).toEqual([
      "default",
      w.id,
    ])
  })

  it("get()/exists() resolve an archived workspace", async () => {
    const w = await store.create("Project A")
    await store.archive(w.id)
    expect(await store.get(w.id)).toMatchObject({ id: w.id, archived: true })
    expect(await store.exists(w.id)).toBe(true)
  })

  it("unarchive() removes the archived key entirely — not archived: false", async () => {
    const w = await store.create("Project A")
    await store.archive(w.id)
    const unarchived = await store.unarchive(w.id)
    expect(unarchived).not.toHaveProperty("archived")
    const raw = readFileSync(path.join(dir, "workspaces.json"), "utf-8")
    expect(raw).not.toContain('"archived"')
  })

  it("archive()/unarchive() are idempotent", async () => {
    const w = await store.create("Project A")
    await store.archive(w.id)
    const archivedAgain = await store.archive(w.id)
    expect(archivedAgain.archived).toBe(true)
    await store.unarchive(w.id)
    const unarchivedAgain = await store.unarchive(w.id)
    expect(unarchivedAgain).not.toHaveProperty("archived")
  })

  it("both reject id === 'default'", async () => {
    await expect(store.archive("default")).rejects.toThrow("Cannot archive the default workspace")
    await expect(store.unarchive("default")).rejects.toThrow("Cannot archive the default workspace")
  })

  it("both reject an unknown id", async () => {
    await expect(store.archive("nope")).rejects.toThrow("Unknown workspace: nope")
    await expect(store.unarchive("nope")).rejects.toThrow("Unknown workspace: nope")
  })
})

describe("isActive/isArchived", () => {
  it("true/false pair for an active workspace", async () => {
    const w = await store.create("Project A")
    expect(await store.isActive(w.id)).toBe(true)
    expect(await store.isArchived(w.id)).toBe(false)
  })

  it("flips for an archived workspace", async () => {
    const w = await store.create("Project A")
    await store.archive(w.id)
    expect(await store.isActive(w.id)).toBe(false)
    expect(await store.isArchived(w.id)).toBe(true)
  })

  it("both false for an unknown id — neither throws", async () => {
    expect(await store.isActive("nope")).toBe(false)
    expect(await store.isArchived("nope")).toBe(false)
  })

  it("default workspace is always active", async () => {
    expect(await store.isActive("default")).toBe(true)
    expect(await store.isArchived("default")).toBe(false)
  })
})

describe("concurrency", () => {
  it("a concurrent rename() + archive() on the same workspace loses neither mutation", async () => {
    const w = await store.create("Project A")
    await Promise.all([store.rename(w.id, "Renamed"), store.archive(w.id)])
    const final = await store.get(w.id)
    expect(final?.name).toBe("Renamed")
    expect(final?.archived).toBe(true)
  })
})

describe("isWorkspace type guard", () => {
  it("rejects archived with wrong type via readStored filter", async () => {
    const file = path.join(dir, "workspaces.json")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(file, JSON.stringify([{ id: "bad", name: "Bad", createdAt: 1, archived: "yes" }]))
    expect((await store.list({ includeArchived: true })).map((w) => w.id)).toEqual(["default"])
  })
})
