import type { SecretProtector } from "../lan/credential-store"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Provider API keys for BYOK. Keys are encrypted at rest with the OS keychain
// (Electron safeStorage, via the shared SecretProtector) and live only in the
// main process — the renderer never receives a key, matching the security
// baseline (design §4). One file holds every provider's key.

export interface AiCredentialStoreOptions {
  filePath: string
  protector: SecretProtector
}

interface StoredKeys {
  [providerId: string]: string // encrypted
}

export function aiCredentialFilePath(userDataDir: string): string {
  return path.join(userDataDir, "ai", "credentials.json")
}

export class AiCredentialStore {
  private keys: StoredKeys | null = null

  constructor(private readonly options: AiCredentialStoreOptions) {}

  /** Whether a key is stored for the provider. Cheap; safe to expose to UI. */
  async has(providerId: string): Promise<boolean> {
    const keys = await this.load()
    return typeof keys[providerId] === "string" && keys[providerId].length > 0
  }

  /** Decrypt and return the key. Main-process only — never send the result out. */
  async get(providerId: string): Promise<string | undefined> {
    const keys = await this.load()
    const encrypted = keys[providerId]
    if (!encrypted) return undefined
    return this.options.protector.decrypt(encrypted)
  }

  async set(providerId: string, key: string): Promise<void> {
    const keys = await this.load()
    keys[providerId] = this.options.protector.encrypt(key)
    await this.persist(keys)
  }

  async delete(providerId: string): Promise<void> {
    const keys = await this.load()
    if (!(providerId in keys)) return
    delete keys[providerId]
    await this.persist(keys)
  }

  /** Provider IDs that have a stored key (no secret material leaves here). */
  async list(): Promise<string[]> {
    return Object.keys(await this.load())
  }

  private async load(): Promise<StoredKeys> {
    if (this.keys) return this.keys
    this.keys = normalizeStoredKeys(await readJsonFile(this.options.filePath))
    return this.keys
  }

  private async persist(keys: StoredKeys): Promise<void> {
    this.keys = keys
    await writeJsonFile(this.options.filePath, keys)
  }
}

function normalizeStoredKeys(value: unknown): StoredKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: StoredKeys = {}
  for (const [provider, encrypted] of Object.entries(value as Record<string, unknown>)) {
    if (typeof encrypted === "string" && encrypted.length > 0) out[provider] = encrypted
  }
  return out
}
