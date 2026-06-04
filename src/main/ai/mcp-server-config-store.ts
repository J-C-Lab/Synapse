import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Persists the user's external MCP server definitions as plain JSON (decision
// §11.1 — no native deps), reusing the LAN atomic-json helpers for crash-safe
// writes. These are launch instructions only; no secret material lives here
// (provider keys stay in the encrypted AiCredentialStore). `env` values are
// stored verbatim, so the UI should steer users away from putting secrets here.

export interface McpServerConfig {
  /** Stable id, also used in the `mcp:<id>/<tool>` tool namespace. */
  id: string
  /** Human-friendly label for the UI. */
  name?: string
  /** Executable to spawn for the stdio transport. */
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Disabled servers are persisted but not connected. Defaults to true. */
  enabled?: boolean
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

  constructor(private readonly filePath: string) {}

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
    this.configs = normalizeStored(await readJsonFile(this.filePath))
    return this.configs
  }

  private async persist(configs: McpServerConfig[]): Promise<void> {
    this.configs = configs
    await writeJsonFile(this.filePath, configs)
  }
}

function normalizeConfig(config: McpServerConfig): McpServerConfig {
  if (!ID_PATTERN.test(config.id ?? "")) {
    throw new McpServerConfigError(`Invalid MCP server id: ${String(config.id)}`)
  }
  if (typeof config.command !== "string" || config.command.trim().length === 0) {
    throw new McpServerConfigError(`MCP server "${config.id}" requires a command.`)
  }
  const out: McpServerConfig = {
    id: config.id,
    command: config.command.trim(),
    enabled: config.enabled !== false,
  }
  if (typeof config.name === "string" && config.name.trim().length > 0)
    out.name = config.name.trim()
  if (Array.isArray(config.args)) out.args = config.args.filter((arg) => typeof arg === "string")
  if (config.env && typeof config.env === "object" && !Array.isArray(config.env)) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value === "string") env[key] = value
    }
    if (Object.keys(env).length > 0) out.env = env
  }
  if (typeof config.cwd === "string" && config.cwd.trim().length > 0) out.cwd = config.cwd.trim()
  return out
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
