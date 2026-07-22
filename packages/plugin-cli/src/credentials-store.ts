import type { CredentialHelper } from "./credential-helper/types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { resolveCredentialHelper } from "./credential-helper"

/** Per-server token storage for the CLI. */
export interface CredentialStore {
  get: (baseUrl: string) => Promise<string | undefined>
  set: (baseUrl: string, token: string) => Promise<void>
  clear: (baseUrl: string) => Promise<void>
}

interface ConfigFile {
  servers: Record<string, { credentialId: string }>
}

/**
 * Metadata-only store at `~/.synapse/config.json`, keyed by server base URL —
 * it records which credential-helper entry holds a server's token, never the
 * token itself. The actual secret lives in whatever the OS already provides
 * (macOS Keychain / Windows DPAPI / Linux Secret Service) via a
 * `CredentialHelper` (see ./credential-helper). When no helper is available
 * on this platform (or its underlying tool isn't installed), `set()` fails
 * closed with a clear error rather than ever falling back to a plaintext
 * file — that was the previous implementation's actual vulnerability
 * (`credentials.json`'s `mode: 0o600` doesn't mean anything on Windows).
 */
export function fileCredentialStore(
  options: {
    dir?: string
    helper?: CredentialHelper
    /** Test-only seam for injecting a legacy-file-deletion failure. */
    deleteLegacyFile?: (filePath: string) => Promise<void>
  } = {}
): CredentialStore {
  const dir = options.dir ?? path.join(os.homedir(), ".synapse")
  const configFile = path.join(dir, "config.json")
  const legacyFile = path.join(dir, "credentials.json")
  const helper = options.helper === undefined ? resolveCredentialHelper() : options.helper
  const deleteFile = options.deleteLegacyFile ?? ((filePath: string) => fs.rm(filePath))

  function credentialIdFor(baseUrl: string): string {
    return `synapse-cli:${baseUrl}`
  }

  async function readConfig(): Promise<ConfigFile> {
    try {
      const raw = await fs.readFile(configFile, "utf-8")
      const parsed = JSON.parse(raw) as Partial<ConfigFile>
      return { servers: parsed.servers ?? {} }
    } catch {
      return { servers: {} }
    }
  }

  async function writeConfig(data: ConfigFile): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(configFile, JSON.stringify(data, null, 2))
  }

  // One-time migration of tokens off the previous implementation's
  // plaintext ~/.synapse/credentials.json into the helper-backed store.
  // Must never reject: a rejected promise here would memoize permanently
  // (see `tokenMigration` below), turning one transient failure (a locked
  // keyring, a corrupt legacy file) into a permanently broken store for the
  // rest of the process.
  async function migrateLegacyTokens(): Promise<void> {
    let legacyRaw: string
    try {
      legacyRaw = await fs.readFile(legacyFile, "utf-8")
    } catch {
      return // no legacy file — nothing to migrate
    }

    let legacyTokens: Record<string, string> = {}
    try {
      legacyTokens = (JSON.parse(legacyRaw) as { tokens?: Record<string, string> }).tokens ?? {}
    } catch {
      return // corrupt/unreadable JSON — nothing parseable to migrate
    }

    const config = await readConfig()
    const storedThisRun: string[] = []
    for (const [baseUrl, token] of Object.entries(legacyTokens)) {
      if (config.servers[baseUrl]) continue
      if (!helper) continue
      try {
        if (!(await helper.isAvailable())) continue
        const credentialId = credentialIdFor(baseUrl)
        await helper.store(credentialId, token)
        config.servers[baseUrl] = { credentialId }
        storedThisRun.push(credentialId)
      } catch {
        // This one entry couldn't be migrated (e.g. the keyring is
        // locked) — leave it out of the new config (the user re-logs-in
        // for that server) rather than aborting the rest of the
        // migration or leaving the plaintext file behind because of it.
      }
    }

    if (storedThisRun.length > 0) {
      try {
        await writeConfig(config)
      } catch {
        // The metadata write is what makes each credentialId reachable at
        // all. If it fails, none of the tokens stored this run were ever
        // recorded, so roll them all back rather than leaving them
        // orphaned in the Keychain/DPAPI/Secret Service forever.
        for (const credentialId of storedThisRun) {
          await helper?.erase(credentialId).catch(() => {})
        }
      }
    }
  }

  // Deletion of the legacy plaintext file is retried on every access (not
  // just once) — leaving a stale plaintext copy of a secret on disk is
  // exactly the vulnerability this store replaces, so a transient failure
  // (permission denied, a lock held by another process) must not be
  // silently accepted as "done"; it must keep getting retried until it
  // actually succeeds. `force`-style ENOENT suppression is handled
  // explicitly so a real failure is distinguishable from "already gone".
  async function tryDeleteLegacyFile(): Promise<void> {
    // ENOENT means it's already gone — nothing to do. Anything else is a
    // real failure, deliberately not treated as success: this function
    // still doesn't throw (a stuck legacy file must never break ordinary
    // get/set/clear), but `ensureMigrated()` calls this on every access, so
    // a transient failure keeps getting retried rather than being
    // memoized as a final outcome.
    await deleteFile(legacyFile).catch(() => {})
  }

  let tokenMigration: Promise<void> | undefined
  function ensureMigrated(): Promise<void> {
    tokenMigration ??= migrateLegacyTokens()
    return tokenMigration.then(() => tryDeleteLegacyFile())
  }

  return {
    async get(baseUrl) {
      await ensureMigrated()
      if (!helper || !(await helper.isAvailable())) return undefined
      const config = await readConfig()
      const entry = config.servers[baseUrl]
      if (!entry) return undefined
      return helper.retrieve(entry.credentialId)
    },

    async set(baseUrl, token) {
      await ensureMigrated()
      if (!helper || !(await helper.isAvailable())) {
        throw new Error(
          "No system credential helper is available on this platform (or its underlying tool " +
            "isn't installed), so persistent login can't be stored securely. Use the " +
            "SYNAPSE_TOKEN environment variable or --token-stdin instead."
        )
      }
      const credentialId = credentialIdFor(baseUrl)
      await helper.store(credentialId, token)
      const config = await readConfig()
      config.servers[baseUrl] = { credentialId }
      try {
        await writeConfig(config)
      } catch (err) {
        // The metadata write is what makes this credentialId reachable at
        // all — if it fails, the secret we just stored would otherwise sit
        // in the Keychain/DPAPI/Secret Service forever with nothing ever
        // able to reference or erase it again.
        await helper.erase(credentialId).catch(() => {})
        throw err
      }
    },

    async clear(baseUrl) {
      await ensureMigrated()
      const config = await readConfig()
      const entry = config.servers[baseUrl]
      if (!entry) return
      if (!helper || !(await helper.isAvailable())) {
        // Deleting the metadata entry here would orphan the secret still
        // sitting in the Keychain/DPAPI/Secret Service — nothing could ever
        // erase it afterward, since this credentialId mapping would be gone.
        // Fail closed instead: report the logout as unsuccessful.
        throw new Error(
          "No system credential helper is available on this platform (or its underlying tool " +
            "isn't installed), so the stored login can't be erased right now. Try again once " +
            "the credential helper is available."
        )
      }
      await helper.erase(entry.credentialId)
      delete config.servers[baseUrl]
      await writeConfig(config)
    },
  }
}
