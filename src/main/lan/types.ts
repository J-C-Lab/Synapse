export type LanPlatform = "win32" | "darwin" | "linux" | "unknown"

export interface StoredLanIdentity {
  deviceId: string
  name: string
}

export interface LocalLanIdentity extends StoredLanIdentity {
  platform: LanPlatform
  port: number
  capabilities: string[]
}

export interface DiscoveredLanDevice extends LocalLanIdentity {
  host: string
  addresses: string[]
}

export interface LanDevice extends DiscoveredLanDevice {
  lastSeenAt: number
  online: boolean
  paired: boolean
}

export interface TrustedLanDevice {
  deviceId: string
  name: string
  certificatePem: string
  certificateFingerprint: string
  pairedAt: number
}

export type LanPairingDirection = "incoming" | "outgoing"
export type LanPairingState = "awaiting-confirmation" | "confirmed" | "rejected"

export interface LanPairing {
  id: string
  direction: LanPairingDirection
  deviceId: string
  deviceName: string
  sas: string
  state: LanPairingState
  createdAt: number
}

export type LanTransferDirection = "incoming" | "outgoing"
export type LanTransferState =
  | "preparing"
  | "transferring"
  | "paused"
  | "awaiting-confirmation"
  | "completed"
  | "rejected"
  | "failed"

export interface LanTransfer {
  id: string
  direction: LanTransferDirection
  deviceId: string
  deviceName: string
  fileName: string
  size: number
  sha256: string
  chunkSize: number
  completedChunks: number
  totalChunks: number
  transferredBytes: number
  state: LanTransferState
  error?: string
}

export interface LanStatus {
  enabled: boolean
  discovering: boolean
  localDeviceId: string
  localDeviceName: string
  deviceCount: number
}

export interface LanDiscoveryAdapter {
  start: (
    identity: LocalLanIdentity,
    onDeviceUp: (device: DiscoveredLanDevice) => void,
    onDeviceDown: (deviceId: string) => void
  ) => Promise<void>
  stop: () => Promise<void>
}
