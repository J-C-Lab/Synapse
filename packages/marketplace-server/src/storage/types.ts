import type { Buffer } from "node:buffer"

/** A stored object's canonical location. */
export interface StoredObject {
  /** Public-ish URL recorded on the version row (https). */
  url: string
}

/**
 * Object storage for `.syn` packages. Production is Cloudflare R2 (S3-compatible)
 * — added in the credentialed step; tests and local dev use an in-memory
 * implementation. The API never streams package bytes long-term; it hands out
 * short-lived signed download URLs.
 */
export interface StorageProvider {
  /** Store bytes at `key`, returning the object's URL. */
  put: (key: string, body: Buffer, contentType: string) => Promise<StoredObject>
  /** A short-lived URL a client can GET to download the object. */
  signedDownloadUrl: (key: string, ttlSeconds?: number) => Promise<string>
}
