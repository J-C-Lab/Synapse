import type { ServerConfig } from "../config"
import type { StorageProvider } from "./types"
import process from "node:process"
import { InMemoryStorageProvider } from "./memory"
import { R2StorageProvider } from "./r2"

/**
 * Pick the storage backend from config: R2 when fully configured, otherwise an
 * in-memory fallback for local dev (with a warning — bytes are lost on restart).
 */
export function createStorage(config: ServerConfig): StorageProvider {
  if (
    config.R2_ENDPOINT &&
    config.R2_BUCKET &&
    config.R2_ACCESS_KEY_ID &&
    config.R2_SECRET_ACCESS_KEY
  ) {
    return new R2StorageProvider({
      endpoint: config.R2_ENDPOINT,
      bucket: config.R2_BUCKET,
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    })
  }

  process.stderr.write(
    "warning: R2 not configured; using in-memory object storage (dev only, lost on restart)\n"
  )
  return new InMemoryStorageProvider(config.PUBLIC_BASE_URL)
}
