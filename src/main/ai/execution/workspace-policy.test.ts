import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { WorkspacePolicy } from "./workspace-policy"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ws-"))
  tempDirs.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content)
  }
  return root
}

describe("workspacePolicy", () => {
  it("resolves relative paths inside a workspace root", async () => {
    const root = await makeWorkspace({ "src/a.ts": "export const a = 1\n" })
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    await expect(policy.resolvePath("repo", "src/a.ts")).resolves.toMatchObject({
      workspaceId: "repo",
      relativePath: "src/a.ts",
    })
  })

  it("rejects parent-directory escapes", async () => {
    const root = await makeWorkspace({})
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    await expect(policy.resolvePath("repo", "../secret.txt")).rejects.toThrow("outside workspace")
  })

  it("allows nested paths whose final directories do not exist yet", async () => {
    const root = await makeWorkspace({})
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    await expect(policy.resolvePath("repo", "a/b/new-file.ts")).resolves.toMatchObject({
      workspaceId: "repo",
      relativePath: "a/b/new-file.ts",
    })
  })
})
