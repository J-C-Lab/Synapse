import type { Browser, Service } from "bonjour-service"
import type {
  DiscoveredLanDevice,
  LanDiscoveryAdapter,
  LanPlatform,
  LocalLanIdentity,
} from "./types"
import { Buffer } from "node:buffer"
import { Bonjour } from "bonjour-service"

const SERVICE_TYPE = "deskit"
const SERVICE_PROTOCOL = "tcp"
const PROTOCOL_VERSION = "1"

export class BonjourLanDiscoveryAdapter implements LanDiscoveryAdapter {
  private bonjour: Bonjour | null = null
  private publication: Service | null = null
  private browser: Browser | null = null
  async start(
    identity: LocalLanIdentity,
    onDeviceUp: (device: DiscoveredLanDevice) => void,
    onDeviceDown: (deviceId: string) => void
  ): Promise<void> {
    await this.stop()

    if (!Number.isInteger(identity.port) || identity.port <= 0) {
      throw new Error("LAN HTTPS server port is not available.")
    }
    const bonjour = new Bonjour({}, (err: unknown) => {
      console.warn("[deskit] LAN mDNS error", err)
    })
    try {
      this.publication = bonjour.publish({
        name: `${identity.name} (${identity.deviceId.slice(0, 8)})`,
        type: SERVICE_TYPE,
        protocol: SERVICE_PROTOCOL,
        port: identity.port,
        txt: {
          v: PROTOCOL_VERSION,
          deviceId: identity.deviceId,
          name: identity.name,
          platform: identity.platform,
          capabilities: identity.capabilities.join(","),
        },
      })
      this.browser = bonjour.find({ type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL })
      this.browser.on("up", (service: Service) => {
        const device = parseBonjourService(service)
        if (device) onDeviceUp(device)
      })
      this.browser.on("down", (service: Service) => {
        const deviceId = textValue(service.txt?.deviceId)
        if (deviceId) onDeviceDown(deviceId)
      })
      this.bonjour = bonjour
    } catch (err) {
      bonjour.destroy()
      this.publication = null
      this.browser = null
      throw err
    }
  }

  async stop(): Promise<void> {
    const browser = this.browser
    const publication = this.publication
    const bonjour = this.bonjour
    this.browser = null
    this.publication = null
    this.bonjour = null

    browser?.stop()
    if (publication?.stop) {
      await new Promise<void>((resolve) => publication.stop?.(resolve))
    }
    if (bonjour) {
      await new Promise<void>((resolve) => bonjour.destroy(resolve))
    }
  }
}

export interface BonjourServiceLike {
  host: string
  port: number
  txt?: Record<string, unknown>
  addresses?: string[]
}

export function parseBonjourService(service: BonjourServiceLike): DiscoveredLanDevice | null {
  const deviceId = textValue(service.txt?.deviceId)
  const name = textValue(service.txt?.name)
  const platform = textValue(service.txt?.platform)
  if (
    textValue(service.txt?.v) !== PROTOCOL_VERSION ||
    !deviceId ||
    !name ||
    !isLanPlatform(platform)
  ) {
    return null
  }
  return {
    deviceId,
    name,
    host: service.host,
    addresses: service.addresses ? [...service.addresses] : [],
    platform,
    port: service.port,
    capabilities: textValue(service.txt?.capabilities)
      .split(",")
      .map((capability) => capability.trim())
      .filter(Boolean),
  }
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (Buffer.isBuffer(value)) return value.toString("utf-8").trim()
  return ""
}

function isLanPlatform(value: string): value is LanPlatform {
  return value === "win32" || value === "darwin" || value === "linux" || value === "unknown"
}
