import type { CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import { describe, expect, it } from "vitest"
import { PluginBridge } from "./plugin-bridge"

function manifest() {
  return {
    id: "com.synapse.test",
    name: "Test",
    version: "1.0.0",
    capabilities: [{ id: "storage:plugin" }],
    contributes: {},
  } as never
}

describe("pluginBridge principal threading", () => {
  it("copies caller.principal and caller.workspaceId onto the capability request", async () => {
    const seen: CapabilityRequest[] = []
    const gate: CapabilityGatePort = {
      assertDeclared: () => {},
      ensure: async (request) => {
        seen.push(request)
      },
    }
    const bridge = new PluginBridge({
      userDataDir: "/tmp/does-not-exist",
      adapters: {
        clipboard: { read: async () => undefined, write: async () => {} },
      } as never,
      createGate: () => gate,
    } as never)

    const ctx = bridge.createToolContext("com.synapse.test", manifest(), {
      caller: {
        kind: "mcp",
        runId: "r1",
        principal: { kind: "external-mcp", clientId: "claude" },
        workspaceId: "ws-ext",
      },
      signal: new AbortController().signal,
      toolName: "read_probe",
    })
    await ctx.storage.get("k")

    expect(seen).toHaveLength(1)
    expect(seen[0].principal).toEqual({ kind: "external-mcp", clientId: "claude" })
    expect(seen[0].workspaceId).toBe("ws-ext")
  })
})
