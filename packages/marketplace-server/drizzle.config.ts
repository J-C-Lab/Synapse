import { defineConfig } from "drizzle-kit"

// Generates SQL migrations from src/db/schema.ts into ./drizzle. No database
// connection is needed for `generate` — it diffs the schema against the
// existing migration history. Applied at runtime by src/db/migrate.ts (prod)
// and the test harness (pglite).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
})
