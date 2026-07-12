import type { ToolInvocationOptions } from "../../plugins/types"
import type { ExecutionLogStore } from "./execution-log-store"
import { describe, expect, it, vi } from "vitest"
import { ExecutionReadOnlyToolSource } from "./execution-read-tools"
import { ExecutionToolHostSource } from "./execution-tool-host"

function fakeLog(): ExecutionLogStore {
  return { append: vi.fn(async () => {}) } as unknown as ExecutionLogStore
}

const callerOptions = {
  caller: { kind: "background-agent", workspaceId: "ws-1" },
  signal: new AbortController().signal,
} as unknown as ToolInvocationOptions

describe("executionReadOnlyToolSource", () => {
  it("lists exactly list_files/read_file/search_files, each tagged execution:read, when allowed and roots exist", async () => {
    const inner = new ExecutionToolHostSource({
      workspaceRoots: {
        listAll: async () => [
          { id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: "/tmp" } as never,
        ],
        listForWorkspace: async () => [],
      },
      log: fakeLog(),
      isAllowed: () => true,
    })
    await inner.refresh()
    const source = new ExecutionReadOnlyToolSource(inner)

    const names = source.listTools().map((d) => d.manifestTool.name)
    expect(names.sort()).toEqual(["list_files", "read_file", "search_files"])
    for (const descriptor of source.listTools()) {
      expect(descriptor.manifestTool.capabilities).toEqual([{ id: "execution:read" }])
    }
  })

  it("never lists apply_patch/run_command", async () => {
    const inner = new ExecutionToolHostSource({
      workspaceRoots: {
        listAll: async () => [
          { id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: "/tmp" } as never,
        ],
        listForWorkspace: async () => [],
      },
      log: fakeLog(),
      isAllowed: () => true,
    })
    await inner.refresh()
    const source = new ExecutionReadOnlyToolSource(inner)
    const names = source.listTools().map((d) => d.manifestTool.name)
    expect(names).not.toContain("apply_patch")
    expect(names).not.toContain("run_command")
  })

  it("ownsTool is true only for the three read tool fqNames", () => {
    const inner = new ExecutionToolHostSource({
      workspaceRoots: { listAll: async () => [], listForWorkspace: async () => [] },
      log: fakeLog(),
      isAllowed: () => true,
    })
    const source = new ExecutionReadOnlyToolSource(inner)
    expect(source.ownsTool("execution:core/list_files")).toBe(true)
    expect(source.ownsTool("execution:core/read_file")).toBe(true)
    expect(source.ownsTool("execution:core/search_files")).toBe(true)
    expect(source.ownsTool("execution:core/apply_patch")).toBe(false)
    expect(source.ownsTool("execution:core/run_command")).toBe(false)
    expect(source.ownsTool("memory:core/memory_search")).toBe(false)
  })

  it("returns empty listTools when the wrapped isAllowed() is false — the Agent Shell master-switch regression", async () => {
    const inner = new ExecutionToolHostSource({
      workspaceRoots: {
        listAll: async () => [
          { id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: "/tmp" } as never,
        ],
        listForWorkspace: async () => [],
      },
      log: fakeLog(),
      isAllowed: () => false,
    })
    await inner.refresh()
    const source = new ExecutionReadOnlyToolSource(inner)
    expect(source.listTools()).toEqual([])
  })

  it("a successful read_file call writes an ExecutionLogStore entry — the audit-trail-preservation regression", async () => {
    const log = { append: vi.fn(async () => {}) } as unknown as ExecutionLogStore
    const inner = new ExecutionToolHostSource({
      workspaceRoots: {
        listAll: async () => [
          { id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: process.cwd() } as never,
        ],
        listForWorkspace: async () => [
          { id: "r1", workspaceId: "ws-1", role: "primary", absolutePath: process.cwd() } as never,
        ],
      },
      log,
      isAllowed: () => true,
    })
    await inner.refresh()
    const source = new ExecutionReadOnlyToolSource(inner)

    await source.invokeTool("execution:core/list_files", { rootId: "r1", path: "." }, callerOptions)

    expect(log.append).toHaveBeenCalledTimes(1)
  })
})
