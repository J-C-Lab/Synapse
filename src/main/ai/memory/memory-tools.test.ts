import type { ToolInvocationOptions } from "../../plugins/types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decideApproval } from "../approval-gate"
import { BACKGROUND_AGENT_MEMORY_TAG, MemoryService } from "./memory-service"
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

function caller(overrides: Partial<ToolInvocationOptions["caller"]> = {}): ToolInvocationOptions {
  return {
    caller: {
      kind: "agent",
      conversationId: "c1",
      ...overrides,
    },
  }
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
    const result = await src.invokeTool(
      "memory:core/memory_ingest",
      {
        source: "notes.md",
        text: "the deploy script lives in scripts/deploy.sh and runs nightly",
      },
      caller()
    )
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.structured)).toContain("notes.md")

    const found = await src.invokeTool(
      "memory:core/memory_search",
      { query: "deploy script" },
      caller()
    )
    expect(JSON.stringify(found.structured)).toContain("deploy")
  })

  it("reports a missing document source/text as an error", async () => {
    const src = source()
    expect(
      (await src.invokeTool("memory:core/memory_ingest", { text: "x" }, caller())).isError
    ).toBe(true)
    expect(
      (await src.invokeTool("memory:core/memory_ingest", { source: "s" }, caller())).isError
    ).toBe(true)
  })

  it("saves then recalls a memory through the tools", async () => {
    const src = source()
    await src.invokeTool(
      "memory:core/memory_save",
      { text: "the api base is example.com" },
      caller()
    )
    const result = await src.invokeTool(
      "memory:core/memory_search",
      { query: "api base" },
      caller()
    )
    const block = result.content[0]
    expect(block?.type).toBe("json")
    expect(JSON.stringify(result.structured)).toContain("example.com")
  })

  it("scopes saves and searches to the caller workspaceId", async () => {
    const src = source()
    await src.invokeTool(
      "memory:core/memory_save",
      { text: "repo-a deploy script" },
      caller({ workspaceId: "repo-a" })
    )
    await src.invokeTool(
      "memory:core/memory_save",
      { text: "repo-b deploy script" },
      caller({ workspaceId: "repo-b" })
    )

    const hits = await src.invokeTool(
      "memory:core/memory_search",
      { query: "deploy script" },
      caller({ workspaceId: "repo-a" })
    )
    expect(JSON.stringify(hits.structured)).toContain("repo-a deploy script")
    expect(JSON.stringify(hits.structured)).not.toContain("repo-b deploy script")
  })

  it("reports input errors as isError results", async () => {
    const src = source()
    const result = await src.invokeTool("memory:core/memory_save", {}, caller())
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

  it("tags memories saved by background agents for recall exclusion", async () => {
    const src = source()
    await src.invokeTool(
      "memory:core/memory_save",
      { text: "background fact" },
      { caller: { kind: "background-agent", invocationId: "inv-1" } }
    )
    const listed = await src.invokeTool("memory:core/memory_list", {}, caller())
    expect(JSON.stringify(listed.structured)).toContain(BACKGROUND_AGENT_MEMORY_TAG)
  })
})
