import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Per-server token storage for the CLI. */
export interface CredentialStore {
  get: (baseUrl: string) => Promise<string | undefined>
  set: (baseUrl: string, token: string) => Promise<void>
  clear: (baseUrl: string) => Promise<void>
}

interface CredentialsFile {
  tokens: Record<string, string>
}

/**
 * File-backed token store at `~/.synapse/credentials.json` (mode 0600), keyed
 * by server base URL. No native keychain dependency — matches the project's
 * zero-native baseline; the file is user-only readable.
 */
export function fileCredentialStore(options: { dir?: string } = {}): CredentialStore {
  const dir = options.dir ?? path.join(os.homedir(), ".synapse")
  const file = path.join(dir, "credentials.json")

  async function read(): Promise<CredentialsFile> {
    try {
      const raw = await fs.readFile(file, "utf-8")
      const parsed = JSON.parse(raw) as Partial<CredentialsFile>
      return { tokens: parsed.tokens ?? {} }
    } catch {
      return { tokens: {} }
    }
  }

  async function write(data: CredentialsFile): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  return {
    async get(baseUrl) {
      return (await read()).tokens[baseUrl]
    },
    async set(baseUrl, token) {
      const data = await read()
      data.tokens[baseUrl] = token
      await write(data)
    },
    async clear(baseUrl) {
      const data = await read()
      delete data.tokens[baseUrl]
      await write(data)
    },
  }
}
