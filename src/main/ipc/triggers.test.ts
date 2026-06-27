import type { PluginHost } from "../plugins/plugin-host"
import { describe, expect, it, vi } from "vitest"
import { TriggerIpcService } from "./triggers"

describe("triggerIpcService", () => {
  it("lists trigger rows from the host", async () => {
    const host = {
      listTriggers: vi.fn(async () => [
        {
          pluginId: "com.example.timer",
          triggerId: "tick",
          type: "timer",
          status: "active",
          budgets: [{ capabilityId: "notification", used: 1, max: 5 }],
        },
      ]),
    } as unknown as PluginHost
    const service = new TriggerIpcService(() => host)
    await expect(service.listTriggers()).resolves.toEqual([
      {
        pluginId: "com.example.timer",
        triggerId: "tick",
        type: "timer",
        status: "active",
        budgets: [{ capabilityId: "notification", used: 1, max: 5 }],
      },
    ])
  })

  it("pause delegates to the host", () => {
    const host = {
      pauseTrigger: vi.fn(),
      listTriggers: vi.fn(async () => []),
    } as unknown as PluginHost
    const service = new TriggerIpcService(() => host)
    service.pause("com.example.timer", "tick")
    expect(host.pauseTrigger).toHaveBeenCalledWith("com.example.timer", "tick")
  })
})
