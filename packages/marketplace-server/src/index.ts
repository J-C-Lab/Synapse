import process from "node:process"
import { buildApp } from "./app"
import { createGitHubIdentityProvider } from "./auth/github"
import { loadConfig } from "./config"
import { createDb } from "./db/client"
import { InMemoryStorageProvider } from "./storage/memory"

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

  // TODO(M2-credentialed): swap in the R2 StorageProvider once R2 env is wired.
  // Until then object storage is in-process and lost on restart — dev only.
  const storage = new InMemoryStorageProvider(config.PUBLIC_BASE_URL)
  process.stderr.write(
    "warning: using in-memory object storage (dev only); configure R2 before production use\n"
  )

  const app = buildApp({ db, github, storage, config, logger: true })
  await app.listen({ port: config.PORT, host: config.HOST })
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
