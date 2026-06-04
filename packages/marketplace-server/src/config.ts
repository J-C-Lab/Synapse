import process from "node:process"
import { z } from "zod"

// Server configuration, parsed from the environment. Secrets (DATABASE_URL,
// GitHub OAuth) are optional here so the app can be constructed in tests and
// local dev without them; the entrypoint (index.ts) requires DATABASE_URL
// before actually connecting.

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  /** Public origin used to build user-facing URLs (device verification page). */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
})

export type ServerConfig = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return configSchema.parse(env)
}
