import type { FastifyInstance } from "fastify"
import type { ExternalProfile, IdentityProvider } from "../auth/github"
import type { MarketplaceDb } from "../db/client"
import * as path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import { buildApp } from "../app"
import { loadConfig } from "../config"
import { schema } from "../db/schema"
import { InMemoryStorageProvider } from "../storage/memory"

/**
 * A scriptable identity provider for tests — no GitHub, no network. Set the
 * profile the next `exchangeCodeForProfile` should return.
 */
export class FakeIdentityProvider implements IdentityProvider {
  private profile: ExternalProfile = {
    providerUserId: "gh-1",
    handle: "octocat",
    displayName: "The Octocat",
  }

  setProfile(profile: ExternalProfile): void {
    this.profile = profile
  }

  async exchangeCodeForProfile(_code: string): Promise<ExternalProfile> {
    return this.profile
  }
}

const TABLES = [
  "users",
  "auth_identities",
  "sessions",
  "device_codes",
  "plugins",
  "plugin_versions",
  "downloads",
  "ratings",
  "reviews",
]

export interface TestHarness {
  app: FastifyInstance
  db: MarketplaceDb
  github: FakeIdentityProvider
  storage: InMemoryStorageProvider
  /** Truncate all tables so a single pglite instance can be reused per test. */
  reset: () => Promise<void>
  close: () => Promise<void>
}

/**
 * Spin up a fully-wired app backed by in-process pglite (WASM Postgres) with
 * migrations applied. Mirrors production assembly; only the driver and the
 * identity provider differ.
 *
 * pglite's WASM init is CPU-heavy, so a suite should create ONE harness
 * (`beforeAll`) and call {@link TestHarness.reset} between tests rather than
 * re-instantiating — this keeps the broader test run from starving wall-clock
 * timers in sibling workers.
 */
export async function createTestHarness(options: { now?: () => Date } = {}): Promise<TestHarness> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: path.join(__dirname, "..", "..", "drizzle") })

  const github = new FakeIdentityProvider()
  const storage = new InMemoryStorageProvider()
  const config = loadConfig({ PUBLIC_BASE_URL: "https://market.test" } as NodeJS.ProcessEnv)
  const marketplaceDb = db as unknown as MarketplaceDb
  const app = buildApp({ db: marketplaceDb, github, storage, config, now: options.now })
  await app.ready()

  return {
    app,
    db: marketplaceDb,
    github,
    storage,
    reset: async () => {
      await client.exec(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE;`)
    },
    close: async () => {
      await app.close()
      await client.close()
    },
  }
}
