import type { preHandlerHookHandler } from "fastify"
import type { Services } from "../services/context"
import { unauthorized } from "../lib/errors"

/** Require a valid bearer token; populates `request.user` for the handler. */
export function authenticate(services: Services): preHandlerHookHandler {
  return async (request) => {
    const header = request.headers.authorization
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined
    if (!token) throw unauthorized("Missing bearer token")

    const user = await services.sessions.resolve(token)
    if (!user) throw unauthorized("Invalid or expired token")

    request.user = user
  }
}
