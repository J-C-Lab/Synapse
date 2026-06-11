import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { z } from "zod"

// Server configuration, parsed from the environment. Secrets (DATABASE_URL,
// GitHub OAuth) are optional here so the app can be constructed in tests and
// local dev without them; the entrypoint (index.ts) requires DATABASE_URL
// before actually connecting.

/**
 * A boolean drawn from the environment. Env values arrive as strings, so this
 * accepts the usual truthy/falsy spellings (z.coerce.boolean would treat the
 * string "false" as true).
 */
const envBool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined) return defaultValue
      if (typeof value === "boolean") return value
      return value === "true" || value === "1"
    })

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  /** Public origin used to build user-facing URLs (device verification page). */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  // Cloudflare R2 (S3-compatible). When all are present, object storage uses
  // R2; otherwise the server falls back to in-memory storage (dev only).
  R2_ENDPOINT: z.string().url().optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  // Per-IP request throttling (@fastify/rate-limit). On by default; tests turn
  // it off for determinism. RATE_LIMIT_MAX is the global per-minute ceiling —
  // auth and publish routes apply their own tighter limits on top.
  RATE_LIMIT_ENABLED: envBool(true),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  // The programmatic device-approval endpoint (/auth/device/approve) bypasses
  // the browser leg; it exists for tests and non-browser flows and is OFF in
  // production, where the GitHub callback is the only way to approve a grant.
  ENABLE_DEVICE_APPROVE_ENDPOINT: envBool(false),
})

export type ServerConfig = z.infer<typeof configSchema>

export function loadDotEnvFile(
  filePath = path.join(process.cwd(), ".env"),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!existsSync(filePath)) return false
  const raw = readFileSync(filePath, "utf-8")
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    const [key, value] = parsed
    env[key] ??= value
  }
  return true
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return configSchema.parse(env)
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const separator = trimmed.indexOf("=")
  if (separator <= 0) return null
  const key = trimmed.slice(0, separator).trim()
  if (!isEnvKey(key)) return null
  return [key, unquoteEnvValue(trimmed.slice(separator + 1).trim())]
}

function isEnvKey(value: string): boolean {
  if (!value) return false
  const first = value.charCodeAt(0)
  if (!isAsciiLetter(first) && first !== 95) return false
  for (let i = 1; i < value.length; i += 1) {
    const char = value.charCodeAt(i)
    if (!isAsciiLetter(char) && !isAsciiDigit(char) && char !== 95) return false
  }
  return true
}

function isAsciiLetter(char: number): boolean {
  return (char >= 65 && char <= 90) || (char >= 97 && char <= 122)
}

function isAsciiDigit(char: number): boolean {
  return char >= 48 && char <= 57
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  return value
}
