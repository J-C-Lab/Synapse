import type { SecretProtector } from "../lan/credential-store"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// The marketplace session token, encrypted at rest with the OS keychain
// (Electron safeStorage, via the shared SecretProtector) and held only in the
// main process — the renderer never receives the token, matching the security
// baseline used for AI provider keys.

export interface MarketplaceTokenStoreOptions {
  filePath: string
  protector: SecretProtector
}

export function marketplaceTokenFilePath(userDataDir: string): string {
  return path.join(userDataDir, "marketplace", "session.json")
}

export class MarketplaceTokenStore {
  // undefined = not loaded yet; null = loaded, no token.
  private token: string | null | undefined

  constructor(private readonly options: MarketplaceTokenStoreOptions) {}

  async get(): Promise<string | undefined> {
    if (this.token === undefined) this.token = await this.load()
    return this.token ?? undefined
  }

  async set(token: string): Promise<void> {
    this.token = token
    await writeJsonFile(this.options.filePath, { token: this.options.protector.encrypt(token) })
  }

  async clear(): Promise<void> {
    this.token = null
    await writeJsonFile(this.options.filePath, {})
  }

  private async load(): Promise<string | null> {
    const raw = await readJsonFile(this.options.filePath)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const encrypted = (raw as { token?: unknown }).token
    if (typeof encrypted !== "string" || encrypted.length === 0) return null
    try {
      return this.options.protector.decrypt(encrypted)
    } catch {
      return null
    }
  }
}
