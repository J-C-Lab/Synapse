import type { Buffer } from "node:buffer"
import type { StorageProvider, StoredObject } from "./types"

/**
 * In-memory object storage for tests and local dev. NOT for production — bytes
 * live only in the process. Returns synthetic https URLs so version rows and
 * the API contract validate the same as they would against R2.
 */
export class InMemoryStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>()

  constructor(private readonly baseUrl = "https://storage.local") {}

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    this.objects.set(key, { body, contentType })
    return { url: this.urlFor(key) }
  }

  async signedDownloadUrl(key: string, ttlSeconds = 300): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds
    return `${this.urlFor(key)}?expires=${expires}`
  }

  /** Test helper: read back stored bytes. */
  get(key: string): Buffer | undefined {
    return this.objects.get(key)?.body
  }

  private urlFor(key: string): string {
    return `${this.baseUrl}/${key}`
  }
}
