import process from "node:process"
import { buildApp } from "./app"
import { createGitHubIdentityProvider } from "./auth/github"
import { loadConfig } from "./config"
import { createDb } from "./db/client"
import { createStorage } from "./storage/factory"

async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required")
  }
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required")
  }

  const { db } = createDb(config.DATABASE_URL)
  const github = createGitHubIdentityProvider({
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
  })

  const storage = createStorage(config)

  const app = buildApp({ db, github, storage, config, logger: true })
  await app.listen({ port: config.PORT, host: config.HOST })
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
