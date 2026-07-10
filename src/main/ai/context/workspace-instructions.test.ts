import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import { symlink } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, describe, expect, it } from "vitest"
import { loadWorkspaceInstructions, readBounded } from "./workspace-instructions"

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

  it.skipIf(process.platform === "win32")(
    "does not read a symlink that escapes the workspace root",
    async () => {
      const root = await tempWorkspace()
      const outside = await tempWorkspace()
      await fs.writeFile(path.join(outside, "secret.txt"), "outside content", "utf-8")
      await symlink(path.join(outside, "secret.txt"), path.join(root, "AGENTS.md"))

      const instructions = await loadWorkspaceInstructions([{ id: "repo", root }])

      expect(instructions).toEqual([])
    }
  )

  it.skipIf(process.platform === "win32")(
    "still reads a symlink that points inside the same root",
    async () => {
      const root = await tempWorkspace()
      await fs.mkdir(path.join(root, "docs"), { recursive: true })
      await fs.writeFile(
        path.join(root, "docs", "real.md"),
        "Run tests before committing.\n",
        "utf-8"
      )
      await symlink(path.join(root, "docs", "real.md"), path.join(root, "AGENTS.md"))

      const instructions = await loadWorkspaceInstructions([{ id: "repo", root }])

      expect(instructions).toEqual([
        { workspaceId: "repo", fileName: "AGENTS.md", text: "Run tests before committing." },
      ])
    }
  )

  it("never loads more than a bounded amount of a large file into memory", async () => {
    const root = await tempWorkspace()
    const oneMb = "y".repeat(1_000_000)
    await fs.writeFile(path.join(root, "AGENTS.md"), oneMb, "utf-8")

    const instructions = await loadWorkspaceInstructions([{ id: "repo", root }], {
      maxCharsPerFile: 100,
      maxTotalChars: 100,
    })

    expect(instructions[0]?.text.length).toBe(100)
  })
})

describe("readBounded", () => {
  it("readBounded's output size is capped by maxBytes regardless of source file size", async () => {
    const root = await tempWorkspace()
    const fiveMb = "z".repeat(5_000_000)
    await fs.writeFile(path.join(root, "big.txt"), fiveMb, "utf-8")

    const result = await readBounded(path.join(root, "big.txt"), 1000)

    expect(result).toBeDefined()
    expect(Buffer.byteLength(result!, "utf-8")).toBeLessThanOrEqual(1000)
  })

  it("readBounded returns undefined for a missing file", async () => {
    const root = await tempWorkspace()
    const result = await readBounded(path.join(root, "does-not-exist.txt"), 1000)
    expect(result).toBeUndefined()
  })
})
