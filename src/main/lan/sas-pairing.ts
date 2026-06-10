import type { Buffer } from "node:buffer"
import type { KeyObject } from "node:crypto"
import type { LanPairing, LanPairingDirection, TrustedLanDevice } from "./types"
import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto"

const PAIRING_TTL_MS = 5 * 60 * 1000

export interface PairingIdentity {
  deviceId: string
  name: string
  certificatePem: string
  certificateFingerprint: string
}

export interface PairingCommitment {
  commitment: string
  endpointPort?: number
  identity: PairingIdentity
}

export interface PresenceAnnouncement {
  endpointPort: number
  identity: PairingIdentity
}

export interface PairingChallenge {
  id: string
  responderIdentity: PairingIdentity
  responderPublicKey: string
  responderNonce: string
}

export interface PairingReveal {
  initiatorPublicKey: string
  initiatorNonce: string
}

interface PairingSession extends LanPairing {
  peerIdentity: PairingIdentity
}

interface PendingIncoming {
  id: string
  createdAt: number
  commitment: string
  peerIdentity: PairingIdentity
  responderKey: KeyObject
  responderPublicKey: string
  responderNonce: string
}

export interface OutgoingPairingDraft {
  commitment: PairingCommitment
  complete: (challenge: PairingChallenge) => { pairing: LanPairing; reveal: PairingReveal }
}

export interface OutgoingPairingDraftOptions {
  endpointPort?: number
}

export class SasPairingManager {
  private readonly sessions = new Map<string, PairingSession>()
  private readonly incoming = new Map<string, PendingIncoming>()

  constructor(
    private readonly localIdentity: PairingIdentity,
    private readonly now = Date.now
  ) {}

  createOutgoingDraft(options: OutgoingPairingDraftOptions = {}): OutgoingPairingDraft {
    const { privateKey, publicKey } = generateX25519KeyPair()
    const initiatorPublicKey = exportPublicKey(publicKey)
    const initiatorNonce = randomBytes(32).toString("base64")
    return {
      commitment: {
        identity: this.localIdentity,
        commitment: pairingCommitment(initiatorPublicKey, initiatorNonce),
        endpointPort: options.endpointPort,
      },
      complete: (challenge) => {
        const sas = deriveSas({
          initiatorPublicKey,
          initiatorNonce,
          responderPublicKey: challenge.responderPublicKey,
          responderNonce: challenge.responderNonce,
          initiatorFingerprint: this.localIdentity.certificateFingerprint,
          responderFingerprint: challenge.responderIdentity.certificateFingerprint,
          sharedSecret: diffieHellman({
            privateKey,
            publicKey: importPublicKey(challenge.responderPublicKey),
          }),
        })
        const pairing = this.saveSession(challenge.id, "outgoing", challenge.responderIdentity, sas)
        return {
          pairing,
          reveal: { initiatorPublicKey, initiatorNonce },
        }
      },
    }
  }

  acceptIncomingCommitment(value: PairingCommitment): PairingChallenge {
    this.prune()
    const id = randomUUID()
    const { privateKey, publicKey } = generateX25519KeyPair()
    const pending: PendingIncoming = {
      id,
      createdAt: this.now(),
      commitment: value.commitment,
      peerIdentity: value.identity,
      responderKey: privateKey,
      responderPublicKey: exportPublicKey(publicKey),
      responderNonce: randomBytes(32).toString("base64"),
    }
    this.incoming.set(id, pending)
    return {
      id,
      responderIdentity: this.localIdentity,
      responderPublicKey: pending.responderPublicKey,
      responderNonce: pending.responderNonce,
    }
  }

  acceptIncomingReveal(id: string, reveal: PairingReveal): LanPairing {
    this.prune()
    const pending = this.incoming.get(id)
    if (!pending) throw new Error("Pairing request expired or was not found.")
    if (
      pairingCommitment(reveal.initiatorPublicKey, reveal.initiatorNonce) !== pending.commitment
    ) {
      throw new Error("Pairing commitment does not match reveal.")
    }
    const pairing = this.saveSession(
      pending.id,
      "incoming",
      pending.peerIdentity,
      deriveSas({
        ...reveal,
        responderPublicKey: pending.responderPublicKey,
        responderNonce: pending.responderNonce,
        initiatorFingerprint: pending.peerIdentity.certificateFingerprint,
        responderFingerprint: this.localIdentity.certificateFingerprint,
        sharedSecret: diffieHellman({
          privateKey: pending.responderKey,
          publicKey: importPublicKey(reveal.initiatorPublicKey),
        }),
      })
    )
    this.incoming.delete(id)
    return pairing
  }

