import type { StoredLanIdentity } from "./types"
import { X509Certificate } from "node:crypto"
import * as path from "node:path"
import { generate } from "selfsigned"
import { readJsonFile, writeJsonFile } from "./atomic-json-store"

export interface LanCredential {
  certificatePem: string
  certificateFingerprint: string
  privateKeyPem: string
}

export class LanCredentialLoadError extends Error {
  constructor(cause: unknown) {
    super("Stored LAN credential could not be loaded.", { cause })
    this.name = "LanCredentialLoadError"
  }
}

export interface SecretProtector {
  encrypt: (plainText: string) => string
  decrypt: (encryptedText: string) => string
}

interface StoredCredential {
  certificatePem: string
  encryptedPrivateKey: string
}

export function lanCredentialFilePath(userDataDir: string): string {
  return path.join(userDataDir, "lan", "credentials.json")
}

export class LanCredentialStore {
  private credential: LanCredential | null = null

  constructor(
    private readonly filePath: string,
    private readonly protector: SecretProtector
  ) {}

  async loadOrCreate(identity: StoredLanIdentity): Promise<LanCredential> {
    if (this.credential) return this.credential
    const loaded = normalizeStoredCredential(await readJsonFile(this.filePath))
    this.credential = loaded ? this.decrypt(loaded) : await this.create(identity)
    return this.credential
  }

  private async create(identity: StoredLanIdentity): Promise<LanCredential> {
    const generated = generate([{ name: "commonName", value: `DesKit ${identity.deviceId}` }], {
      algorithm: "sha256",
      days: 3650,
      keySize: 2048,
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true, clientAuth: true },
      ],
    })
    const credential = {
      certificatePem: generated.cert,
      certificateFingerprint: certificateFingerprint(generated.cert),
      privateKeyPem: generated.private,
    }
    await writeJsonFile(this.filePath, {
      certificatePem: credential.certificatePem,
      encryptedPrivateKey: this.protector.encrypt(credential.privateKeyPem),
    } satisfies StoredCredential)
    return credential
  }

  private decrypt(stored: StoredCredential): LanCredential {
    try {
      return {
        certificatePem: stored.certificatePem,
        certificateFingerprint: certificateFingerprint(stored.certificatePem),
        privateKeyPem: this.protector.decrypt(stored.encryptedPrivateKey),
      }
    } catch (err) {
      throw new LanCredentialLoadError(err)
    }
  }
}

export function certificateFingerprint(certificatePem: string): string {
  return new X509Certificate(certificatePem).fingerprint256
}

function normalizeStoredCredential(value: unknown): StoredCredential | null {
  if (!value || typeof value !== "object") return null
  const stored = value as Record<string, unknown>
  if (typeof stored.certificatePem !== "string" || !stored.certificatePem.trim()) return null
  if (typeof stored.encryptedPrivateKey !== "string" || !stored.encryptedPrivateKey.trim()) {
    return null
  }
  return {
    certificatePem: stored.certificatePem,
    encryptedPrivateKey: stored.encryptedPrivateKey,
  }
}
