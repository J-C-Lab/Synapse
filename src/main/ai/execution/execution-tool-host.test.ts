import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ExecutionLogStore } from "./execution-log-store"
import { ExecutionToolHostSource } from "./execution-tool-host"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-host-"))
  tempDirs.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content)
  }
  return root
}

function host(root: string, logFile: string): ExecutionToolHostSource {
  return new ExecutionToolHostSource({
    workspaces: { listWorkspaces: () => [{ id: "repo", root }] },
    log: new ExecutionLogStore(logFile),
    now: () => 1000,
  })
}

describe("executionToolHostSource", () => {
  it("lists no tools when no workspace is authorized", () => {
    const source = new ExecutionToolHostSource({
      workspaces: { listWorkspaces: () => [] },
      log: new ExecutionLogStore(path.join(os.tmpdir(), "unused.json")),
    })
    expect(source.listTools()).toEqual([])
  })

  it("lists read and write tools when a workspace exists", async () => {
    const root = await makeWorkspace()
    const source = host(root, path.join(root, "log.json"))
    expect(source.listTools().map((tool) => tool.fqName)).toEqual([
      "execution:core/list_files",
      "execution:core/read_file",
      "execution:core/search_files",
      "execution:core/apply_patch",
      "execution:core/run_command",
    ])
  })

  it("reads and searches files inside the workspace", async () => {
    const root = await makeWorkspace({ "src/a.ts": "export const FIXME = 1\n" })
    const source = host(root, path.join(root, "log.json"))
    const caller = { kind: "agent" as const, conversationId: "c1" }

    const listed = await source.invokeTool(
      "execution:core/list_files",
      { workspaceId: "repo", path: "src" },
      { caller }
    )
    expect(listed.content[0]).toMatchObject({ type: "text" })
    expect((listed.content[0] as { text: string }).text).toContain("a.ts")

    const read = await source.invokeTool(
      "execution:core/read_file",
      { workspaceId: "repo", path: "src/a.ts" },
      { caller }
    )
    expect((read.content[0] as { text: string }).text).toContain("export const FIXME")

    const search = await source.invokeTool(
      "execution:core/search_files",
      { workspaceId: "repo", query: "FIXME", path: "." },
      { caller }
    )
    expect((search.content[0] as { text: string }).text).toContain("FIXME")
  })

  it("rejects paths outside the workspace", async () => {
    const root = await makeWorkspace()
    const source = host(root, path.join(root, "log.json"))
    const result = await source.invokeTool(
      "execution:core/read_file",
      { workspaceId: "repo", path: "../secret.txt" },
      { caller: { kind: "agent" } }
    )
    expect(result.isError).toBe(true)
  })

  it("denies forbidden commands at invoke time", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const source = host(root, logFile)
    const result = await source.invokeTool(
      "execution:core/run_command",
      { workspaceId: "repo", command: "rm -rf /" },
      { caller: { kind: "agent", conversationId: "c1" } }
    )
    expect(result.isError).toBe(true)
    await expect(new ExecutionLogStore(logFile).list()).resolves.toEqual([
      expect.objectContaining({ decision: "deny" }),
    ])
  })

  it("records approved audit decisions for user-confirmed writes", async () => {
    const root = await makeWorkspace({ "src/a.ts": "alpha\nbeta\n" })
    const logFile = path.join(root, "log.json")
    const source = host(root, logFile)
    await source.invokeTool(
      "execution:core/apply_patch",
      {
        workspaceId: "repo",
        patch: `*** Begin Patch
*** Update File: src/a.ts
 alpha
-beta
+gamma
*** End Patch`,
      },
      { caller: { kind: "agent", conversationId: "c1" }, executionAuditDecision: "approved" }
    )
    await expect(new ExecutionLogStore(logFile).list()).resolves.toEqual([
      expect.objectContaining({ decision: "approved" }),
    ])
  })
})
