import type { MemoryEntry } from "../ai/memory/memory-store"
import type { RunTrace } from "../ai/run-trace-store"
import type { ToolHostPort } from "../ai/tool-registry"
import type { RegisteredToolDescriptor } from "../plugins/types"
import type { MemoryResourcePort } from "./synapse-mcp-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { describe, expect, it, vi } from "vitest"
import { createSynapseMcpServer, SynapseMcpToolService } from "./synapse-mcp-server"

function descriptor(
  fqName: string,
  annotations?: RegisteredToolDescriptor["manifestTool"]["annotations"]
): RegisteredToolDescriptor {
  return {
    fqName,
    pluginId: fqName.split("/")[0] ?? fqName,
    manifestTool: {
      name: fqName.split("/")[1] ?? fqName,
      title: { en: `Title ${fqName}` },
      description: `Tool ${fqName}`,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      outputSchema: {
        type: "object",
        properties: { fqName: { type: "string" } },
        required: ["fqName"],
      },
      annotations,
    },
  }
}

function host(descriptors: RegisteredToolDescriptor[]): ToolHostPort {
  return {
    listTools: () => descriptors,
    invokeTool: vi.fn(async (fqName: string, input: unknown) => ({
      content: [
        { type: "text" as const, text: `ran ${fqName}` },
        { type: "json" as const, json: { input } },
      ],
      structured: { fqName },
    })),
  }
}

describe("synapseMcpToolService", () => {
  it("lists only read-only tools by default", () => {
    const service = new SynapseMcpToolService(
      host([
        descriptor("com.example.safe/greet", { readOnlyHint: true }),
        descriptor("com.example.risky/delete", { destructiveHint: true }),
        descriptor("com.example.ask/mutate"),
      ])
    )

    expect(service.listTools().tools.map((tool) => tool.name)).toEqual(["com_example_safe_greet"])
    expect(service.listTools().tools[0]).toMatchObject({
      title: "Title com.example.safe/greet",
      description: "Tool com.example.safe/greet",
      annotations: { readOnlyHint: true },
    })
  })

  it("routes a read-only tool call through the plugin host as an mcp caller", async () => {
    const h = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
    const service = new SynapseMcpToolService(h)

    const result = await service.callTool("com_example_safe_greet", { name: "Ada" })

    expect(h.invokeTool).toHaveBeenCalledWith(
      "com.example.safe/greet",
      { name: "Ada" },
      expect.objectContaining({ caller: expect.objectContaining({ kind: "mcp" }) })
    )
    expect(result).toMatchObject({
      content: [
        { type: "text", text: "ran com.example.safe/greet" },
        { type: "text", text: '{"input":{"name":"Ada"}}' },
      ],
      structuredContent: { fqName: "com.example.safe/greet" },
    })
  })

  it("denies direct calls to tools hidden by the default policy", async () => {
    const h = host([descriptor("com.example.risky/delete", { destructiveHint: true })])
    const service = new SynapseMcpToolService(h)

    const result = await service.callTool("com_example_risky_delete", {})

    expect(h.invokeTool).not.toHaveBeenCalled()
    expect(result).toMatchObject({ isError: true })
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("does not expose") })
  })

  it("can opt in to exposing every enabled plugin tool", async () => {
    const h = host([descriptor("com.example.risky/delete", { destructiveHint: true })])
    const service = new SynapseMcpToolService(h, { exposurePolicy: "all" })

    expect(service.listTools().tools.map((tool) => tool.name)).toEqual(["com_example_risky_delete"])

    await service.callTool("com_example_risky_delete", {})
    expect(h.invokeTool).toHaveBeenCalledWith(
      "com.example.risky/delete",
      {},
      expect.objectContaining({ caller: expect.objectContaining({ kind: "mcp" }) })
    )
  })

  it("serves list and call requests through the MCP protocol", async () => {
    const h = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
    const server = createSynapseMcpServer(h)
    const client = new Client({ name: "test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "com_example_safe_greet",
      ])

      const result = await client.callTool({
        name: "com_example_safe_greet",
        arguments: { name: "Ada" },
      })

      expect(result).toMatchObject({
        content: expect.arrayContaining([{ type: "text", text: "ran com.example.safe/greet" }]),
      })
      expect(h.invokeTool).toHaveBeenCalledWith(
        "com.example.safe/greet",
        { name: "Ada" },
        expect.objectContaining({ caller: expect.objectContaining({ kind: "mcp" }) })
      )
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("opens a run and records an mcp trace with an external-mcp principal", async () => {
    const traces: RunTrace[] = []
    const h = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
    const service = new SynapseMcpToolService(h, {
      recordRun: (trace) => traces.push(trace),
      workspaceId: "ws-external",
      clientId: "claude-desktop",
    })

    await service.callTool("com_example_safe_greet", { name: "Ada" })

    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({
      origin: "mcp",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-external",
      outcome: "end_turn",
    })
    expect(traces[0].toolCalls[0]).toMatchObject({ name: "com.example.safe/greet", ok: true })
    expect(h.invokeTool).toHaveBeenCalledWith(
      "com.example.safe/greet",
      { name: "Ada" },
      expect.objectContaining({
        caller: expect.objectContaining({
          kind: "mcp",
          principal: { kind: "external-mcp", clientId: "claude-desktop" },
          workspaceId: "ws-external",
        }),
      })
    )
  })
})

