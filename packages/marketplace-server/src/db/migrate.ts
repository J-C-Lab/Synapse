import * as path from "node:path"
import process from "node:process"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

// Apply pending migrations to the configured database. Run with `db:migrate`
// (via tsx) in CI/deploy before starting the server.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required to run migrations")

  const pool = new Pool({ connectionString: url })
  const db = drizzle(pool)
  await migrate(db, { migrationsFolder: path.join(__dirname, "..", "..", "drizzle") })
  await pool.end()
}

main().then(
  () => {
    process.stdout.write("migrations applied\n")
  },
  (err: unknown) => {
    process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
)
