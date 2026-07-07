import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { asFallbackSource, CompositeToolHost } from "../ai/composite-tool-host"
import { MEMORY_FQ_PREFIX, MemoryToolSource } from "../ai/memory/memory-tools"
import { createHeadlessMemoryService } from "./headless-memory"
import { SynapseMcpToolService } from "./synapse-mcp-server"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-mcp-resources-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function emptyHost() {
  return { listTools: () => [], invokeTool: async () => ({ content: [] }) }
}

describe("mcp resources over real memory", () => {
  it("only exposes memory_search/memory_list as tools under the default policy", async () => {
    const memory = createHeadlessMemoryService(dir)
    const host = new CompositeToolHost([
      asFallbackSource(emptyHost(), (fqName) => fqName.startsWith(MEMORY_FQ_PREFIX)),
      new MemoryToolSource(memory),
    ])
    const service = new SynapseMcpToolService(host, { workspaceId: "ws-external" })

    const names = service.listTools().tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(["memory_core_memory_search", "memory_core_memory_list"])
    )
    expect(names).not.toEqual(
      expect.arrayContaining([
        "memory_core_memory_save",
        "memory_core_memory_ingest",
        "memory_core_memory_delete",
      ])
    )
  })

  it("lists and reads only entries scoped to the bound external workspace", async () => {
    const memory = createHeadlessMemoryService(dir)
    await memory.save({
      text: "external fact",
      scope: { visibility: "workspace", workspaceId: "ws-external" },
    })
    await memory.save({
      text: "other workspace fact",
      scope: { visibility: "workspace", workspaceId: "ws-other" },
    })
    await memory.save({ text: "global fact", scope: { visibility: "global" } })

    const service = new SynapseMcpToolService(emptyHost(), {
      workspaceId: "ws-external",
      memory: { list: (l, s) => memory.list(l, s), get: (id, s) => memory.get(id, s) },
    })

    const list = await service.listResources()
    expect(list.resources.map((r) => r.name)).toEqual(["external fact"])

    const [entry] = list.resources
    const read = await service.readResource(entry.uri)
    expect(read.contents[0]).toMatchObject({ text: "external fact" })
  })

  it("a memory saved via the tool path is visible via the resource path", async () => {
    const memory = createHeadlessMemoryService(dir)
    const host = new CompositeToolHost([
      asFallbackSource(emptyHost(), (fqName) => fqName.startsWith(MEMORY_FQ_PREFIX)),
      new MemoryToolSource(memory),
    ])
    const service = new SynapseMcpToolService(host, {
      workspaceId: "ws-external",
      exposurePolicy: "all",
      memory: { list: (l, s) => memory.list(l, s), get: (id, s) => memory.get(id, s) },
    })

    await service.callTool("memory_core_memory_save", {
      text: "saved through the tool path",
    })

    const list = await service.listResources()
    expect(list.resources.map((r) => r.name)).toEqual(
      expect.arrayContaining(["saved through the tool path"])
    )
  })
})
