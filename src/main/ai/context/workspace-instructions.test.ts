import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadWorkspaceInstructions } from "./workspace-instructions"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-workspace-instructions-"))
  tempDirs.push(root)
  return root
}

describe("loadWorkspaceInstructions", () => {
  it("loads AGENTS.md and CLAUDE.md from authorized workspaces", async () => {
    const root = await tempWorkspace()
    await fs.writeFile(path.join(root, "AGENTS.md"), "Run tests before committing.\n", "utf-8")
    await fs.writeFile(path.join(root, "CLAUDE.md"), "Prefer small commits.\n", "utf-8")

    const instructions = await loadWorkspaceInstructions([{ id: "repo", root }])

    expect(instructions).toEqual([
      { workspaceId: "repo", fileName: "AGENTS.md", text: "Run tests before committing." },
      { workspaceId: "repo", fileName: "CLAUDE.md", text: "Prefer small commits." },
    ])
  })

  it("bounds large instruction files", async () => {
    const root = await tempWorkspace()
    await fs.writeFile(path.join(root, "AGENTS.md"), "x".repeat(100), "utf-8")

    const instructions = await loadWorkspaceInstructions([{ id: "repo", root }], {
      maxCharsPerFile: 10,
      maxTotalChars: 50,
    })

    expect(instructions).toEqual([
      { workspaceId: "repo", fileName: "AGENTS.md", text: "x".repeat(10) },
    ])
  })
})
