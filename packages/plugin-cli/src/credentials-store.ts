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
  options: { dir?: string; helper?: CredentialHelper } = {}
): CredentialStore {
  const dir = options.dir ?? path.join(os.homedir(), ".synapse")
  const configFile = path.join(dir, "config.json")
  const legacyFile = path.join(dir, "credentials.json")
  const helper = options.helper === undefined ? resolveCredentialHelper() : options.helper

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

  // One-time migration off the previous implementation's plaintext
  // ~/.synapse/credentials.json. Tokens it can migrate (helper available,
  // server not already present in the new config) move into the
  // helper-backed store; the plaintext file is deleted afterward no matter
  // what — leaving a stale plaintext copy of a secret (or an unparseable
  // remnant of one) on disk is exactly the vulnerability this store
  // replaces, migrated or not. This function must never reject: a rejected
  // promise here would memoize permanently (see `migration` below), turning
  // one transient failure (a locked keyring, a corrupt legacy file) into a
  // permanently broken store for the rest of the process.
  async function migrateLegacyCredentials(): Promise<void> {
    let legacyRaw: string
    try {
      legacyRaw = await fs.readFile(legacyFile, "utf-8")
    } catch {
      return // no legacy file — nothing to migrate
    }

    try {
      let legacyTokens: Record<string, string> = {}
      try {
        legacyTokens = (JSON.parse(legacyRaw) as { tokens?: Record<string, string> }).tokens ?? {}
      } catch {
        // Corrupt/unreadable JSON — nothing parseable to migrate. Still
        // falls through to the `finally` below, which deletes the file.
      }

      const config = await readConfig()
      let changed = false
      for (const [baseUrl, token] of Object.entries(legacyTokens)) {
        if (config.servers[baseUrl]) continue
        if (!helper) continue
        try {
          if (!(await helper.isAvailable())) continue
          const credentialId = credentialIdFor(baseUrl)
          await helper.store(credentialId, token)
          config.servers[baseUrl] = { credentialId }
          changed = true
        } catch {
          // This one entry couldn't be migrated (e.g. the keyring is
          // locked) — leave it out of the new config (the user re-logs-in
          // for that server) rather than aborting the rest of the
          // migration or leaving the plaintext file behind because of it.
        }
      }
      if (changed) await writeConfig(config).catch(() => {})
    } finally {
      await fs.rm(legacyFile, { force: true }).catch(() => {})
    }
  }

  let migration: Promise<void> | undefined
  function ensureMigrated(): Promise<void> {
    migration ??= migrateLegacyCredentials()
    return migration
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
      await writeConfig(config)
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
