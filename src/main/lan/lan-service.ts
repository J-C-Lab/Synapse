import type { SecretProtector } from "./credential-store"
import type { LanDevice, LanDiscoveryAdapter, LanPairing, LanStatus, LanTransfer } from "./types"
import { EventEmitter } from "node:events"
import * as path from "node:path"
import { lanCredentialFilePath, LanCredentialStore } from "./credential-store"
import { lanIdentityFilePath, LanIdentityStore } from "./identity-store"
import { LanDiscoveryService } from "./lan-discovery-service"
import { LanSecureServer } from "./lan-secure-server"
import { IncomingTransferStore, OutgoingTransferStore } from "./transfer-store"
import {
  endpointFromDiscoveredDevice,
  trustedDevicesFilePath,
  TrustedDeviceStore,
} from "./trusted-device-store"

export interface LanServiceOptions {
  userDataDir: string
  adapter: LanDiscoveryAdapter
  protector: SecretProtector
  deviceName?: string
  now?: () => number
}

export class LanService extends EventEmitter {
  private readonly identityStore: LanIdentityStore
  private readonly credentialStore: LanCredentialStore
  private readonly trustedDevices: TrustedDeviceStore
  private readonly incomingTransfers: IncomingTransferStore
  private readonly outgoingTransfers: OutgoingTransferStore
  private readonly discovery: LanDiscoveryService
  private readonly announcedEndpoints = new Set<string>()
  private secure: LanSecureServer | null = null

  constructor(private readonly options: LanServiceOptions) {
    super()
    this.identityStore = new LanIdentityStore(
      lanIdentityFilePath(options.userDataDir),
      options.deviceName
    )
    this.credentialStore = new LanCredentialStore(
      lanCredentialFilePath(options.userDataDir),
      options.protector
    )
    this.trustedDevices = new TrustedDeviceStore(trustedDevicesFilePath(options.userDataDir))
    this.incomingTransfers = new IncomingTransferStore(
      path.join(options.userDataDir, "lan", "incoming")
    )
    this.outgoingTransfers = new OutgoingTransferStore(
      path.join(options.userDataDir, "lan", "outgoing-transfers.json")
    )
    this.discovery = new LanDiscoveryService({
      userDataDir: options.userDataDir,
      adapter: options.adapter,
      identityStore: this.identityStore,
      endpointPort: () => this.requireSecure().port(),
      isPaired: (deviceId) => this.trustedDevices.has(deviceId),
      now: options.now,
    })
    this.discovery.on("devices-changed", (devices) => this.emit("devices-changed", devices))
    this.discovery.on("status-changed", (status) => this.emit("status-changed", status))
    this.discovery.on("device-discovered", (device) => {
      void this.announcePresence(device as LanDevice)
    })
  }

  async init(enabled: boolean): Promise<LanStatus> {
    const identity = await this.identityStore.loadOrCreate()
    const credential = await this.credentialStore.loadOrCreate(identity)
    await Promise.all([
      this.trustedDevices.init(),
      this.incomingTransfers.init(),
      this.outgoingTransfers.init(),
    ])
    this.secure = new LanSecureServer({
      identity,
      credential,
      trustedDevices: this.trustedDevices,
      incomingTransfers: this.incomingTransfers,
      outgoingTransfers: this.outgoingTransfers,
      resolveDevice: (deviceId) => this.findDevice(deviceId),
    })
    this.secure.on("pairings-changed", (pairings) => this.emit("pairings-changed", pairings))
    this.secure.on("transfers-changed", (transfers) => this.emit("transfers-changed", transfers))
    this.secure.on("trusted-devices-changed", () => this.discovery.refreshDevices())
    this.secure.on("device-learned", (device) => {
      void this.persistLearnedEndpoint(device as LanDevice)
      this.discovery.learnDevice(device as LanDevice)
    })
    await this.discovery.init(false)
    this.discovery.restoreTrustedDevices(this.trustedDevices.list())
    if (enabled) await this.start()
    return this.getStatus()
  }

  async start(): Promise<LanStatus> {
    await this.requireSecure().start()
    try {
      return await this.discovery.start()
    } catch (err) {
      await this.requireSecure().stop()
      throw err
    }
  }

  async stop(): Promise<LanStatus> {
    const status = await this.discovery.stop()
    await this.secure?.stop()
    return status
  }

  getStatus(): LanStatus {
    return this.discovery.getStatus()
  }

  listDevices(): LanDevice[] {
    return this.discovery.listDevices()
  }

  listPairings(): LanPairing[] {
    return this.requireSecure().listPairings()
  }

  listTransfers(): LanTransfer[] {
    return this.requireSecure().listTransfers()
  }

  async pair(deviceId: string): Promise<LanPairing> {
    return this.requireSecure().pair(this.requireReachableDevice(deviceId))
  }

  async confirmPairing(id: string, sas: string): Promise<LanPairing[]> {
    const pairings = await this.requireSecure().confirmPairing(id, sas)
    this.discovery.refreshDevices()
    return pairings
  }

  async rejectPairing(id: string): Promise<LanPairing[]> {
    return this.requireSecure().rejectPairing(id)
  }

  async disconnect(deviceId: string): Promise<void> {
    await this.requireSecure().disconnect(this.requireReachableDevice(deviceId))
  }

  async sendFile(deviceId: string, sourcePath: string): Promise<LanTransfer> {
    return this.requireSecure().sendFile(this.requireReachableDevice(deviceId), sourcePath)
  }

  async resumeTransfer(id: string): Promise<LanTransfer> {
    return this.requireSecure().resumeTransfer(id)
  }

  async acceptTransfer(id: string, destinationPath: string): Promise<LanTransfer> {
    return this.requireSecure().acceptTransfer(id, destinationPath)
  }

  async rejectTransfer(id: string): Promise<LanTransfer> {
    return this.requireSecure().rejectTransfer(id)
  }

  async removeTransferHistory(id: string): Promise<LanTransfer[]> {
    return this.requireSecure().removeTransferHistory(id)
  }

  private findDevice(deviceId: string): LanDevice | null {
    return this.listDevices().find((device) => device.deviceId === deviceId) ?? null
  }

  private requireReachableDevice(deviceId: string): LanDevice {
    const device = this.findDevice(deviceId)
    if (!device?.port || (!device.online && !device.reachable)) {
      throw new Error("Target device is not reachable.")
    }
    return device
  }

  private async announcePresence(device: LanDevice): Promise<void> {
    if (!device.port) return
    const key = `${device.deviceId}@${device.host}:${device.port}`
    if (this.announcedEndpoints.has(key)) return
    this.announcedEndpoints.add(key)
    try {
      await this.requireSecure().announcePresence(device)
    } catch (err) {
      this.announcedEndpoints.delete(key)
      console.warn("[synapse] Failed to announce LAN presence", err)
    }
  }

  private async persistLearnedEndpoint(device: LanDevice): Promise<void> {
    try {
      await this.trustedDevices.updateEndpoint(
        device.deviceId,
        endpointFromDiscoveredDevice(device, this.options.now?.() ?? Date.now())
      )
    } catch (err) {
      console.warn("[synapse] Failed to persist learned LAN endpoint", err)
    }
  }

  private requireSecure(): LanSecureServer {
    if (!this.secure) throw new Error("LAN service is not initialized.")
    return this.secure
  }
}
