import type { RegisteredToolDescriptor } from "../plugins/types"
import type { ToolHostSource } from "./composite-tool-host"
import { describe, expect, it, vi } from "vitest"
import { asFallbackSource, CompositeToolHost } from "./composite-tool-host"

function descriptor(fqName: string): RegisteredToolDescriptor {
  return {
    fqName,
    pluginId: fqName.split("/")[0] ?? fqName,
    provenance: "plugin",
    manifestTool: { name: fqName, description: fqName, inputSchema: { type: "object" } },
  }
}

function source(fqNames: string[], owns: (fq: string) => boolean): ToolHostSource {
  return {
    listTools: () => fqNames.map(descriptor),
    invokeTool: vi.fn(async (fqName: string) => ({
      content: [{ type: "text" as const, text: `ran ${fqName}` }],
    })),
    ownsTool: owns,
  }
}

describe("compositeToolHost", () => {
  it("merges tools from every source", () => {
    const plugins = source(["com.x/a"], (fq) => !fq.startsWith("mcp:"))
    const mcp = source(["mcp:srv/b"], (fq) => fq.startsWith("mcp:"))
    const host = new CompositeToolHost([plugins, mcp])
    expect(host.listTools().map((tool) => tool.fqName)).toEqual(["com.x/a", "mcp:srv/b"])
  })

  it("routes an invocation to the owning source", async () => {
    const plugins = source(["com.x/a"], (fq) => !fq.startsWith("mcp:"))
    const mcp = source(["mcp:srv/b"], (fq) => fq.startsWith("mcp:"))
    const host = new CompositeToolHost([plugins, mcp])

    await host.invokeTool("mcp:srv/b", { v: 1 }, { caller: { kind: "agent" } })
    expect(mcp.invokeTool).toHaveBeenCalledWith("mcp:srv/b", { v: 1 }, expect.anything())
    expect(plugins.invokeTool).not.toHaveBeenCalled()
  })

  it("throws when no source owns the fqName", () => {
    const host = new CompositeToolHost([source([], () => false)])
    expect(() => host.invokeTool("ghost/tool", {}, { caller: { kind: "agent" } })).toThrow(
      /No tool source owns/
    )
  })

  it("asFallbackSource owns everything the sibling predicate rejects", () => {
    const fallback = asFallbackSource({ listTools: () => [], invokeTool: vi.fn() }, (fq) =>
      fq.startsWith("mcp:")
    )
    expect(fallback.ownsTool("com.x/a")).toBe(true)
    expect(fallback.ownsTool("mcp:srv/b")).toBe(false)
  })
})
