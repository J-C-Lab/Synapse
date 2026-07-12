import type { ToolInvocationOptions } from "../../plugins/types"
import { describe, expect, it, vi } from "vitest"
import { MemoryReadOnlyToolSource } from "./memory-read-tools"
import { MemoryToolSource } from "./memory-tools"

function fakeMemoryService() {
  return {
    save: vi.fn(),
    ingestDocument: vi.fn(),
    search: vi.fn(async () => []),
    list: vi.fn(async () => []),
    delete: vi.fn(),
  }
}

const callerOptions = {
  caller: { kind: "background-agent", workspaceId: "ws-1" },
} as unknown as ToolInvocationOptions

describe("memoryReadOnlyToolSource", () => {
  it("lists exactly memory_search and memory_list, each tagged memory:read", () => {
    const inner = new MemoryToolSource(fakeMemoryService() as never)
    const source = new MemoryReadOnlyToolSource(inner)
    const names = source.listTools().map((d) => d.manifestTool.name)
    expect(names.sort()).toEqual(["memory_list", "memory_search"])
    for (const descriptor of source.listTools()) {
      expect(descriptor.manifestTool.capabilities).toEqual([{ id: "memory:read" }])
    }
  })

  it("never lists memory_save/memory_ingest/memory_delete", () => {
    const inner = new MemoryToolSource(fakeMemoryService() as never)
    const source = new MemoryReadOnlyToolSource(inner)
    const names = source.listTools().map((d) => d.manifestTool.name)
    expect(names).not.toContain("memory_save")
    expect(names).not.toContain("memory_ingest")
    expect(names).not.toContain("memory_delete")
  })

  it("ownsTool is true only for the two read tool fqNames", () => {
    const inner = new MemoryToolSource(fakeMemoryService() as never)
    const source = new MemoryReadOnlyToolSource(inner)
    expect(source.ownsTool("memory:core/memory_search")).toBe(true)
    expect(source.ownsTool("memory:core/memory_list")).toBe(true)
    expect(source.ownsTool("memory:core/memory_save")).toBe(false)
    expect(source.ownsTool("memory:core/memory_delete")).toBe(false)
    expect(source.ownsTool("execution:core/read_file")).toBe(false)
  })

  it("invokeTool delegates to the wrapped MemoryToolSource unchanged", async () => {
    const memory = fakeMemoryService()
    memory.search.mockResolvedValue([
      { entry: { id: "m1", text: "hello", tags: [], scope: { visibility: "global" } }, score: 0.9 },
    ] as never)
    const inner = new MemoryToolSource(memory as never)
    const source = new MemoryReadOnlyToolSource(inner)

    const result = await source.invokeTool(
      "memory:core/memory_search",
      { query: "hello" },
      callerOptions
    )

    expect(memory.search).toHaveBeenCalledWith("hello", 5, expect.anything())
    expect(result.isError).toBeUndefined()
  })
})
