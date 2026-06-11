import type { FastifyRequest, preHandlerHookHandler } from "fastify"
import type { Services } from "../services/context"
import type { UserRow } from "../services/user-service"
import { unauthorized } from "../lib/errors"

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined
}

/** Require a valid bearer token; populates `request.user` for the handler. */
export function authenticate(services: Services): preHandlerHookHandler {
  return async (request) => {
    const token = bearerToken(request)
    if (!token) throw unauthorized("Missing bearer token")

    const user = await services.sessions.resolve(token)
    if (!user) throw unauthorized("Invalid or expired token")

    request.user = user
  }
}

/** Resolve a user if a valid token is present, but never reject anonymous calls. */
export async function resolveOptionalUser(
  services: Services,
  request: FastifyRequest
): Promise<UserRow | undefined> {
  const token = bearerToken(request)
  if (!token) return undefined
  return services.sessions.resolve(token)
}
