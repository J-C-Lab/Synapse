import type { CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { createNetworkFetcher } from "./network-fetcher"

describe("networkFetcher principal + workspaceId threading", () => {
  it("includes principal and workspaceId in the network:https gate.ensure request", async () => {
    const seen: CapabilityRequest[] = []
    const gate: CapabilityGatePort = {
      assertDeclared: () => {},
      ensure: async (request) => {
        seen.push(request)
        throw new Error("stop-after-ensure")
      },
    }
    const fetcher = createNetworkFetcher({
      gate,
      actor: "agent",
      trigger: "tool:fetch",
      pluginId: "com.synapse.test",
      runId: "run-net",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-external",
      resolve: async () => [{ address: "140.82.112.3", family: 4 }],
      transport: async () => ({
        status: 200,
        statusText: "OK",
        headers: {},
        body: Buffer.from("{}"),
      }),
    })

    await expect(fetcher.fetch("https://api.example.com/x", { method: "GET" })).rejects.toThrow()

    expect(seen).toHaveLength(1)
    expect(seen[0].principal).toEqual({ kind: "external-mcp", clientId: "claude-desktop" })
    expect(seen[0].workspaceId).toBe("ws-external")
  })
})
