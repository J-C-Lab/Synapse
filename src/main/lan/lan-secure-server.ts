import type { IncomingHttpHeaders, ServerResponse } from "node:http"
import type { Server } from "node:https"
import type { AddressInfo } from "node:net"
import type { TLSSocket } from "node:tls"
import type { LanCredential } from "./credential-store"
import type {
  PairingChallenge,
  PairingCommitment,
  PairingIdentity,
  PairingReveal,
  PresenceAnnouncement,
} from "./sas-pairing"
import type {
  IncomingTransferRequest,
  IncomingTransferStatus,
  IncomingTransferStore,
  OutgoingTransferStore,
} from "./transfer-store"
import type { TrustedDeviceStore } from "./trusted-device-store"
import type {
  DiscoveredLanDevice,
  LanDevice,
  LanPairing,
  LanTransfer,
  StoredLanIdentity,
} from "./types"
import { Buffer } from "node:buffer"
import { EventEmitter } from "node:events"
import { createServer, request } from "node:https"
import { isIP } from "node:net"
import { logger } from "../logging"
import { certificateFingerprint } from "./credential-store"
import { SasPairingManager } from "./sas-pairing"
import { readChunk, sha256Buffer } from "./transfer-store"
import { trustedDeviceWithEndpoint } from "./trusted-device-store"

const JSON_LIMIT = 64 * 1024
const CHUNK_LIMIT = 2 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export interface LanSecureServerOptions {
  identity: StoredLanIdentity
  credential: LanCredential
  trustedDevices: TrustedDeviceStore
  incomingTransfers: IncomingTransferStore
  outgoingTransfers: OutgoingTransferStore
  requestTimeoutMs?: number
  resolveDevice: (deviceId: string) => LanDevice | null
}

export class LanSecureServer extends EventEmitter {
  private readonly pairing: SasPairingManager
  private readonly pairingPeerFingerprints = new Map<string, string>()
  private readonly pairingPeerDevices = new Map<string, DiscoveredLanDevice>()
  private server: Server | null = null

  constructor(private readonly options: LanSecureServerOptions) {
    super()
    this.pairing = new SasPairingManager(this.localPairingIdentity())
  }

