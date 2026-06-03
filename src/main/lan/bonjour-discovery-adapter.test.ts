import { describe, expect, it, vi } from "vitest"
import { BonjourLanDiscoveryAdapter, parseBonjourService } from "./bonjour-discovery-adapter"

describe("parseBonjourService", () => {
  it("parses a compatible DesKit TXT record", () => {
    expect(
      parseBonjourService({
        host: "laptop.local",
        port: 0,
        addresses: ["192.168.1.4"],
        txt: {
          v: "1",
          deviceId: "remote-device",
          name: "Laptop",
          platform: "darwin",
          capabilities: "discover, send",
        },
      })
    ).toEqual({
      deviceId: "remote-device",
      name: "Laptop",
      host: "laptop.local",
      addresses: ["192.168.1.4"],
      platform: "darwin",
      port: 0,
      capabilities: ["discover", "send"],
    })
  })

  it("rejects incompatible or incomplete records", () => {
    expect(
      parseBonjourService({
        host: "old.local",
        port: 0,
        txt: { v: "0", deviceId: "old", name: "Old app", platform: "linux" },
      })
    ).toBeNull()
    expect(parseBonjourService({ host: "missing.local", port: 0, txt: { v: "1" } })).toBeNull()
  })
})

describe("bonjour LAN discovery adapter", () => {
  it("allocates a concrete SRV port for discovery-only advertisements", async () => {
    const adapter = new BonjourLanDiscoveryAdapter()
    try {
      await expect(
        adapter.start(
          {
            deviceId: "local-device",
            name: "Test desktop",
            platform: "win32",
            port: 43123,
            capabilities: ["discover", "pair", "https-chunks"],
          },
          vi.fn(),
          vi.fn()
        )
      ).resolves.toBeUndefined()
    } finally {
      await adapter.stop()
    }
  })
})
