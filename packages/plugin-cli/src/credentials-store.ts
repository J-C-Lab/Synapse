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

  return {
    async get(baseUrl) {
      if (!helper || !(await helper.isAvailable())) return undefined
      const config = await readConfig()
      const entry = config.servers[baseUrl]
      if (!entry) return undefined
      return helper.retrieve(entry.credentialId)
    },

    async set(baseUrl, token) {
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
      const config = await readConfig()
      const entry = config.servers[baseUrl]
      if (entry && helper && (await helper.isAvailable())) {
        await helper.erase(entry.credentialId)
      }
      if (entry) {
        delete config.servers[baseUrl]
        await writeConfig(config)
      }
    },
  }
}