  async start(): Promise<number> {
    if (this.server) return this.port()
    this.server = createServer(
      {
        cert: this.options.credential.certificatePem,
        key: this.options.credential.privateKeyPem,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
      },
      (req, res) => {
        void this.handleRequest(req, res).catch((err) => {
          logger.child("lan").warn("HTTPS request failed", { err })
          sendJson(res, 400, { error: errorMessage(err) })
        })
      }
    )
    this.server.unref()
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      this.server?.once("error", onError)
      this.server?.listen({ host: "0.0.0.0", port: 0 }, () => {
        this.server?.off("error", onError)
        resolve()
      })
    })
    return this.port()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server?.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  port(): number {
    const address = this.server?.address()
    if (!address || typeof address === "string") throw new Error("LAN HTTPS server is not running.")
    return (address as AddressInfo).port
  }

  listPairings(): LanPairing[] {
    return this.pairing.list()
  }

  listTransfers(): LanTransfer[] {
    return [...this.options.incomingTransfers.list(), ...this.options.outgoingTransfers.list()]
  }

  async pair(device: LanDevice): Promise<LanPairing> {
    const draft = this.pairing.createOutgoingDraft({ endpointPort: this.port() })
    const challenge = await this.requestJson<PairingChallenge>(
      device,
      "POST",
      "/v1/pairing/requests",
      draft.commitment
    )
    assertPeerFingerprint(challenge.peerFingerprint, challenge.body.responderIdentity)
    const { pairing, reveal } = draft.complete(challenge.body)
    await this.requestJson(device, "POST", `/v1/pairing/requests/${pairing.id}/reveal`, reveal, {
      expectedFingerprint: challenge.peerFingerprint,
    })
    this.emitPairingsChanged()
    return pairing
  }

  async announcePresence(device: LanDevice): Promise<void> {
    await this.requestJson(device, "POST", "/v1/presence", {
      endpointPort: this.port(),
      identity: this.localPairingIdentity(),
    } satisfies PresenceAnnouncement)
  }

  async confirmPairing(id: string, sas: string): Promise<LanPairing[]> {
    const trusted = this.pairing.prepareOutgoingConfirmation(id, sas)
    const device = this.resolvePairingDevice(id, trusted.deviceId)
    if (!isReachableDevice(device)) throw new Error("Target device is not reachable.")
    await this.requestJson(
      device,
      "POST",
      `/v1/pairing/requests/${id}/confirm`,
      {},
      {
        expectedFingerprint: trusted.certificateFingerprint,
      }
    )
    await this.options.trustedDevices.trust(trustedDeviceWithEndpoint(trusted, device, Date.now()))
    this.pairingPeerDevices.delete(id)
    this.pairing.markConfirmed(id, "outgoing")
    this.emitTrustedDevicesChanged()
    this.emitPairingsChanged()
    return this.listPairings()
  }

  async rejectPairing(id: string): Promise<LanPairing[]> {
    const pairing = this.pairing.get(id)
    if (!pairing || pairing.state !== "awaiting-confirmation") return this.listPairings()
    const fingerprint = this.pairing.peerFingerprint(id)
    this.pairing.reject(id)
    this.pairingPeerDevices.delete(id)
    this.emitPairingsChanged()
    const device = this.options.resolveDevice(pairing.deviceId)
    if (isReachableDevice(device)) {
      try {
        await this.requestJson(
          device,
          "POST",
          `/v1/pairing/requests/${id}/reject`,
          {},
          {
            expectedFingerprint: fingerprint,
          }
        )
      } catch (err) {
        logger.child("lan").warn("failed to notify rejected pairing", { err })
      }
    }
    return this.listPairings()
  }

  async disconnect(device: LanDevice): Promise<void> {
    const trusted = requireTrustedDevice(this.options.trustedDevices, device.deviceId)
    await this.requestJson(
      device,
      "POST",
      "/v1/trusted-devices/disconnect",
      {},
      {
        expectedFingerprint: trusted.certificateFingerprint,
      }
    )
    await this.options.trustedDevices.remove(device.deviceId)
    this.emitTrustedDevicesChanged()
  }

  async sendFile(device: LanDevice, sourcePath: string): Promise<LanTransfer> {
    const transfer = await this.options.outgoingTransfers.create(
      device.deviceId,
      device.name,
      sourcePath
    )
    this.emitTransfersChanged()
    return this.upload(device, transfer.id)
  }

  async resumeTransfer(id: string): Promise<LanTransfer> {
    const transfer = this.options.outgoingTransfers.get(id)
    if (!transfer) throw new Error("Outgoing transfer was not found.")
    const device = this.options.resolveDevice(transfer.deviceId)
    if (!isReachableDevice(device)) throw new Error("Target device is not reachable.")
    return this.upload(device, id)
  }

  async acceptTransfer(id: string, destinationPath: string): Promise<LanTransfer> {
    const transfer = await this.options.incomingTransfers.accept(id, destinationPath)
    this.emitTransfersChanged()
    return transfer
  }

  async rejectTransfer(id: string): Promise<LanTransfer> {
    const transfer = await this.options.incomingTransfers.reject(id)
    this.emitTransfersChanged()
    return transfer
  }

  async removeTransferHistory(id: string): Promise<LanTransfer[]> {
    const incoming = this.options.incomingTransfers.get(id)
    if (incoming) {
      assertRemovableTransferHistory(incoming)
      await this.options.incomingTransfers.remove(id)
    } else {
      const outgoing = this.options.outgoingTransfers.get(id)
      if (!outgoing) throw new Error("Transfer was not found.")
      assertRemovableTransferHistory(outgoing)
      await this.options.outgoingTransfers.remove(id)
    }
    this.emitTransfersChanged()
    return this.listTransfers()
  }

  private async upload(device: LanDevice, id: string): Promise<LanTransfer> {
    const metadata = this.options.outgoingTransfers.get(id)
    if (!metadata) throw new Error("Outgoing transfer was not found.")
    const trusted = requireTrustedDevice(this.options.trustedDevices, device.deviceId)
    try {
      const status = await this.requestJson<IncomingTransferStatus>(
        device,
        "POST",
        "/v1/transfers",
        {
          id: metadata.id,
          deviceId: this.options.identity.deviceId,
          deviceName: this.options.identity.name,
          fileName: metadata.fileName,
          size: metadata.size,
          sha256: metadata.sha256,
          chunkSize: metadata.chunkSize,
        } satisfies IncomingTransferRequest,
        { expectedFingerprint: trusted.certificateFingerprint }
      )
      await this.options.outgoingTransfers.update(id, { state: "transferring", error: undefined })
      this.emitTransfersChanged()
      let completedChunks = metadata.totalChunks - status.body.missingChunks.length
      let transferredBytes = Math.min(metadata.size, completedChunks * metadata.chunkSize)
      for (const index of status.body.missingChunks) {
        const chunk = await readChunk(metadata.sourcePath, index, metadata.chunkSize)
        await this.requestBuffer(
          device,
          "PUT",
          `/v1/transfers/${id}/chunks/${index}`,
          chunk,
          sha256Buffer(chunk),
          trusted.certificateFingerprint
        )
        completedChunks += 1
        transferredBytes = Math.min(metadata.size, transferredBytes + chunk.length)
        await this.options.outgoingTransfers.update(id, { completedChunks, transferredBytes })
        this.emitTransfersChanged()
      }
      await this.requestJson(
        device,
        "POST",
        `/v1/transfers/${id}/complete`,
        {},
        { expectedFingerprint: trusted.certificateFingerprint }
      )
      const transfer = await this.options.outgoingTransfers.update(id, {
        state: "completed",
        completedChunks: metadata.totalChunks,
        transferredBytes: metadata.size,
      })
      this.emitTransfersChanged()
      return transfer
    } catch (err) {
      const transfer = await this.options.outgoingTransfers.update(id, {
        state: "paused",
        error: errorMessage(err),
      })
      this.emitTransfersChanged()
      return transfer
    }
  }

  private async handleRequest(req: import("node:http").IncomingMessage, res: ServerResponse) {
    if (req.method === "POST" && req.url === "/v1/presence") {
      const fingerprint = peerFingerprint(req)
      const announcement = await readJson<PresenceAnnouncement>(req)
      assertPeerFingerprint(fingerprint, announcement.identity)
      const device = deviceFromRemote(announcement.identity, announcement.endpointPort, req)
      if (device && this.canLearnDevice(device.deviceId, fingerprint)) {
        this.emit("device-learned", device)
      }
      sendJson(res, 200, {})
      return
    }

    if (req.method === "POST" && req.url === "/v1/pairing/requests") {
      const commitment = await readJson<PairingCommitment>(req)
      const fingerprint = peerFingerprint(req)
      assertPeerFingerprint(fingerprint, commitment.identity)
      const device = deviceFromRemote(commitment.identity, commitment.endpointPort, req)
      const challenge = this.pairing.acceptIncomingCommitment(commitment)
      this.pairingPeerFingerprints.set(challenge.id, commitment.identity.certificateFingerprint)
      if (device) {
        this.pairingPeerDevices.set(challenge.id, device)
        if (this.canLearnDevice(device.deviceId, fingerprint)) this.emit("device-learned", device)
      }
      sendJson(res, 200, challenge)
      return
    }

    const revealMatch = req.url?.match(/^\/v1\/pairing\/requests\/([^/]+)\/reveal$/)
    if (req.method === "POST" && revealMatch) {
      const id = revealMatch[1]
      assertFingerprint(peerFingerprint(req), this.pairingPeerFingerprints.get(id))
      const pairing = this.pairing.acceptIncomingReveal(id, await readJson<PairingReveal>(req))
      this.pairingPeerFingerprints.delete(id)
      this.emitPairingsChanged()
      sendJson(res, 200, pairing)
      return
    }

    const confirmMatch = req.url?.match(/^\/v1\/pairing\/requests\/([^/]+)\/confirm$/)
    if (req.method === "POST" && confirmMatch) {
      const id = confirmMatch[1]
      assertFingerprint(peerFingerprint(req), this.pairing.peerFingerprint(id))
      await readJson(req)
      await this.options.trustedDevices.trust(
        trustedDeviceWithEndpoint(
          this.pairing.prepareIncomingConfirmation(id),
          this.pairingPeerDevices.get(id),
          Date.now()
        )
      )
      this.pairingPeerDevices.delete(id)
      this.pairing.markConfirmed(id, "incoming")
      this.emitTrustedDevicesChanged()
      this.emitPairingsChanged()
      sendJson(res, 200, {})
      return
    }

    const rejectMatch = req.url?.match(/^\/v1\/pairing\/requests\/([^/]+)\/reject$/)
    if (req.method === "POST" && rejectMatch) {
      const id = rejectMatch[1]
      assertFingerprint(peerFingerprint(req), this.pairing.peerFingerprint(id))
      await readJson(req)
      this.pairing.reject(id)
      this.pairingPeerDevices.delete(id)
      this.emitPairingsChanged()
      sendJson(res, 200, {})
      return
    }

    const trusted = this.requireTrustedPeer(req)
    if (req.method === "POST" && req.url === "/v1/trusted-devices/disconnect") {
      await readJson(req)
      await this.options.trustedDevices.remove(trusted.deviceId)
      this.emitTrustedDevicesChanged()
      sendJson(res, 200, {})
      return
    }

    if (req.method === "POST" && req.url === "/v1/transfers") {
      const transfer = await readJson<IncomingTransferRequest>(req)
      if (transfer.deviceId !== trusted.deviceId) throw new Error("Sender identity mismatch.")
      const status = await this.options.incomingTransfers.create(transfer)
      this.emitTransfersChanged()
      sendJson(res, 200, status)
      return
    }

    const chunkMatch = req.url?.match(/^\/v1\/transfers\/([^/]+)\/chunks\/(\d+)$/)
    if (req.method === "PUT" && chunkMatch) {
      this.assertTransferOwner(chunkMatch[1], trusted.deviceId)
      const chunk = await readBody(req, CHUNK_LIMIT)
      const transfer = await this.options.incomingTransfers.putChunk(
        chunkMatch[1],
        Number(chunkMatch[2]),
        chunk,
        requiredHeader(req.headers, "x-synapse-chunk-sha256")
      )
      this.emitTransfersChanged()
      sendJson(res, 200, transfer)
      return
    }

    const completeMatch = req.url?.match(/^\/v1\/transfers\/([^/]+)\/complete$/)
    if (req.method === "POST" && completeMatch) {
      this.assertTransferOwner(completeMatch[1], trusted.deviceId)
      await readJson(req)
      const transfer = await this.options.incomingTransfers.complete(completeMatch[1])
      this.emitTransfersChanged()
      sendJson(res, 200, transfer)
      return
    }

    sendJson(res, 404, { error: "Not found." })
  }

  private requireTrustedPeer(req: import("node:http").IncomingMessage) {
    const deviceId = requiredHeader(req.headers, "x-synapse-device-id")
    const trusted = requireTrustedDevice(this.options.trustedDevices, deviceId)
    assertFingerprint(peerFingerprint(req), trusted.certificateFingerprint)
    return trusted
  }

  private assertTransferOwner(transferId: string, deviceId: string): void {
    const transfer = this.options.incomingTransfers.get(transferId)
    if (!transfer || transfer.deviceId !== deviceId) throw new Error("Sender identity mismatch.")
  }

  private requestJson<T = unknown>(
    device: DiscoveredLanDevice,
    method: string,
    requestPath: string,
    body: unknown,
    options?: { expectedFingerprint?: string }
  ): Promise<{ body: T; peerFingerprint: string }> {
    return this.request(device, method, requestPath, Buffer.from(JSON.stringify(body)), {
      "content-type": "application/json",
      expectedFingerprint: options?.expectedFingerprint,
    }).then(({ body: responseBody, peerFingerprint }) => ({
      body: JSON.parse(responseBody.toString("utf-8")) as T,
      peerFingerprint,
    }))
  }

  private requestBuffer(
    device: DiscoveredLanDevice,
    method: string,
    requestPath: string,
    body: Buffer,
    sha256: string,
    expectedFingerprint: string
  ): Promise<{ body: Buffer; peerFingerprint: string }> {
    return this.request(device, method, requestPath, body, {
      "content-type": "application/octet-stream",
      "x-synapse-chunk-sha256": sha256,
      expectedFingerprint,
    })
  }

  private request(
    device: DiscoveredLanDevice,
    method: string,
    requestPath: string,
    body: Buffer,
    headers: Record<string, string | undefined> & { expectedFingerprint?: string }
  ): Promise<{ body: Buffer; peerFingerprint: string }> {
    return this.requestCandidates(
      candidateHosts(device),
      device.port,
      method,
      requestPath,
      body,
      headers
    )
  }

  private async requestCandidates(
    hosts: string[],
    port: number,
    method: string,
    requestPath: string,
    body: Buffer,
    headers: Record<string, string | undefined> & { expectedFingerprint?: string }
  ): Promise<{ body: Buffer; peerFingerprint: string }> {
    let lastNetworkError: unknown
    for (const hostname of hosts) {
      try {
        return await this.requestHost(hostname, port, method, requestPath, body, headers)
      } catch (err) {
        if (!isRetryableNetworkError(err)) throw err
        lastNetworkError = err
      }
    }
    throw asError(lastNetworkError ?? new Error("No LAN device address is available."))
  }

  private requestHost(
    hostname: string,
    port: number,
    method: string,
    requestPath: string,
    body: Buffer,
    headers: Record<string, string | undefined> & { expectedFingerprint?: string }
  ): Promise<{ body: Buffer; peerFingerprint: string }> {
    const { expectedFingerprint, ...requestHeaders } = headers
    return new Promise((resolve, reject) => {
      const client = request(
        {
          hostname,
          port,
          path: requestPath,
          method,
          key: this.options.credential.privateKeyPem,
          cert: this.options.credential.certificatePem,
          // Peers use self-signed device certificates rather than a CA chain.
          // Authenticate trusted requests with the SAS-pinned fingerprint below.
          rejectUnauthorized: false,
          agent: false,
          headers: {
            ...requestHeaders,
            "content-length": body.length,
            "x-synapse-device-id": this.options.identity.deviceId,
          },
        },
        async (response) => {
          try {
            const fingerprint = peerFingerprint(response)
            if (expectedFingerprint) assertFingerprint(fingerprint, expectedFingerprint)
            const responseBody = await readBody(response, CHUNK_LIMIT)
            if ((response.statusCode ?? 500) >= 400) {
              throw new Error(responseBody.toString("utf-8") || `HTTP ${response.statusCode}`)
            }
            resolve({ body: responseBody, peerFingerprint: fingerprint })
          } catch (err) {
            reject(err)
          }
        }
      )
      client.setTimeout(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, () => {
        client.destroy(networkError("LAN request timed out.", "ETIMEDOUT"))
      })
      client.once("error", reject)
      if (expectedFingerprint) {
        client.once("socket", (socket) => {
          const tlsSocket = socket as TLSSocket
          tlsSocket.once("secureConnect", () => {
            try {
              assertFingerprint(peerFingerprint({ socket }), expectedFingerprint)
              client.end(body)
            } catch (err) {
              client.destroy(asError(err))
            }
          })
        })
        client.flushHeaders()
      } else {
        client.end(body)
      }
    })
  }

  private localPairingIdentity(): PairingIdentity {
    return {
      deviceId: this.options.identity.deviceId,
      name: this.options.identity.name,
      certificatePem: this.options.credential.certificatePem,
      certificateFingerprint: this.options.credential.certificateFingerprint,
    }
  }

  private canLearnDevice(deviceId: string, fingerprint: string): boolean {
    if (deviceId === this.options.identity.deviceId) return false
    const trusted = this.options.trustedDevices.get(deviceId)
    return !trusted || trusted.certificateFingerprint === fingerprint
  }

  private resolvePairingDevice(
    id: string,
    deviceId: string
  ): LanDevice | DiscoveredLanDevice | null {
    return this.options.resolveDevice(deviceId) ?? this.pairingPeerDevices.get(id) ?? null
  }

  private emitPairingsChanged(): void {
    this.emit("pairings-changed", this.listPairings())
  }

  private emitTransfersChanged(): void {
    this.emit("transfers-changed", this.listTransfers())
  }

  private emitTrustedDevicesChanged(): void {
    this.emit("trusted-devices-changed")
  }
}

