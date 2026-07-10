import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { migrateAgentShellRoots } from "./workspace-migration"
import { WorkspaceRootStore } from "./workspace-root-store"

function store() {
  return new WorkspaceRootStore(mkdtempSync(join(tmpdir(), "ws-migration-")), () => 222)
}

describe("migrateAgentShellRoots", () => {
  it("does nothing when there are no legacy roots", async () => {
    const s = store()
    await migrateAgentShellRoots(s, [], true)
    expect(await s.listAll()).toEqual([])
  })

  it("does nothing when allowAgentShell is false, even with legacy roots", async () => {
    const s = store()
    await migrateAgentShellRoots(s, ["/a", "/b"], false)
    expect(await s.listAll()).toEqual([])
  })

  it("migrates the first root as primary, the rest as additional, into the default workspace", async () => {
    const s = store()
    await migrateAgentShellRoots(s, ["/a", "/b", "/c"], true)
    const roots = await s.listForWorkspace("default")
    expect(roots).toHaveLength(3)
    expect(roots.find((r) => r.root === "/a")?.role).toBe("primary")
    expect(roots.find((r) => r.root === "/b")?.role).toBe("additional")
    expect(roots.find((r) => r.root === "/c")?.role).toBe("additional")
  })

  it("assigns each migrated root a distinct generated id, even for a shared basename", async () => {
    const s = store()
    await migrateAgentShellRoots(s, ["/x/proj", "/y/proj"], true)
    const roots = await s.listForWorkspace("default")
    expect(roots[0]?.id).not.toBe(roots[1]?.id)
  })

  it("is idempotent — running it twice does not duplicate records", async () => {
    const s = store()
    await migrateAgentShellRoots(s, ["/a", "/b"], true)
    await migrateAgentShellRoots(s, ["/a", "/b"], true)
    expect(await s.listForWorkspace("default")).toHaveLength(2)
  })
})
