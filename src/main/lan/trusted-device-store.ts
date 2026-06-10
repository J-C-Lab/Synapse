import type { DiscoveredLanDevice, TrustedLanDevice, TrustedLanDeviceEndpoint } from "./types"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "./atomic-json-store"

export function trustedDevicesFilePath(userDataDir: string): string {
  return path.join(userDataDir, "lan", "trusted-devices.json")
}

export class TrustedDeviceStore {
  private devices = new Map<string, TrustedLanDevice>()
  private loaded = false

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.loaded) return
    const raw = await readJsonFile(this.filePath)
    if (Array.isArray(raw)) {
      for (const value of raw) {
        const device = normalizeTrustedDevice(value)
        if (device) this.devices.set(device.deviceId, device)
      }
    }
    this.loaded = true
  }

  list(): TrustedLanDevice[] {
    return [...this.devices.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  get(deviceId: string): TrustedLanDevice | null {
    return this.devices.get(deviceId) ?? null
  }

  has(deviceId: string): boolean {
    return this.devices.has(deviceId)
  }

  async trust(device: TrustedLanDevice): Promise<void> {
    this.devices.set(device.deviceId, device)
    await this.save()
  }

  async updateEndpoint(deviceId: string, endpoint: TrustedLanDeviceEndpoint): Promise<void> {
    const device = this.devices.get(deviceId)
    if (!device) return
    this.devices.set(deviceId, { ...device, ...endpoint })
    await this.save()
  }

  async remove(deviceId: string): Promise<void> {
    this.devices.delete(deviceId)
    await this.save()
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.filePath, this.list())
  }
}

export function trustedDeviceWithEndpoint(
  trusted: TrustedLanDevice,
  device: DiscoveredLanDevice | null | undefined,
  now: number
): TrustedLanDevice {
  if (!device?.host.trim() || !device.port) return trusted
  return {
    ...trusted,
    host: device.host,
    addresses: [...device.addresses],
    port: device.port,
    lastEndpointSeenAt: now,
  }
}

export function endpointFromDiscoveredDevice(
  device: DiscoveredLanDevice,
  now: number
): TrustedLanDeviceEndpoint {
  return {
    host: device.host,
    addresses: [...device.addresses],
    port: device.port,
    lastEndpointSeenAt: now,
  }
}

function normalizeTrustedDevice(value: unknown): TrustedLanDevice | null {
  if (!value || typeof value !== "object") return null
  const device = value as Record<string, unknown>
  if (
    typeof device.deviceId !== "string" ||
    typeof device.name !== "string" ||
    typeof device.certificatePem !== "string" ||
    typeof device.certificateFingerprint !== "string" ||
    typeof device.pairedAt !== "number"
  ) {
    return null
  }
  const normalized: TrustedLanDevice = {
    deviceId: device.deviceId,
    name: device.name,
    certificatePem: device.certificatePem,
    certificateFingerprint: device.certificateFingerprint,
    pairedAt: device.pairedAt,
  }
  if (typeof device.host === "string" && device.host.trim()) normalized.host = device.host
  if (Array.isArray(device.addresses)) {
    normalized.addresses = device.addresses.filter(
      (address): address is string => typeof address === "string" && address.trim().length > 0
    )
  }
  if (typeof device.port === "number" && Number.isInteger(device.port) && device.port > 0) {
    normalized.port = device.port
  }
  if (typeof device.lastEndpointSeenAt === "number") {
    normalized.lastEndpointSeenAt = device.lastEndpointSeenAt
  }
  return normalized
}
