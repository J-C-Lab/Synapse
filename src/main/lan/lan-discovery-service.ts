import type {
  DiscoveredLanDevice,
  LanDevice,
  LanDiscoveryAdapter,
  LanPlatform,
  LanStatus,
  LocalLanIdentity,
  StoredLanIdentity,
} from "./types"
import { EventEmitter } from "node:events"
import process from "node:process"
import { lanIdentityFilePath, LanIdentityStore } from "./identity-store"

export interface LanDiscoveryServiceOptions {
  userDataDir: string
  adapter: LanDiscoveryAdapter
  identityStore?: Pick<LanIdentityStore, "loadOrCreate">
  endpointPort?: () => number
  isPaired?: (deviceId: string) => boolean
  now?: () => number
}

export class LanDiscoveryService extends EventEmitter {
  private readonly adapter: LanDiscoveryAdapter
  private readonly identityStore: Pick<LanIdentityStore, "loadOrCreate">
  private readonly now: () => number
  private readonly endpointPort: () => number
  private readonly isPaired: (deviceId: string) => boolean
  private readonly devices = new Map<string, LanDevice>()
  private identity: LocalLanIdentity | null = null
  private discovering = false

  constructor(options: LanDiscoveryServiceOptions) {
    super()
    this.adapter = options.adapter
    this.identityStore =
      options.identityStore ?? new LanIdentityStore(lanIdentityFilePath(options.userDataDir))
    this.now = options.now ?? Date.now
    this.endpointPort = options.endpointPort ?? (() => 0)
    this.isPaired = options.isPaired ?? (() => false)
  }

  async init(enabled: boolean): Promise<LanStatus> {
    await this.ensureIdentity()
    if (enabled) await this.start()
    return this.getStatus()
  }

  async start(): Promise<LanStatus> {
    if (this.discovering) return this.getStatus()
    const identity = { ...(await this.ensureIdentity()), port: this.endpointPort() }
    await this.adapter.start(identity, this.handleDeviceUp, this.handleDeviceDown)
    this.discovering = true
    this.emitStatusChanged()
    return this.getStatus()
  }

  async stop(): Promise<LanStatus> {
    if (!this.discovering) return this.getStatus()
    await this.adapter.stop()
    this.discovering = false
    let devicesChanged = false
    for (const device of this.devices.values()) {
      if (device.online) {
        device.online = false
        devicesChanged = true
      }
    }
    if (devicesChanged) this.emitDevicesChanged()
    this.emitStatusChanged()
    return this.getStatus()
  }

  getStatus(): LanStatus {
    return {
      enabled: this.discovering,
      discovering: this.discovering,
      localDeviceId: this.identity?.deviceId ?? "",
      localDeviceName: this.identity?.name ?? "",
      deviceCount: [...this.devices.values()].filter((device) => device.online).length,
    }
  }

  listDevices(): LanDevice[] {
    return [...this.devices.values()].sort(
      (left, right) =>
        Number(right.online) - Number(left.online) || left.name.localeCompare(right.name)
    )
  }

  refreshDevices(): void {
    for (const device of this.devices.values()) {
      device.paired = this.isPaired(device.deviceId)
    }
    this.emitDevicesChanged()
  }

  private readonly handleDeviceUp = (device: DiscoveredLanDevice): void => {
    if (!this.identity || device.deviceId === this.identity.deviceId) return
    this.devices.set(device.deviceId, {
      ...device,
      addresses: [...device.addresses],
      capabilities: [...device.capabilities],
      lastSeenAt: this.now(),
      online: true,
      paired: this.isPaired(device.deviceId),
    })
    this.emitDevicesChanged()
    this.emitStatusChanged()
  }

  private readonly handleDeviceDown = (deviceId: string): void => {
    const device = this.devices.get(deviceId)
    if (!device || !device.online) return
    device.online = false
    this.emitDevicesChanged()
    this.emitStatusChanged()
  }

  private async ensureIdentity(): Promise<LocalLanIdentity> {
    if (this.identity) return this.identity
    const stored = await this.identityStore.loadOrCreate()
    this.identity = toLocalIdentity(stored)
    return this.identity
  }

  private emitDevicesChanged(): void {
    this.emit("devices-changed", this.listDevices())
  }

  private emitStatusChanged(): void {
    this.emit("status-changed", this.getStatus())
  }
}

function toLocalIdentity(identity: StoredLanIdentity): LocalLanIdentity {
  return {
    ...identity,
    platform: normalizePlatform(process.platform),
    port: 0,
    capabilities: ["discover", "pair", "https-chunks"],
  }
}

function normalizePlatform(platform: NodeJS.Platform): LanPlatform {
  if (platform === "win32" || platform === "darwin" || platform === "linux") return platform
  return "unknown"
}
