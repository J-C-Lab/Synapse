import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServerConfigError, McpServerConfigStore } from "./mcp-server-config-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-mcp-cfg-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function store(): McpServerConfigStore {
  return new McpServerConfigStore(path.join(dir, "mcp-servers.json"))
}

describe("mcpServerConfigStore", () => {
  it("saves, normalizes, reads back, and updates by id", async () => {
    const s = store()
    await s.save({ id: "fs", name: "  Files  ", command: "  npx ", args: ["mcp-fs"] })
    let list = await s.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: "fs", name: "Files", command: "npx", enabled: true })

    // Re-saving the same id replaces rather than duplicates.
    await s.save({ id: "fs", command: "node", enabled: false })
    list = await s.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ command: "node", enabled: false })
  })

  it("rejects invalid ids and empty commands", async () => {
    const s = store()
    await expect(s.save({ id: "bad id", command: "x" })).rejects.toBeInstanceOf(
      McpServerConfigError
    )
    await expect(s.save({ id: "ok", command: "   " })).rejects.toBeInstanceOf(McpServerConfigError)
  })

  it("deletes by id and is a no-op for unknown ids", async () => {
    const s = store()
    await s.save({ id: "a", command: "x" })
    await s.delete("missing")
    expect(await s.list()).toHaveLength(1)
    await s.delete("a")
    expect(await s.list()).toHaveLength(0)
  })

  it("drops malformed entries and duplicates when loading", async () => {
    const file = path.join(dir, "mcp-servers.json")
    await fs.writeFile(
      file,
      JSON.stringify([
        { id: "good", command: "x" },
        { id: "good", command: "y" }, // duplicate id
        { id: "no-cmd" }, // invalid
        "garbage",
      ]),
      "utf-8"
    )
    const list = await new McpServerConfigStore(file).list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: "good", command: "x" })
  })
})
