import type { McpCallResult, McpClientPort, McpToolDefinition } from "./mcp-client-manager"
import type { McpServerConfig } from "./mcp-server-config-store"
import { describe, expect, it, vi } from "vitest"
import { McpClientManager } from "./mcp-client-manager"

interface FakeOptions {
  tools?: McpToolDefinition[]
  connectError?: Error
  callResult?: McpCallResult
}

function fakeClient(options: FakeOptions = {}): McpClientPort & {
  connect: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  notifyRootsChanged?: ReturnType<typeof vi.fn>
} {
  return {
    connect: vi.fn(async () => {
      if (options.connectError) throw options.connectError
    }),
    listTools: vi.fn(async () => ({ tools: options.tools ?? [] })),
    callTool: vi.fn(async () => options.callResult ?? { content: [{ type: "text", text: "ok" }] }),
    close: vi.fn(async () => {}),
  }
}

const readTool: McpToolDefinition = {
  name: "search",
  description: "Search the web",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true, title: "Search" },
}

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id: "srv", command: "node", ...overrides }
}

describe("mcpClientManager", () => {
  it("connects enabled servers and namespaces tools as mcp:<id>/<tool>", async () => {
    const client = fakeClient({ tools: [readTool] })
    const manager = new McpClientManager(() => client)
    await manager.start([config()])

    const tools = manager.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      fqName: "mcp:srv/search",
      pluginId: "mcp:srv",
      manifestTool: { name: "search", title: "Search", annotations: { readOnlyHint: true } },
    })
    expect(manager.status()[0]).toMatchObject({ state: "connected", toolCount: 1 })
  })

  it("owns only the mcp: namespace", () => {
    const manager = new McpClientManager(() => fakeClient())
    expect(manager.ownsTool("mcp:srv/search")).toBe(true)
    expect(manager.ownsTool("com.x/a")).toBe(false)
  })

  it("routes invocations to the right server and maps the result", async () => {
    const client = fakeClient({
      tools: [readTool],
      callResult: { content: [{ type: "text", text: "found it" }], structuredContent: { n: 1 } },
    })
    const manager = new McpClientManager(() => client)
    await manager.start([config()])

    const result = await manager.invokeTool(
      "mcp:srv/search",
      { q: "hi" },
      { caller: { kind: "agent" } }
    )
    expect(client.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { q: "hi" } },
      expect.anything()
    )
    expect(result.content[0]).toMatchObject({ type: "text", text: "found it" })
    expect(result.structured).toEqual({ n: 1 })
  })

  it("maps non-text content blocks to text placeholders", async () => {
    const client = fakeClient({
      tools: [readTool],
      callResult: {
        content: [
          { type: "image", mimeType: "image/png", data: "..." },
          { type: "resource", resource: { text: "file body" } },
          { type: "weird", foo: 1 },
        ],
        isError: true,
      },
    })
    const manager = new McpClientManager(() => client)
    await manager.start([config()])
    const result = await manager.invokeTool("mcp:srv/search", {}, { caller: { kind: "agent" } })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: "text", text: "[image: image/png]" })
    expect(result.content[1]).toMatchObject({ type: "text", text: "file body" })
    expect(result.content[2]?.type).toBe("text")
  })

  it("keeps a disabled server disconnected and exposes no tools", async () => {
    const client = fakeClient({ tools: [readTool] })
    const manager = new McpClientManager(() => client)
    await manager.start([config({ enabled: false })])

    expect(client.connect).not.toHaveBeenCalled()
    expect(manager.listTools()).toHaveLength(0)
    expect(manager.status()[0]).toMatchObject({ state: "disconnected", enabled: false })
  })

  it("records a connection error without throwing", async () => {
    const manager = new McpClientManager(() =>
      fakeClient({ connectError: new Error("spawn fail") })
    )
    await manager.start([config()])

    expect(manager.listTools()).toHaveLength(0)
    expect(manager.status()[0]).toMatchObject({ state: "error", error: "spawn fail" })
  })

  it("refuses to invoke a tool on a server that is not connected", async () => {
    const manager = new McpClientManager(() => fakeClient({ connectError: new Error("nope") }))
    await manager.start([config()])
    await expect(
      manager.invokeTool("mcp:srv/search", {}, { caller: { kind: "agent" } })
    ).rejects.toThrow(/not connected/)
  })

  it("closes clients on stop and dispose", async () => {
    const client = fakeClient({ tools: [readTool] })
    const manager = new McpClientManager(() => client)
    await manager.start([config()])

    await manager.stop("srv")
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(manager.listTools()).toHaveLength(0)
  })

  it("passes getExecutionWorkspaces through to the client factory", async () => {
    const roots = [{ id: "proj", root: "/home/proj" }]
    let received: (() => typeof roots) | undefined
    const manager = new McpClientManager(
      (_config, getExecutionWorkspaces) => {
        received = getExecutionWorkspaces
        return fakeClient()
      },
      () => roots
    )
    await manager.start([config()])
    expect(received?.()).toEqual(roots)
  })

  it("notifyAllRootsChanged only notifies connected connections with a roots handler", async () => {
    const notifying = fakeClient()
    ;(notifying as McpClientPort).notifyRootsChanged = vi.fn(async () => {})
    const noRootsHandler = fakeClient()
    const manager = new McpClientManager((cfg) =>
      cfg.id === "with-roots" ? notifying : noRootsHandler
    )
    await manager.start([config({ id: "with-roots" }), config({ id: "no-roots" })])

    await manager.notifyAllRootsChanged()

    expect(notifying.notifyRootsChanged).toHaveBeenCalledOnce()
  })
})
