import type { FastifyInstance } from "fastify"
import type { Services } from "../services/context"
import { sessionResponseSchema } from "@synapse/marketplace-types"
import { unauthorized } from "../lib/errors"
import { toUserDto } from "../mappers"
import { authenticate } from "./middleware"

/** The authenticated caller — backs `whoami`. */
export function registerSessionRoutes(app: FastifyInstance, services: Services): void {
  app.get("/session", { preHandler: authenticate(services) }, async (request, reply) => {
    if (!request.user) throw unauthorized("Not authenticated")
    return reply.send(sessionResponseSchema.parse({ user: toUserDto(request.user) }))
  })
}
