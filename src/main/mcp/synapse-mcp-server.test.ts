import type { MemoryEntry } from "../ai/memory/memory-store"
import type { ToolHostPort } from "../ai/tool-registry"
import type { RegisteredToolDescriptor } from "../plugins/types"
import type { MemoryResourcePort } from "./synapse-mcp-server"
import type { WorkspaceInstructionsResourcePort } from "./workspace-instructions-resource"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { describe, expect, it, vi } from "vitest"
import { modelToolName } from "../ai/tool-registry"
import {
  McpUnboundError,
  McpWorkspaceArchivedError,
  McpWorkspaceNotFoundError,
} from "./mcp-workspace-admission"
import { createSynapseMcpServer, SynapseMcpToolService } from "./synapse-mcp-server"

function activeWorkspaces(id = "work") {
  return {
    get: async (queried: string) =>
      queried === id ? { id, name: "Work", createdAt: 0 } : undefined,
  }
}

function admittedFor(workspaceId = "work") {
  return {
    workspaceBinding: { kind: "bound" as const, workspaceId },
    workspaces: activeWorkspaces(workspaceId),
  }
}

function descriptor(
  fqName: string,
  annotations?: RegisteredToolDescriptor["manifestTool"]["annotations"],
  provenance: RegisteredToolDescriptor["provenance"] = "plugin"
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
    provenance,
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

const SAFE_GREET_NAME = modelToolName({ fqName: "com.example.safe/greet", provenance: "plugin" })
const SAFE_OK_NAME = modelToolName({ fqName: "com.example.safe/ok", provenance: "plugin" })
const SAFE_BAD_NAME = modelToolName({ fqName: "com.example.safe/bad", provenance: "plugin" })
const RISKY_DELETE_NAME = modelToolName({
  fqName: "com.example.risky/delete",
  provenance: "plugin",
})
const WRITE_NAME = modelToolName({ fqName: "com.example.a/write", provenance: "plugin" })

describe("synapseMcpToolService", () => {
  it("lists only read-only tools by default", async () => {
    const service = new SynapseMcpToolService(
      host([
        descriptor("com.example.safe/greet", { readOnlyHint: true }),
        descriptor("com.example.risky/delete", { destructiveHint: true }),
        descriptor("com.example.ask/mutate"),
      ]),
      admittedFor()
    )

    expect((await service.listTools()).tools.map((tool) => tool.name)).toEqual([SAFE_GREET_NAME])
    expect((await service.listTools()).tools[0]).toMatchObject({
      title: undefined,
      description: expect.stringContaining("[Third-party tool metadata"),
      annotations: { readOnlyHint: true },
    })
  })

  it("forwards title only for host-provenance tools", async () => {
    const service = new SynapseMcpToolService(
      host([descriptor("execution:host/run", { readOnlyHint: true }, "host")]),
      admittedFor()
    )
    const [tool] = (await service.listTools()).tools
    expect(tool?.title).toBe("Title execution:host/run")
  })

  it("frames a plugin-provenance description with the trust header", async () => {
    const service = new SynapseMcpToolService(
      host([descriptor("com.example.safe/greet", { readOnlyHint: true })]),
      admittedFor()
    )
    const [tool] = (await service.listTools()).tools
    expect(tool?.description).toContain("[Third-party tool metadata")
  })

  it("excludes a structural-overflow tool from tools/list", async () => {
    const bad = descriptor("com.example.safe/bad", { readOnlyHint: true })
    bad.manifestTool.inputSchema = {
      type: "object",
      properties: { x: { const: "a".repeat(10_000) } },
    }
    const service = new SynapseMcpToolService(
      host([descriptor("com.example.safe/ok", { readOnlyHint: true }), bad]),
      admittedFor()
    )
    const names = (await service.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual([SAFE_OK_NAME])
  })

  it("returns an error result from callTool() for a tool that would fail projection, without invoking", async () => {
    const bad = descriptor("com.example.safe/bad", { readOnlyHint: true })
    bad.manifestTool.inputSchema = {
      type: "object",
      properties: { x: { const: "a".repeat(10_000) } },
    }
    const h = host([bad])
    const service = new SynapseMcpToolService(h, admittedFor())
    const result = await service.callTool(SAFE_BAD_NAME, {})
    expect(result.isError).toBe(true)
    expect(h.invokeTool).not.toHaveBeenCalled()
  })

  it("routes a read-only tool call through the plugin host as an mcp caller", async () => {
    const h = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
    const service = new SynapseMcpToolService(h, admittedFor())

    const result = await service.callTool(SAFE_GREET_NAME, { name: "Ada" })

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
    const service = new SynapseMcpToolService(h, admittedFor())

    const result = await service.callTool(RISKY_DELETE_NAME, {})

    expect(h.invokeTool).not.toHaveBeenCalled()
    expect(result).toMatchObject({ isError: true })
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("does not expose") })
  })

  it("can opt in to exposing every enabled plugin tool", async () => {
    const h = host([descriptor("com.example.risky/delete", { destructiveHint: true })])
    const service = new SynapseMcpToolService(h, { exposurePolicy: "all", ...admittedFor() })

    expect((await service.listTools()).tools.map((tool) => tool.name)).toEqual([RISKY_DELETE_NAME])

    await service.callTool(RISKY_DELETE_NAME, {})
    expect(h.invokeTool).toHaveBeenCalledWith(
      "com.example.risky/delete",
      {},
      expect.objectContaining({ caller: expect.objectContaining({ kind: "mcp" }) })
    )
  })

  it("excludes a non-read-only tool when exposure/identityForPlugin are omitted", async () => {
    const h = host([descriptor("com.example.a/write", { destructiveHint: true })])
    const service = new SynapseMcpToolService(h, admittedFor())

    expect((await service.listTools()).tools).toEqual([])
  })

  it("includes a non-read-only tool when the plugin's identity resolves to an exposed record", async () => {
    const h = host([descriptor("com.example.a/write", { destructiveHint: true })])
    const identity = {
      pluginId: "com.example.a",
      publisherId: "unsigned",
      signingKeyFingerprint: "local:user",
      capabilityDeclarationHash: "h",
    }
    const service = new SynapseMcpToolService(h, {
      exposure: { isNonReadOnlyExposed: vi.fn(async () => true) },
      identityForPlugin: (pluginId) => (pluginId === "com.example.a" ? identity : undefined),
      ...admittedFor(),
    })

    expect((await service.listTools()).tools.map((tool) => tool.name)).toEqual([WRITE_NAME])
  })

  it("excludes a non-read-only tool when identityForPlugin resolves nothing (unknown plugin)", async () => {
    const h = host([descriptor("com.example.unknown/write", { destructiveHint: true })])
    const service = new SynapseMcpToolService(h, {
      exposure: { isNonReadOnlyExposed: vi.fn(async () => true) },
      identityForPlugin: () => undefined,
      ...admittedFor(),
    })

    expect((await service.listTools()).tools).toEqual([])
  })

  it("serves list and call requests through the MCP protocol", async () => {
    const h = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
    const server = createSynapseMcpServer(h, admittedFor())
    const client = new Client({ name: "test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([SAFE_GREET_NAME])

      const result = await client.callTool({
        name: SAFE_GREET_NAME,
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

  it("serves resources/list and resources/read through the MCP protocol", async () => {
    const server = createSynapseMcpServer(host([]), {
      ...admittedFor("ws-external"),
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", text: "hello from memory" })]),
    })
    const client = new Client({ name: "test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const list = await client.listResources()
      expect(list.resources).toEqual([
        expect.objectContaining({ uri: "synapse://memory/m1", name: "hello from memory" }),
      ])

      const read = await client.readResource({ uri: "synapse://memory/m1" })
      expect(read.contents).toEqual([
        { uri: "synapse://memory/m1", mimeType: "text/plain", text: "hello from memory" },
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("advertises the resources capability", async () => {
    const server = createSynapseMcpServer(host([]), admittedFor())
    const client = new Client({ name: "test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      expect(client.getServerCapabilities()).toMatchObject({
        tools: { listChanged: true },
        resources: { listChanged: true },
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("binds external MCP identity to the invoked tool caller", async () => {
    const h = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
    const service = new SynapseMcpToolService(h, {
      workspaceId: "ws-external",
      clientId: "claude-desktop",
      ...admittedFor("ws-external"),
    })

    await service.callTool(SAFE_GREET_NAME, { name: "Ada" })

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
      ...admittedFor("ws-external"),
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
      ...admittedFor("ws-external"),
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", scope: { visibility: "global" } })]),
    })
    expect((await service.listResources()).resources).toHaveLength(0)
  })

  it("includes global memories when memoryIncludeGlobal is explicitly true", async () => {
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor("ws-external"),
      workspaceId: "ws-external",
      memory: fakeMemory([memoryEntry({ id: "m1", scope: { visibility: "global" } })]),
      memoryIncludeGlobal: true,
    })
    expect((await service.listResources()).resources).toHaveLength(1)
  })

  it("reads a visible resource's text by uri", async () => {
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor("ws-external"),
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
      ...admittedFor("ws-external"),
      workspaceId: "ws-external",
      memory: fakeMemory([
        memoryEntry({ id: "m1", scope: { visibility: "workspace", workspaceId: "ws-other" } }),
      ]),
    })
    await expect(service.readResource("synapse://memory/m1")).rejects.toThrow()
  })

  it("throws for an unknown uri shape", async () => {
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor(),
      memory: fakeMemory([]),
    })
    await expect(service.readResource("not-a-synapse-uri")).rejects.toThrow()
  })

  it("returns an empty resource list when no memory port is configured", async () => {
    const service = new SynapseMcpToolService(host([]), admittedFor())
    expect(await service.listResources()).toEqual({ resources: [] })
  })

  it("treats a memory URI with an invalid %-encoding as unknown rather than throwing", async () => {
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor(),
      memory: fakeMemory([]),
    })
    await expect(service.readResource("synapse://memory/%zz")).rejects.toThrow(
      "Unknown Synapse resource: synapse://memory/%zz"
    )
  })
})

function fakeWorkspaceInstructions(
  descriptors: { uri: string; fileName: "AGENTS.md" | "CLAUDE.md" }[],
  content: Record<string, string> = {}
): WorkspaceInstructionsResourcePort {
  return {
    list: async () => descriptors,
    read: async (input) =>
      input.uri in content ? { uri: input.uri, text: content[input.uri]! } : undefined,
  }
}

describe("synapseMcpToolService workspace-instructions resources", () => {
  it("lists workspace-instructions entries alongside memory ones", async () => {
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor("w1"),
      workspaceId: "w1",
      memory: fakeMemory([
        memoryEntry({ id: "m1", scope: { visibility: "workspace", workspaceId: "w1" } }),
      ]),
      workspaceInstructions: fakeWorkspaceInstructions([
        { uri: "synapse://workspace-instructions/w1/AGENTS.md", fileName: "AGENTS.md" },
      ]),
    })

    const result = await service.listResources()

    expect(result.resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining([
        "synapse://memory/m1",
        "synapse://workspace-instructions/w1/AGENTS.md",
      ])
    )
  })

  it("still returns workspace-instructions entries when memory is not configured", async () => {
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor("w1"),
      workspaceId: "w1",
      workspaceInstructions: fakeWorkspaceInstructions([
        { uri: "synapse://workspace-instructions/w1/AGENTS.md", fileName: "AGENTS.md" },
      ]),
    })

    const result = await service.listResources()

    expect(result.resources).toEqual([
      {
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
        name: "AGENTS.md",
        mimeType: "text/plain",
      },
    ])
  })

  it("reads a workspace-instructions resource's text by uri", async () => {
    const uri = "synapse://workspace-instructions/w1/AGENTS.md"
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor("w1"),
      workspaceId: "w1",
      workspaceInstructions: fakeWorkspaceInstructions([{ uri, fileName: "AGENTS.md" }], {
        [uri]: "Run tests before committing.",
      }),
    })

    const result = await service.readResource(uri)

    expect(result).toEqual({
      contents: [{ uri, mimeType: "text/plain", text: "Run tests before committing." }],
    })
  })

  it("throws the same Unknown Synapse resource message for a denied workspace-instructions read as for a nonexistent memory one", async () => {
    const uri = "synapse://workspace-instructions/w1/AGENTS.md"
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor("w1"),
      workspaceId: "w1",
      workspaceInstructions: fakeWorkspaceInstructions([{ uri, fileName: "AGENTS.md" }]),
    })

    await expect(service.readResource(uri)).rejects.toThrow(`Unknown Synapse resource: ${uri}`)
  })

  it("passes signal through to workspaceInstructions.read", async () => {
    const uri = "synapse://workspace-instructions/w1/AGENTS.md"
    const readSpy = vi.fn(async () => ({ uri, text: "content" }))
    const service = new SynapseMcpToolService(host([]), {
      ...admittedFor("w1"),
      workspaceId: "w1",
      workspaceInstructions: { list: async () => [], read: readSpy },
    })
    const controller = new AbortController()

    await service.readResource(uri, { signal: controller.signal })

    expect(readSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", uri, signal: controller.signal })
    )
  })
})

