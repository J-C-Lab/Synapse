import type {
  DiscoveredLanDevice,
  LanDiscoveryAdapter,
  LocalLanIdentity,
  StoredLanIdentity,
  TrustedLanDevice,
} from "./types"
import { describe, expect, it, vi } from "vitest"
import { LanDiscoveryService } from "./lan-discovery-service"

class FakeLanDiscoveryAdapter implements LanDiscoveryAdapter {
  identity: LocalLanIdentity | null = null
  onDeviceUp: ((device: DiscoveredLanDevice) => void) | null = null
  onDeviceDown: ((deviceId: string) => void) | null = null
  start = vi.fn(
    async (
      identity: LocalLanIdentity,
      onDeviceUp: (device: DiscoveredLanDevice) => void,
      onDeviceDown: (deviceId: string) => void
    ) => {
      this.identity = identity
      this.onDeviceUp = onDeviceUp
      this.onDeviceDown = onDeviceDown
    }
  )
  stop = vi.fn(async () => {})
}

const localIdentity: StoredLanIdentity = {
  deviceId: "local-device",
  name: "Local desktop",
}

const remoteDevice: DiscoveredLanDevice = {
  deviceId: "remote-device",
  name: "Remote laptop",
  host: "remote.local",
  addresses: ["192.168.1.42"],
  platform: "linux",
  port: 0,
  capabilities: ["discover"],
}

function createService(adapter = new FakeLanDiscoveryAdapter()) {
  return {
    adapter,
    service: new LanDiscoveryService({
      userDataDir: "ignored",
      adapter,
      identityStore: { loadOrCreate: vi.fn(async () => localIdentity) },
      now: () => 1234,
    }),
  }
}

describe("lanDiscoveryService", () => {
  it("loads identity without browsing when disabled", async () => {
    const { adapter, service } = createService()

    await expect(service.init(false)).resolves.toMatchObject({
      enabled: false,
      localDeviceId: "local-device",
      localDeviceName: "Local desktop",
    })
    expect(adapter.start).not.toHaveBeenCalled()
  })

  it("starts discovery and advertises only the discovery capability", async () => {
    const { adapter, service } = createService()

    await service.init(true)

    expect(adapter.start).toHaveBeenCalledOnce()
    expect(adapter.identity).toMatchObject({
      deviceId: "local-device",
      name: "Local desktop",
      port: 0,
      capabilities: ["discover", "pair", "https-chunks"],
    })
    expect(service.getStatus()).toMatchObject({ enabled: true, discovering: true })
  })

  it("tracks remote devices, ignores itself, and marks devices offline when stopped", async () => {
    const { adapter, service } = createService()
    const onDevicesChanged = vi.fn()
    service.on("devices-changed", onDevicesChanged)
    await service.start()

    adapter.onDeviceUp?.(remoteDevice)
    adapter.onDeviceUp?.({ ...remoteDevice, deviceId: "local-device" })

    expect(service.listDevices()).toEqual([
      {
        ...remoteDevice,
        addresses: ["192.168.1.42"],
        capabilities: ["discover"],
        discoverySource: "bonjour",
        lastSeenAt: 1234,
        online: true,
        paired: false,
        reachable: false,
      },
    ])
    expect(service.getStatus().deviceCount).toBe(1)

    await service.stop()

    expect(adapter.stop).toHaveBeenCalledOnce()
    expect(service.listDevices()[0]?.online).toBe(false)
    expect(service.getStatus().deviceCount).toBe(0)
    expect(onDevicesChanged).toHaveBeenCalledTimes(2)
  })

  it("marks a discovered device offline after a down event", async () => {
    const { adapter, service } = createService()
    await service.start()

    adapter.onDeviceUp?.(remoteDevice)
    adapter.onDeviceDown?.("remote-device")

    expect(service.listDevices()[0]?.online).toBe(false)
  })

  it("learns a presence-announced device without duplicating discovery state", async () => {
    const { adapter, service } = createService()
    const onDevicesChanged = vi.fn()
    service.on("devices-changed", onDevicesChanged)
    await service.start()

    service.learnDevice({ ...remoteDevice, host: "192.168.1.42", port: 49152 })
    adapter.onDeviceDown?.("remote-device")

    expect(service.listDevices()).toEqual([
      expect.objectContaining({
        deviceId: "remote-device",
        discoverySource: "presence",
        online: true,
        reachable: true,
      }),
    ])
    expect(onDevicesChanged).toHaveBeenCalledTimes(1)

    adapter.onDeviceUp?.({ ...remoteDevice, host: "remote.local", port: 49152 })

    expect(service.listDevices()).toEqual([
      expect.objectContaining({
        deviceId: "remote-device",
        discoverySource: "bonjour",
        host: "remote.local",
        online: true,
        reachable: true,
      }),
    ])
  })

  it("restores trusted endpoints as paired reachable cache entries", async () => {
    const { service } = createService()
    const trusted: TrustedLanDevice = {
      deviceId: "trusted-device",
      name: "Trusted laptop",
      certificatePem: "cert",
      certificateFingerprint: "fingerprint",
      pairedAt: 1000,
      host: "trusted.local",
      addresses: ["192.168.1.99"],
      port: 49200,
      lastEndpointSeenAt: 4321,
    }
    await service.init(false)

    service.restoreTrustedDevices([trusted])

    expect(service.listDevices()).toEqual([
      expect.objectContaining({
        deviceId: "trusted-device",
        discoverySource: "trusted-cache",
        lastSeenAt: 4321,
        online: false,
        paired: true,
        reachable: true,
      }),
    ])
  })
})
