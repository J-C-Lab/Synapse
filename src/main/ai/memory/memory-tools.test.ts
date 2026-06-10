import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decideApproval } from "../approval-gate"
import { MemoryService } from "./memory-service"
import { MemoryStore } from "./memory-store"
import { MemoryToolSource } from "./memory-tools"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-memtools-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function source(): MemoryToolSource {
  const service = new MemoryService(new MemoryStore(path.join(dir, "memory.json")), {
    embed: async () => null,
  })
  return new MemoryToolSource(service)
}

describe("memoryToolSource", () => {
  it("owns the memory: namespace and lists five tools", () => {
    const src = source()
    expect(src.ownsTool("memory:core/memory_save")).toBe(true)
    expect(src.ownsTool("com.x/a")).toBe(false)
    expect(src.listTools().map((tool) => tool.manifestTool.name)).toEqual([
      "memory_save",
      "memory_ingest",
      "memory_search",
      "memory_list",
      "memory_delete",
    ])
  })

  it("ingests a document into searchable chunks through the tool", async () => {
    const src = source()
    const result = await src.invokeTool("memory:core/memory_ingest", {
      source: "notes.md",
      text: "the deploy script lives in scripts/deploy.sh and runs nightly",
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.structured)).toContain("notes.md")

    const found = await src.invokeTool("memory:core/memory_search", { query: "deploy script" })
    expect(JSON.stringify(found.structured)).toContain("deploy")
  })

  it("reports a missing document source/text as an error", async () => {
    const src = source()
    expect((await src.invokeTool("memory:core/memory_ingest", { text: "x" })).isError).toBe(true)
    expect((await src.invokeTool("memory:core/memory_ingest", { source: "s" })).isError).toBe(true)
  })

  it("saves then recalls a memory through the tools", async () => {
    const src = source()
    await src.invokeTool("memory:core/memory_save", { text: "the api base is example.com" })
    const result = await src.invokeTool("memory:core/memory_search", { query: "api base" })
    const block = result.content[0]
    expect(block?.type).toBe("json")
    expect(JSON.stringify(result.structured)).toContain("example.com")
  })

  it("reports input errors as isError results", async () => {
    const src = source()
    const result = await src.invokeTool("memory:core/memory_save", {})
    expect(result.isError).toBe(true)
  })

  it("annotates search/list read-only (auto-allow) and save/delete to ask", () => {
    const byName = Object.fromEntries(
      source()
        .listTools()
        .map((tool) => [tool.manifestTool.name, tool.manifestTool.annotations])
    )
    expect(decideApproval(byName.memory_search)).toBe("allow")
    expect(decideApproval(byName.memory_list)).toBe("allow")
    expect(decideApproval(byName.memory_save)).toBe("ask")
    expect(decideApproval(byName.memory_ingest)).toBe("ask")
    expect(decideApproval(byName.memory_delete)).toBe("ask")
  })
})
