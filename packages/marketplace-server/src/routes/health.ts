import type { FastifyInstance } from "fastify"
import type { Services } from "../services/context"
import { sql } from "drizzle-orm"

/** Liveness + DB connectivity probe. */
export function registerHealthRoutes(app: FastifyInstance, services: Services): void {
  app.get("/health", async () => {
    await services.db.execute(sql`select 1`)
    return { status: "ok" as const }
  })
}
