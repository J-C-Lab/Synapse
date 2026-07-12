import type { CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import { describe, expect, it } from "vitest"
import { auditIdentityOf } from "./invocation-context"
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

describe("pluginBridge runId threading", () => {
  it("copies caller.runId onto the capability request for tool calls", async () => {
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
      caller: { kind: "agent", conversationId: "c1", runId: "run-xyz" },
      signal: new AbortController().signal,
      toolName: "act",
    })
    await ctx.storage.get("k")

    expect(seen).toHaveLength(1)
    expect(auditIdentityOf(seen[0].invocation).runId).toBe("run-xyz")
  })
})
