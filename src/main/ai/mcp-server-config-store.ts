import type { SecretProtector } from "../lan/credential-store"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Persists the user's external MCP server definitions as JSON (decision §11.1 —
// no native deps), reusing the LAN atomic-json helpers for crash-safe writes.
// Launch instructions (command/args/cwd/url) are stored verbatim; secret-bearing
// fields (env values and request headers) are encrypted at rest with the OS
// keychain via a SecretProtector and decrypted on read, so no plaintext tokens
// sit on disk. Legacy plaintext values (written before encryption) are tolerated
// and re-encrypted the next time the server is saved.

export type McpTransport = "stdio" | "http"

export interface McpServerConfig {
  /** Stable id, also used in the `mcp:<id>/<tool>` tool namespace. */
  id: string
  /** Human-friendly label for the UI. */
  name?: string
  /** How to reach the server. Defaults to "stdio" for back-compat. */
  transport?: McpTransport
  /** stdio: executable to spawn. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** http: Streamable HTTP endpoint (SSE is used as a fallback). */
  url?: string
  /** http: extra request headers (e.g. Authorization). Stored verbatim. */
  headers?: Record<string, string>
  /** Disabled servers are persisted but not connected. Defaults to true. */
  enabled?: boolean
  /** Execution root ids (WorkspaceRoot.id, from the agentShellRoots setting —
   *  NOT WorkspaceStore ids) to advertise as MCP roots to this server.
   *  Omitted/empty = no roots capability advertised (the default). */
  exposedExecutionRootIds?: string[]
}

export function aiMcpServersFilePath(userDataDir: string): string {
  return path.join(userDataDir, "ai", "mcp-servers.json")
}

const ID_PATTERN = /^[\w-]{1,64}$/

export class McpServerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpServerConfigError"
  }
}

export class McpServerConfigStore {
  private configs: McpServerConfig[] | null = null

  constructor(
    private readonly filePath: string,
    private readonly protector?: SecretProtector
  ) {}

  async list(): Promise<McpServerConfig[]> {
    return [...(await this.load())]
  }

  /** Create or replace a server config by id, validating its shape. */
  async save(config: McpServerConfig): Promise<McpServerConfig> {
    const normalized = normalizeConfig(config)
    const configs = await this.load()
    const next = configs.filter((existing) => existing.id !== normalized.id)
    next.push(normalized)
    await this.persist(next)
    return normalized
  }

  async delete(id: string): Promise<void> {
    const configs = await this.load()
    const next = configs.filter((existing) => existing.id !== id)
    if (next.length === configs.length) return
    await this.persist(next)
  }

  private async load(): Promise<McpServerConfig[]> {
    if (this.configs) return this.configs
    const stored = normalizeStored(await readJsonFile(this.filePath))
    this.configs = stored.map((config) => this.decryptSecrets(config))
    return this.configs
  }

  private async persist(configs: McpServerConfig[]): Promise<void> {
    // Cache the decrypted view; write ciphertext to disk.
    this.configs = configs
    await writeJsonFile(
      this.filePath,
      configs.map((config) => this.encryptSecrets(config))
    )
  }

  private encryptSecrets(config: McpServerConfig): McpServerConfig {
    if (!this.protector) return config
    return this.mapSecrets(config, (value) => this.protector!.encrypt(value))
  }

  private decryptSecrets(config: McpServerConfig): McpServerConfig {
    if (!this.protector) return config
    return this.mapSecrets(config, (value) => {
      try {
        return this.protector!.decrypt(value)
      } catch {
        // Legacy plaintext (pre-encryption) — keep as-is; re-encrypted on save.
        return value
      }
    })
  }

  private mapSecrets(
    config: McpServerConfig,
    transform: (value: string) => string
  ): McpServerConfig {
    const out: McpServerConfig = { ...config }
    if (config.env) out.env = mapValues(config.env, transform)
    if (config.headers) out.headers = mapValues(config.headers, transform)
    return out
  }
}

function mapValues(
  record: Record<string, string>,
  transform: (value: string) => string
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) out[key] = transform(value)
  return out
}

function normalizeConfig(config: McpServerConfig): McpServerConfig {
  if (!ID_PATTERN.test(config.id ?? "")) {
    throw new McpServerConfigError(`Invalid MCP server id: ${String(config.id)}`)
  }
  const transport: McpTransport = config.transport === "http" ? "http" : "stdio"
  const out: McpServerConfig = {
    id: config.id,
    transport,
    enabled: config.enabled !== false,
  }
  if (typeof config.name === "string" && config.name.trim().length > 0)
    out.name = config.name.trim()

  const exposedExecutionRootIds = stringArray(config.exposedExecutionRootIds)
  if (exposedExecutionRootIds) out.exposedExecutionRootIds = exposedExecutionRootIds

  if (transport === "http") {
    if (typeof config.url !== "string" || !isHttpUrl(config.url.trim())) {
      throw new McpServerConfigError(`MCP server "${config.id}" requires an http(s) url.`)
    }
    out.url = config.url.trim()
    const headers = stringRecord(config.headers)
    if (headers) out.headers = headers
    return out
  }

  if (typeof config.command !== "string" || config.command.trim().length === 0) {
    throw new McpServerConfigError(`MCP server "${config.id}" requires a command.`)
  }
  out.command = config.command.trim()
  if (Array.isArray(config.args)) out.args = config.args.filter((arg) => typeof arg === "string")
  const env = stringRecord(config.env)
  if (env) out.env = env
  if (typeof config.cwd === "string" && config.cwd.trim().length > 0) out.cwd = config.cwd.trim()
  return out
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  )
  return out.length > 0 ? out : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeStored(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return []
  const out: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    try {
      const config = normalizeConfig(entry as McpServerConfig)
      if (seen.has(config.id)) continue
      seen.add(config.id)
      out.push(config)
    } catch {
      // Skip malformed persisted entries rather than failing the whole load.
    }
  }
  return out
}
