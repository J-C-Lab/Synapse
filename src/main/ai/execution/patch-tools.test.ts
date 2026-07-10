import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { applyPatch } from "./patch-tools"
import { WorkspacePolicy } from "./workspace-policy"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-patch-"))
  tempDirs.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content)
  }
  return root
}

describe("applyPatch", () => {
  it("adds a new file inside the workspace", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const value = 1
*** End Patch`
    const result = await applyPatch(policy, { rootId: "repo", patch })
    expect(result.isError).not.toBe(true)
    await expect(fs.readFile(path.join(root, "src/new.ts"), "utf8")).resolves.toBe(
      "export const value = 1"
    )
  })

  it("updates an existing file", async () => {
    const root = await makeWorkspace({ "src/a.ts": "alpha\nbeta\n" })
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const patch = `*** Begin Patch
*** Update File: src/a.ts
 alpha
-beta
+gamma
*** End Patch`
    await applyPatch(policy, { rootId: "repo", patch })
    await expect(fs.readFile(path.join(root, "src/a.ts"), "utf8")).resolves.toBe("alpha\ngamma\n")
  })

  it("updates a middle section without anchoring at line 1", async () => {
    const root = await makeWorkspace({ "src/a.ts": "l1\nl2\nl3\nl4\n" })
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@ -2,2 +2,2 @@
 l2
-l3
+l3-updated
*** End Patch`
    await applyPatch(policy, { rootId: "repo", patch })
    await expect(fs.readFile(path.join(root, "src/a.ts"), "utf8")).resolves.toBe(
      "l1\nl2\nl3-updated\nl4\n"
    )
  })

  it("rejects paths outside the workspace", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const patch = `*** Begin Patch
*** Add File: ../escape.ts
+bad
*** End Patch`
    await expect(applyPatch(policy, { rootId: "repo", patch })).rejects.toThrow(/outside workspace/)
  })
})