function fakeMemory(entries: MemoryEntry[]): MemoryResourcePort {
  return {
    list: async (limit, scope) =>
      entries
        .filter((e) =>
          scope.includeGlobal
            ? e.scope.visibility === "global" || e.scope.workspaceId === scope.workspaceId
            : e.scope.workspaceId === scope.workspaceId
        )
        .slice(0, limit),
    get: async (id, scope) => {
      const entry = entries.find((e) => e.id === id)
      if (!entry) return undefined
      const visible = scope.includeGlobal
        ? entry.scope.visibility === "global" || entry.scope.workspaceId === scope.workspaceId
        : entry.scope.workspaceId === scope.workspaceId
      return visible ? entry : undefined
    },
  }
}

function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "m1",
    text: "a saved fact",
    tags: [],
    createdAt: 1,
    scope: { visibility: "workspace", workspaceId: "ws-external" },
    ...overrides,
  }
}

describe("synapseMcpToolService resources", () => {
  it("lists memory entries visible to the bound workspace as resources", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([
        memoryEntry({ id: "m1", text: "in scope" }),
        memoryEntry({
          id: "m2",
          text: "other workspace",
          scope: { visibility: "workspace", workspaceId: "ws-other" },
        }),
      ]),
    })

    const result = await service.listResources()
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0]).toMatchObject({
      uri: "synapse://memory/m1",
      name: "in scope",
      mimeType: "text/plain",
    })
  })

  it("excludes global memories by default (includeGlobal defaults false)", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", scope: { visibility: "global" } })]),
    })
    expect((await service.listResources()).resources).toHaveLength(0)
  })

  it("includes global memories when memoryIncludeGlobal is explicitly true", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", scope: { visibility: "global" } })]),
      memoryIncludeGlobal: true,
    })
    expect((await service.listResources()).resources).toHaveLength(1)
  })

  it("reads a visible resource's text by uri", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", text: "the actual text" })]),
    })

    const result = await service.readResource("synapse://memory/m1")
    expect(result).toEqual({
      contents: [{ uri: "synapse://memory/m1", mimeType: "text/plain", text: "the actual text" }],
    })
  })

  it("throws for a resource outside the bound scope, even with a guessed valid id", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceId: "ws-external",
      memory: fakeMemory([
        memoryEntry({ id: "m1", scope: { visibility: "workspace", workspaceId: "ws-other" } }),
      ]),
    })
    await expect(service.readResource("synapse://memory/m1")).rejects.toThrow()
  })

  it("throws for an unknown uri shape", async () => {
    const service = new SynapseMcpToolService(host([]), { memory: fakeMemory([]) })
    await expect(service.readResource("not-a-synapse-uri")).rejects.toThrow()
  })

  it("records an mcp RunTrace for both listResources and readResource", async () => {
    const traces: RunTrace[] = []
    const service = new SynapseMcpToolService(host([]), {
      recordRun: (trace) => traces.push(trace),
      workspaceId: "ws-external",
      clientId: "claude-desktop",
      memory: fakeMemory([memoryEntry({ id: "m1" })]),
    })

    await service.listResources()
    await service.readResource("synapse://memory/m1")

    expect(traces).toHaveLength(2)
    for (const t of traces) {
      expect(t).toMatchObject({
        origin: "mcp",
        principal: { kind: "external-mcp", clientId: "claude-desktop" },
        workspaceId: "ws-external",
        outcome: "end_turn",
      })
    }
  })

  it("returns an empty resource list when no memory port is configured", async () => {
    const service = new SynapseMcpToolService(host([]))
    expect(await service.listResources()).toEqual({ resources: [] })
  })
})
