import type { ToolHostPort } from "../ai/tool-registry"
import type { RegisteredToolDescriptor } from "../plugins/types"
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
      expect.objectContaining({ caller: { kind: "mcp" } })
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
      expect.objectContaining({ caller: { kind: "mcp" } })
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
        expect.objectContaining({ caller: { kind: "mcp" } })
      )
    } finally {
      await client.close()
      await server.close()
    }
  })
})