  list(): LanPairing[] {
    this.prune()
    return [...this.sessions.values()].map(toPublicPairing)
  }

  get(id: string): LanPairing | null {
    const session = this.sessions.get(id)
    return session ? toPublicPairing(session) : null
  }

  peerFingerprint(id: string): string {
    return this.requireAwaiting(id).peerIdentity.certificateFingerprint
  }

  prepareOutgoingConfirmation(id: string, sas: string): TrustedLanDevice {
    const session = this.requireAwaiting(id, "outgoing")
    if (session.sas !== sas) throw new Error("Security code is incorrect.")
    return this.toTrustedDevice(session)
  }

  prepareIncomingConfirmation(id: string): TrustedLanDevice {
    return this.toTrustedDevice(this.requireAwaiting(id, "incoming"))
  }

  markConfirmed(id: string, direction: LanPairingDirection): void {
    this.requireAwaiting(id, direction).state = "confirmed"
  }

  reject(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.state !== "awaiting-confirmation") return
    session.state = "rejected"
  }

  private saveSession(
    id: string,
    direction: LanPairingDirection,
    peerIdentity: PairingIdentity,
    sas: string
  ): LanPairing {
    const session: PairingSession = {
      id,
      direction,
      deviceId: peerIdentity.deviceId,
      deviceName: peerIdentity.name,
      peerIdentity,
      sas,
      state: "awaiting-confirmation",
      createdAt: this.now(),
    }
    this.sessions.set(id, session)
    return toPublicPairing(session)
  }

  private requireAwaiting(id: string, direction?: LanPairingDirection): PairingSession {
    const session = this.sessions.get(id)
    if (
      !session ||
      session.state !== "awaiting-confirmation" ||
      (direction && session.direction !== direction)
    ) {
      throw new Error("Pairing request is no longer awaiting confirmation.")
    }
    return session
  }

  private toTrustedDevice(session: PairingSession): TrustedLanDevice {
    return {
      ...session.peerIdentity,
      pairedAt: this.now(),
    }
  }

  private prune(): void {
    const expiresBefore = this.now() - PAIRING_TTL_MS
    for (const [id, pending] of this.incoming) {
      if (pending.createdAt < expiresBefore) this.incoming.delete(id)
    }
    for (const [id, session] of this.sessions) {
      if (session.createdAt < expiresBefore && session.state === "awaiting-confirmation") {
        this.sessions.delete(id)
      }
    }
  }
}

export function pairingCommitment(publicKey: string, nonce: string): string {
  return createHash("sha256").update(`${publicKey}\n${nonce}`).digest("hex")
}

interface SasInput extends PairingReveal {
  responderPublicKey: string
  responderNonce: string
  initiatorFingerprint: string
  responderFingerprint: string
  sharedSecret: Buffer
}

export function deriveSas(input: SasInput): string {
  const transcript = [
    "synapse-lan-pairing-v1",
    input.initiatorPublicKey,
    input.initiatorNonce,
    input.responderPublicKey,
    input.responderNonce,
    input.initiatorFingerprint,
    input.responderFingerprint,
  ].join("\n")
  const value = createHmac("sha256", input.sharedSecret).update(transcript).digest().readUInt32BE(0)
  return String(value % 1_000_000).padStart(6, "0")
}

function generateX25519KeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("x25519")
}

function exportPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ format: "pem", type: "spki" }).toString()
}

function importPublicKey(publicKey: string): KeyObject {
  return createPublicKey(publicKey)
}

function toPublicPairing(session: PairingSession): LanPairing {
  return {
    id: session.id,
    direction: session.direction,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    sas: session.sas,
    state: session.state,
    createdAt: session.createdAt,
  }
}
