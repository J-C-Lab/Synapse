import type { SecretProtector } from "./credential-store"
import type { DiscoveredLanDevice, LanDiscoveryAdapter, LocalLanIdentity } from "./types"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LanService } from "./lan-service"

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

const protector: SecretProtector = {
  encrypt: (value) => Buffer.from(value).toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf-8"),
}

describe("lanService", () => {
  const dirs: string[] = []
  const services: LanService[] = []

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()))
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  it("makes a one-way mDNS peer visible on the blind side through presence announce", async () => {
    const aliceAdapter = new FakeLanDiscoveryAdapter()
    const bobAdapter = new FakeLanDiscoveryAdapter()
    const alice = await createService("Alice desktop", aliceAdapter)
    const bob = await createService("Bob laptop", bobAdapter)

    aliceAdapter.onDeviceUp?.(deviceFor(bobAdapter.identity!))

    await vi.waitFor(
      () => {
        expect(bob.service.listDevices()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              deviceId: aliceAdapter.identity!.deviceId,
              discoverySource: "presence",
              name: "Alice desktop",
              online: true,
              paired: false,
              reachable: true,
            }),
          ])
        )
      },
      { interval: 50, timeout: 10_000 }
    )

    expect(alice.service.listDevices()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: bobAdapter.identity!.deviceId,
          discoverySource: "bonjour",
          online: true,
        }),
      ])
    )
  }, 30_000)

  async function createService(deviceName: string, adapter: FakeLanDiscoveryAdapter) {
    const dir = await tempDir()
    const service = new LanService({
      userDataDir: dir,
      adapter,
      deviceName,
      protector,
    })
    services.push(service)
    await service.init(true)
    return { dir, service }
  }

  async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-lan-service-"))
    dirs.push(dir)
    return dir
  }

  function deviceFor(identity: LocalLanIdentity): DiscoveredLanDevice {
    return {
      ...identity,
      host: "127.0.0.1",
      addresses: ["127.0.0.1"],
    }
  }
})