describe("synapseMcpToolService — workspace admission", () => {
  it("listTools rejects an unbound service", async () => {
    const service = new SynapseMcpToolService(host([descriptor("com.example.safe/greet")]), {
      workspaceBinding: { kind: "unbound" },
      workspaces: activeWorkspaces(),
    })
    await expect(service.listTools()).rejects.toBeInstanceOf(McpUnboundError)
  })

  it("callTool rejects an unknown workspace", async () => {
    const service = new SynapseMcpToolService(host([descriptor("com.example.safe/greet")]), {
      workspaceBinding: { kind: "bound", workspaceId: "ghost" },
      workspaces: { get: async () => undefined },
    })
    await expect(service.callTool(SAFE_GREET_NAME, {})).rejects.toBeInstanceOf(
      McpWorkspaceNotFoundError
    )
  })

  it("listResources rejects an archived workspace", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceBinding: { kind: "bound", workspaceId: "work" },
      workspaces: {
        get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }),
      },
    })
    await expect(service.listResources()).rejects.toBeInstanceOf(McpWorkspaceArchivedError)
  })

  it("readResource rejects an archived workspace", async () => {
    const service = new SynapseMcpToolService(host([]), {
      workspaceBinding: { kind: "bound", workspaceId: "work" },
      workspaces: {
        get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }),
      },
    })
    await expect(service.readResource("synapse://memory/x")).rejects.toBeInstanceOf(
      McpWorkspaceArchivedError
    )
  })

  it("an active workspace behaves exactly as before admission was added", async () => {
    const service = new SynapseMcpToolService(
      host([descriptor("com.example.safe/greet", { readOnlyHint: true })]),
      { workspaceBinding: { kind: "bound", workspaceId: "work" }, workspaces: activeWorkspaces() }
    )
    expect((await service.listTools()).tools.map((tool) => tool.name)).toEqual([SAFE_GREET_NAME])
  })

  it("cached-tool-list regression: callTool re-checks admission even after a successful listTools()", async () => {
    let archived = false
    const workspaces = {
      get: async (id: string) => ({
        id,
        name: "Work",
        createdAt: 0,
        archived: archived || undefined,
      }),
    }
    const toolHost = host([descriptor("com.example.safe/greet", { readOnlyHint: true })])
    const service = new SynapseMcpToolService(toolHost, {
      workspaceBinding: { kind: "bound", workspaceId: "work" },
      workspaces,
    })

    await expect(service.listTools()).resolves.toBeDefined()
    archived = true
    await expect(service.callTool(SAFE_GREET_NAME, {})).rejects.toBeInstanceOf(
      McpWorkspaceArchivedError
    )
  })

  it("the unbound migration message is written via onUnboundWarning at most once across multiple rejected calls", async () => {
    const onUnboundWarning = vi.fn()
    const service = new SynapseMcpToolService(host([descriptor("com.example.safe/greet")]), {
      workspaceBinding: { kind: "unbound" },
      workspaces: activeWorkspaces(),
      onUnboundWarning,
    })

    await expect(service.listTools()).rejects.toBeInstanceOf(McpUnboundError)
    await expect(service.listResources()).rejects.toBeInstanceOf(McpUnboundError)

    expect(onUnboundWarning).toHaveBeenCalledTimes(1)
  })
})
