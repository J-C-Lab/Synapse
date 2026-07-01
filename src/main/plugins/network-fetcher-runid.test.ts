import type { CapabilityGatePort, CapabilityRequest } from "./capability-gate"
import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { createNetworkFetcher } from "./network-fetcher"

describe("networkFetcher runId threading", () => {
  it("includes runId in the network:https gate.ensure request", async () => {
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
    expect(seen[0].capability).toBe("network:https")
    expect(seen[0].runId).toBe("run-net")
  })
})
