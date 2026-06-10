import type {
  DiscoveredLanDevice,
  LanDevice,
  LanDiscoveryAdapter,
  LanPlatform,
  LanStatus,
  LocalLanIdentity,
  StoredLanIdentity,
  TrustedLanDevice,
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
  private readonly learnedDeviceIds = new Set<string>()
  private readonly bonjourSeenDeviceIds = new Set<string>()
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
        device.reachable = Boolean(device.port)
        devicesChanged = true
      }
    }
    this.learnedDeviceIds.clear()
    this.bonjourSeenDeviceIds.clear()
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

  learnDevice(device: DiscoveredLanDevice): void {
    if (!this.identity || device.deviceId === this.identity.deviceId) return
    this.learnedDeviceIds.add(device.deviceId)
    this.upsertDevice(device, { discoverySource: "presence" })
  }

  restoreTrustedDevices(trustedDevices: TrustedLanDevice[]): void {
    for (const trusted of trustedDevices) {
      if (!trusted.host?.trim() || !trusted.port) continue
      this.upsertDevice(
        {
          deviceId: trusted.deviceId,
          name: trusted.name,
          host: trusted.host,
          addresses: trusted.addresses?.length ? [...trusted.addresses] : [trusted.host],
          port: trusted.port,
          platform: "unknown",
          capabilities: ["pair", "https-chunks"],
        },
        {
          discoverySource: "trusted-cache",
          lastSeenAt: trusted.lastEndpointSeenAt ?? this.now(),
          online: false,
          paired: true,
          reachable: true,
        }
      )
    }
  }

  private readonly handleDeviceUp = (device: DiscoveredLanDevice): void => {
    if (!this.identity || device.deviceId === this.identity.deviceId) return
    this.bonjourSeenDeviceIds.add(device.deviceId)
    this.upsertDevice(device, { discoverySource: "bonjour" })
    this.emit("device-discovered", device)
  }

  private readonly handleDeviceDown = (deviceId: string): void => {
    if (this.learnedDeviceIds.has(deviceId) && !this.bonjourSeenDeviceIds.has(deviceId)) return
    const device = this.devices.get(deviceId)
    if (!device || !device.online) return
    device.online = false
    device.reachable = Boolean(device.port)
    this.emitDevicesChanged()
    this.emitStatusChanged()
  }

  private upsertDevice(
    device: DiscoveredLanDevice,
    options?: {
      discoverySource?: LanDevice["discoverySource"]
      lastSeenAt?: number
      online?: boolean
      paired?: boolean
      reachable?: boolean
    }
  ): void {
    if (!this.identity || device.deviceId === this.identity.deviceId) return
    this.devices.set(device.deviceId, {
      ...device,
      addresses: [...device.addresses],
      capabilities: [...device.capabilities],
      discoverySource: options?.discoverySource,
      lastSeenAt: options?.lastSeenAt ?? this.now(),
      online: options?.online ?? true,
      paired: options?.paired ?? this.isPaired(device.deviceId),
      reachable: options?.reachable ?? device.port > 0,
    })
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
