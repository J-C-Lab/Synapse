import type { ToolResult } from "@synapse/plugin-sdk"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ToolHostSource } from "./composite-tool-host"
import { describe, expect, it, vi } from "vitest"
import { CapabilityDenied } from "../plugins/capability-gate"
import { GovernedBackgroundToolHost } from "./background-host-tool-gate"

const callerOptions = {
  caller: { kind: "background-agent", workspaceId: "ws-1", invocationId: "inv-1" },
} as unknown as ToolInvocationOptions

function fakeSource(descriptor: RegisteredToolDescriptor, invoke = vi.fn(async () => okResult())) {
  const source: ToolHostSource = {
    ownsTool: (fqName) => fqName === descriptor.fqName,
    listTools: () => [descriptor],
    invokeTool: invoke,
  }
  return { source, invoke }
}

function okResult(): ToolResult {
  return { content: [{ type: "text", text: "ok" }] }
}

function descriptorWithCapabilities(
  fqName: string,
  capabilities: { id: string }[]
): RegisteredToolDescriptor {
  return {
    fqName,
    pluginId: "memory:core",
    provenance: "host",
    manifestTool: {
      name: fqName.split("/").at(-1)!,
      title: "t",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      capabilities,
    },
  } as RegisteredToolDescriptor
}

describe("governedBackgroundToolHost", () => {
  it("throws at construction if a source descriptor declares zero or more than one capability", () => {
    const { source: zeroCapSource } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [])
    )
    expect(
      () =>
        new GovernedBackgroundToolHost({
          authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
          sources: [zeroCapSource],
          confirmed: new Set(),
        })
    ).toThrow()

    const { source: twoCapSource } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [
        { id: "memory:read" },
        { id: "execution:read" },
      ])
    )
    expect(
      () =>
        new GovernedBackgroundToolHost({
          authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
          sources: [twoCapSource],
          confirmed: new Set(),
        })
    ).toThrow()
  })

  it("listTools excludes a tool whose capability is not in the confirmed set", () => {
    const { source } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }])
    )
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(),
    })
    expect(host.listTools()).toEqual([])
  })

  it("listTools includes a tool whose capability is in the confirmed set", () => {
    const { source } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }])
    )
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(["memory:read"]),
    })
    expect(host.listTools().map((d) => d.fqName)).toEqual(["memory:core/memory_search"])
  })

  it("invokeTool calls ensure() before delegating, with the capability resolved from the descriptor", async () => {
    const { source, invoke } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }])
    )
    const ensureCalls: CapabilityRequest[] = []
    const ensure = vi.fn(async (request: CapabilityRequest) => {
      ensureCalls.push(request)
    })
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure, confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(["memory:read"]),
    })

    await host.invokeTool("memory:core/memory_search", { query: "x" }, callerOptions)

    expect(ensureCalls).toHaveLength(1)
    expect(ensureCalls[0]?.capability).toBe("memory:read")
    expect(ensureCalls[0]?.operation).toBe("memory_search")
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("deny-before-delegate: invokeTool never calls the source when ensure() throws CapabilityDenied", async () => {
    const { source, invoke } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }])
    )
    const ensure = vi.fn(async () => {
      throw new CapabilityDenied("com.example.watcher", "memory:read", "not granted at enable time")
    })
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure, confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(["memory:read"]),
    })

    await expect(
      host.invokeTool("memory:core/memory_search", { query: "x" }, callerOptions)
    ).rejects.toThrow(CapabilityDenied)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("ownsTool is unaffected by confirmation status — a stale/direct call still routes to ensure() for denial", () => {
    const { source } = fakeSource(
      descriptorWithCapabilities("memory:core/memory_search", [{ id: "memory:read" }])
    )
    const host = new GovernedBackgroundToolHost({
      authorizer: { ensure: vi.fn(), confirmedCapabilities: vi.fn() },
      sources: [source],
      confirmed: new Set(), // not confirmed
    })
    expect(host.ownsTool("memory:core/memory_search")).toBe(true)
  })
})
