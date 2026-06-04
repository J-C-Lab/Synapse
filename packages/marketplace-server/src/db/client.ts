import type { ExtractTablesWithRelations } from "drizzle-orm"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { Schema } from "./schema"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { schema } from "./schema"

/**
 * Driver-agnostic database handle. Services depend on this rather than a
 * concrete driver, so production (node-postgres against Neon) and tests
 * (pglite, in-process WASM Postgres) share one query surface. Concrete drivers
 * are cast to it at their factory boundary — the only place that knows the
 * driver.
 */
export type MarketplaceDb = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>

export interface DbHandle {
  db: MarketplaceDb
  close: () => Promise<void>
}

/** Production handle: a node-postgres pool. Neon speaks the standard PG wire. */
export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString })
  const db = drizzle(pool, { schema }) as unknown as MarketplaceDb
  return { db, close: () => pool.end() }
}