function peerFingerprint(message: { socket: import("node:net").Socket }): string {
  const certificate = (message.socket as TLSSocket).getPeerCertificate()
  if (!certificate || !certificate.fingerprint256)
    throw new Error("Peer TLS certificate is missing.")
  return certificate.fingerprint256
}

function assertPeerFingerprint(actual: string, identity: PairingIdentity): void {
  assertFingerprint(
    certificateFingerprint(identity.certificatePem),
    identity.certificateFingerprint
  )
  assertFingerprint(actual, identity.certificateFingerprint)
}

function assertFingerprint(actual: string, expected: string | undefined): void {
  if (!expected || actual !== expected)
    throw new Error("Peer TLS certificate fingerprint mismatch.")
}

function requireTrustedDevice(store: TrustedDeviceStore, deviceId: string) {
  const trusted = store.get(deviceId)
  if (!trusted) throw new Error("Peer device is not trusted.")
  return trusted
}

function assertRemovableTransferHistory(transfer: LanTransfer): void {
  if (
    transfer.state !== "completed" &&
    transfer.state !== "rejected" &&
    transfer.state !== "failed" &&
    transfer.state !== "paused"
  ) {
    throw new Error("Only finished transfer history can be deleted.")
  }
}

async function readJson<T = unknown>(req: import("node:http").IncomingMessage): Promise<T> {
  return JSON.parse((await readBody(req, JSON_LIMIT)).toString("utf-8")) as T
}

