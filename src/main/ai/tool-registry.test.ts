import type { RegisteredToolDescriptor } from "../plugins/types"
import type { ToolHostPort } from "./tool-registry"
import { describe, expect, it, vi } from "vitest"
import { AiToolRegistry, renderToolResultText } from "./tool-registry"

function descriptor(fqName: string): RegisteredToolDescriptor {
  return {
    fqName,
    pluginId: fqName.split("/")[0] ?? fqName,
    manifestTool: {
      name: fqName.split("/")[1] ?? fqName,
      description: `Tool ${fqName}`,
      inputSchema: { type: "object", properties: {} },
    },
  }
}

function host(descriptors: RegisteredToolDescriptor[]): ToolHostPort {
  return {
    listTools: () => descriptors,
    invokeTool: vi.fn(async (fqName: string) => ({
      content: [{ type: "text" as const, text: `ran ${fqName}` }],
    })),
  }
}

describe("aiToolRegistry", () => {
  it("sanitizes fqNames into model-safe tool names", () => {
    const registry = new AiToolRegistry(host([descriptor("com.example.hello-world/greet")]))
    expect(registry.list()[0]?.name).toBe("com_example_hello-world_greet")
  })

  it("routes an invocation back to the original fqName", async () => {
    const h = host([descriptor("com.example.hello-world/greet")])
    const registry = new AiToolRegistry(h)
    registry.list()

    const result = await registry.invoke(
      "com_example_hello-world_greet",
      { a: 1 },
      {
        caller: { kind: "agent" },
      }
    )
    expect(result.content[0]).toMatchObject({ text: "ran com.example.hello-world/greet" })
    expect(h.invokeTool).toHaveBeenCalledWith(
      "com.example.hello-world/greet",
      { a: 1 },
      expect.anything()
    )
  })

  it("disambiguates names that sanitize identically", () => {
    const registry = new AiToolRegistry(host([descriptor("com.x/a"), descriptor("com_x/a")]))
    const names = registry.list().map((tool) => tool.name)
    expect(new Set(names).size).toBe(2)
    expect(names[0]).toBe("com_x_a")
    expect(names[1]).toBe("com_x_a_2")
  })

  it("refreshes the map when invoking a name not seen since the last list", async () => {
    const h = host([descriptor("com.x/a")])
    const registry = new AiToolRegistry(h)
    // No prior list() call — invoke must rebuild the reverse map itself.
    await registry.invoke("com_x_a", {}, { caller: { kind: "agent" } })
    expect(h.invokeTool).toHaveBeenCalledWith("com.x/a", {}, expect.anything())
  })

  it("throws for an unknown tool name", async () => {
    const registry = new AiToolRegistry(host([descriptor("com.x/a")]))
    await expect(registry.invoke("nope", {}, { caller: { kind: "agent" } })).rejects.toThrow(
      /Unknown tool/
    )
  })
})

describe("renderToolResultText", () => {
  it("flattens text, json, and image blocks", () => {
    expect(
      renderToolResultText({
        content: [
          { type: "text", text: "hello" },
          { type: "json", json: { a: 1 } },
          { type: "image", path: "/x.png", mimeType: "image/png" },
        ],
      })
    ).toBe('hello\n{"a":1}\n[image: /x.png]')
  })
})
