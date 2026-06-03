import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "./types"
import { describe, expect, it, vi } from "vitest"
import { PluginToolBridge, ToolInputValidationError } from "./plugin-tool-bridge"

function descriptor(): RegisteredToolDescriptor {
  return {
    fqName: "com.synapse.test/greet",
    pluginId: "com.synapse.test",
    manifestTool: {
      name: "greet",
      description: "Greet someone",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  }
}

function options(): ToolInvocationOptions {
  return { caller: { kind: "agent" } }
}

function bridgeWith(
  invokeTool: (
    pluginId: string,
    toolName: string,
    input: unknown,
    options: ToolInvocationOptions
  ) => Promise<ToolResult>
): { bridge: PluginToolBridge; invokeTool: typeof invokeTool } {
  const spy = vi.fn(invokeTool)
  const bridge = new PluginToolBridge({
    registry: { listTools: () => [descriptor()], invokeTool: spy },
  })
  return { bridge, invokeTool: spy }
}

describe("pluginToolBridge", () => {
  it("lists tools with bound runners", () => {
    const { bridge } = bridgeWith(async () => ({ content: [] }))
    const tools = bridge.list()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.fqName).toBe("com.synapse.test/greet")
    expect(typeof tools[0]?.run).toBe("function")
  })

  it("validates input against inputSchema before delegating", async () => {
    const { bridge, invokeTool } = bridgeWith(async () => ({ content: [] }))

    await expect(bridge.invoke("com.synapse.test/greet", { name: 1 }, options())).rejects.toThrow(
      ToolInputValidationError
    )
    expect(invokeTool).not.toHaveBeenCalled()
  })

  it("delegates valid calls to the registry", async () => {
    const { bridge, invokeTool } = bridgeWith(async (_p, toolName) => ({
      content: [{ type: "text", text: toolName }],
    }))

    const result = await bridge.invoke("com.synapse.test/greet", { name: "Ada" }, options())
    expect(result).toEqual({ content: [{ type: "text", text: "greet" }] })
    expect(invokeTool).toHaveBeenCalledWith(
      "com.synapse.test",
      "greet",
      { name: "Ada" },
      expect.objectContaining({ caller: { kind: "agent" } })
    )
  })

  it("throws for an unknown tool", async () => {
    const { bridge } = bridgeWith(async () => ({ content: [] }))
    await expect(bridge.invoke("com.synapse.test/missing", {}, options())).rejects.toThrow(
      /not found/
    )
  })

  it("surfaces the failing fields on a validation error", async () => {
    const { bridge } = bridgeWith(async () => ({ content: [] }))
    try {
      await bridge.invoke("com.synapse.test/greet", {}, options())
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ToolInputValidationError)
      expect((err as ToolInputValidationError).issues).toContain("input.name: required")
    }
  })
})