async function readBody(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.length
    if (size > limit) throw new Error("Request body is too large.")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function requiredHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name} header.`)
  return value
}

export function candidateHosts(device: DiscoveredLanDevice | LanDevice): string[] {
  const hosts = new Set<string>()
  for (const host of [...device.addresses, device.host]) {
    const normalized = host.trim()
    if (normalized) hosts.add(normalized)
  }
  return [...hosts].sort((left, right) => addressPriority(left) - addressPriority(right))
}

function addressPriority(host: string): number {
  if (isIP(host) === 4) {
    const [first, second] = host.split(".").map(Number)
    if (first === 127) return 0
    if (first === 192 && second === 168) return 10
    if (first === 10) return 20
    if (first === 172 && second >= 16 && second <= 31) return 40
    if (first === 169 && second === 254) return 90
    return 30
  }
  if (isIP(host) === 6) return host.toLowerCase().startsWith("fe80:") ? 100 : 80
  return 30
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  return (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EADDRNOTAVAIL"
  )
}

function networkError(message: string, code: string): Error {
  const err = new Error(message) as Error & { code?: string }
  err.code = code
  return err
}

function isReachableDevice(
  device: (DiscoveredLanDevice & { online?: boolean; reachable?: boolean }) | null | undefined
): device is DiscoveredLanDevice & { online?: boolean; reachable?: boolean } {
  return Boolean(device?.port && (device.online !== false || device.reachable === true))
}

function deviceFromRemote(
  identity: PairingIdentity,
  endpointPort: number | undefined,
  req: import("node:http").IncomingMessage
): DiscoveredLanDevice | null {
  const host = normalizeRemoteAddress(req.socket.remoteAddress)
  if (
    !host ||
    typeof endpointPort !== "number" ||
    !Number.isInteger(endpointPort) ||
    endpointPort <= 0 ||
    endpointPort > 65535
  ) {
    return null
  }
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    host,
    addresses: [host],
    port: endpointPort,
    platform: "unknown",
    capabilities: ["pair", "https-chunks"],
  }
}

function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null
  if (address.startsWith("::ffff:")) return address.slice("::ffff:".length)
  return address
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) return
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(statusCode, {
    "content-length": payload.length,
    "content-type": "application/json",
  })
  res.end(payload)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
