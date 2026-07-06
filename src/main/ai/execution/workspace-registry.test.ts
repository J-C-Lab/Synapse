import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ExecutionWorkspaceRegistry, executionWorkspacesFilePath } from "./workspace-registry"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function createRegistry(): Promise<{
  registry: ExecutionWorkspaceRegistry
  filePath: string
}> {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ws-reg-"))
  tempDirs.push(userData)
  const filePath = executionWorkspacesFilePath(userData)
  const registry = new ExecutionWorkspaceRegistry(filePath)
  await registry.load()
  return { registry, filePath }
}

describe("executionWorkspaceRegistry", () => {
  it("adds, lists, and removes authorized workspaces", async () => {
    const { registry } = await createRegistry()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ws-root-"))
    tempDirs.push(root)
    await expect(registry.add("repo", root)).resolves.toEqual({
      id: "repo",
      root: await fs.realpath(root),
    })
    expect(registry.list()).toHaveLength(1)
    await expect(registry.remove("repo")).resolves.toBe(true)
    expect(registry.list()).toEqual([])
  })

  it("persists workspaces across reload", async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ws-persist-"))
    tempDirs.push(userData)
    const filePath = executionWorkspacesFilePath(userData)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ws-root-"))
    tempDirs.push(root)

    const first = new ExecutionWorkspaceRegistry(filePath)
    await first.load()
    await first.add("repo", root)

    const second = new ExecutionWorkspaceRegistry(filePath)
    await second.load()
    expect(second.list()).toEqual([{ id: "repo", root: await fs.realpath(root) }])
  })

  it("drops missing directories when loading persisted data", async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ws-prune-"))
    tempDirs.push(userData)
    const filePath = executionWorkspacesFilePath(userData)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-ws-root-"))
    tempDirs.push(root)
    const missing = path.join(userData, "gone")

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(
      filePath,
      `${JSON.stringify(
        [
          { id: "repo", root },
          { id: "ghost", root: missing },
        ],
        null,
        2
      )}\n`,
      "utf-8"
    )

    const registry = new ExecutionWorkspaceRegistry(filePath)
    await registry.load()
    expect(registry.list()).toEqual([{ id: "repo", root: await fs.realpath(root) }])

    const stored = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown[]
    expect(stored).toHaveLength(1)
  })
})
