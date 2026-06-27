import type { GrantIdentity } from "./grant-store"
import { Buffer } from "node:buffer"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

/** The subset of Electron `safeStorage` the vault needs (injectable for tests). */
export interface SafeStoragePort {
  isEncryptionAvailable: () => boolean
  encryptString: (plainText: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type CredentialType = "oauth2-pkce" | "static"

/** Decrypted payload. `static` holds a secret; `oauth2-pkce` a token set. */
export type CredentialPayload =
  | { secret: string }
  | { accessToken: string; refreshToken?: string; expiresAt?: number; grantedScopes?: string[] }

interface StoredRecord {
  identity: GrantIdentity
  type: CredentialType
  connectedAt: number
  cipher: string // base64 of safeStorage ciphertext over JSON.stringify(payload)
}

function key(pluginId: string, credentialId: string): string {
  return `${pluginId}:${credentialId}`
}

function sameIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint &&
    a.capabilityDeclarationHash === b.capabilityDeclarationHash
  )
}

/** Host-only, identity-bound, encrypted credential store. Reads fail CLOSED:
 *  identity mismatch, missing record, or a decrypt/parse error all yield
 *  `disconnected` / `undefined` and never an injectable secret (spec invariant 6). */
export class CredentialVault {
  private records: Record<string, StoredRecord> | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStoragePort,
    private readonly now: () => number = Date.now
  ) {}

  async put(
    identity: GrantIdentity,
    credentialId: string,
    type: CredentialType,
    payload: CredentialPayload
  ): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable())
      throw new Error("system secure storage is unavailable; credentials cannot be saved")
    return this.runExclusive(async () => {
      const records = await this.load()
      const cipher = this.safeStorage.encryptString(JSON.stringify(payload)).toString("base64")
      records[key(identity.pluginId, credentialId)] = {
        identity,
        type,
        connectedAt: this.now(),
        cipher,
      }
      await this.persist(records)
    })
  }

  async status(
    identity: GrantIdentity,
    credentialId: string
  ): Promise<"connected" | "disconnected"> {
    return (await this.read(identity, credentialId)) === undefined ? "disconnected" : "connected"
  }

  /** Decrypted payload, or undefined if absent / identity-mismatched / corrupt. */
  async read(
    identity: GrantIdentity,
    credentialId: string
  ): Promise<CredentialPayload | undefined> {
    const record = (await this.load())[key(identity.pluginId, credentialId)]
    if (!record || !sameIdentity(record.identity, identity)) return undefined
    try {
      const plain = this.safeStorage.decryptString(Buffer.from(record.cipher, "base64"))
      return JSON.parse(plain) as CredentialPayload
    } catch {
      return undefined // fail closed on any decrypt/parse error
    }
  }

  async delete(identity: GrantIdentity, credentialId: string): Promise<void> {
    return this.runExclusive(async () => {
      const records = await this.load()
      delete records[key(identity.pluginId, credentialId)]
      await this.persist(records)
    })
  }

  /** All decrypted oauth records (for refresh timer arming on startup). */
  async listOAuthRecords(): Promise<
    Array<{ identity: GrantIdentity; credentialId: string; payload: CredentialPayload }>
  > {
    const records = await this.load()
    const out: Array<{
      identity: GrantIdentity
      credentialId: string
      payload: CredentialPayload
    }> = []
    for (const [compound, record] of Object.entries(records)) {
      if (record.type !== "oauth2-pkce") continue
      const sep = compound.indexOf(":")
      if (sep < 0) continue
      const credentialId = compound.slice(sep + 1)
      try {
        const plain = this.safeStorage.decryptString(Buffer.from(record.cipher, "base64"))
        const payload = JSON.parse(plain) as CredentialPayload
        if (!("accessToken" in payload)) continue
        out.push({ identity: record.identity, credentialId, payload })
      } catch {
        continue
      }
    }
    return out
  }

  private async load(): Promise<Record<string, StoredRecord>> {
    if (!this.records) {
      const raw = await readJsonFile(this.filePath)
      this.records =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, StoredRecord>)
          : {}
    }
    return this.records
  }

  private async persist(records: Record<string, StoredRecord>): Promise<void> {
    this.records = records
    await writeJsonFile(this.filePath, records)
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusive.then(fn)
    this.exclusive = run.then(
      () => {},
      () => {}
    )
    return run
  }
}
