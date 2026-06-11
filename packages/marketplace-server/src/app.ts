import type { FastifyInstance } from "fastify"
import type { IdentityProvider } from "./auth/github"
import type { ServerConfig } from "./config"
import type { MarketplaceDb } from "./db/client"
import type { Services } from "./services/context"
import type { UserRow } from "./services/user-service"
import type { StorageProvider } from "./storage/types"
import multipart from "@fastify/multipart"
import rateLimit from "@fastify/rate-limit"
import Fastify from "fastify"
import { HttpError, sendError } from "./lib/errors"
import { registerAuthRoutes } from "./routes/auth"
import { registerHealthRoutes } from "./routes/health"
import { registerPluginRoutes } from "./routes/plugins"
import { registerSessionRoutes } from "./routes/session"
import { DeviceCodeService } from "./services/device-code-service"
import { PluginService } from "./services/plugin-service"
import { SessionService } from "./services/session-service"
import { UserService } from "./services/user-service"

/** Max accepted `.syn` upload size (bytes). */
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow | null
  }
}

export interface AppDeps {
  db: MarketplaceDb
  github: IdentityProvider
  storage: StorageProvider
  config: ServerConfig
  /** Injectable clock for deterministic tests (expiry, issuance). */
  now?: () => Date
  logger?: boolean
}

/**
 * Build a fully-wired Fastify instance from its dependencies. Everything the
 * app needs is injected (db, identity provider, clock), so the same factory
 * serves production and tests — tests pass a pglite db and a fake identity
 * provider, no network or real database required.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date())

  const services: Services = {
    db: deps.db,
    config: deps.config,
    github: deps.github,
    storage: deps.storage,
    users: new UserService(deps.db),
    sessions: new SessionService(deps.db, now),
    deviceCodes: new DeviceCodeService(deps.db, now),
    plugins: new PluginService(deps.db, deps.storage),
  }

  const app = Fastify({ logger: deps.logger ?? false })
  app.decorateRequest("user", null)
  // Throttle per IP before routes load, so per-route `config.rateLimit`
  // overrides (auth/publish) are honored. The plugin throws on exceed; the
  // error handler below normalizes it into the standard envelope.
  if (deps.config.RATE_LIMIT_ENABLED) {
    app.register(rateLimit, {
      global: true,
      max: deps.config.RATE_LIMIT_MAX,
      timeWindow: "1 minute",
    })
  }
  app.register(multipart, { limits: { fileSize: MAX_PACKAGE_BYTES, files: 1 } })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return sendError(reply, error)
    }
    // @fastify/rate-limit throws a 429 with its own statusCode; surface it in
    // our envelope rather than masking it as a 500.
    if ((error as { statusCode?: number }).statusCode === 429) {
      return sendError(reply, new HttpError(429, "rate_limited", "Rate limit exceeded"))
    }
    request.log.error(error)
    return sendError(reply, new HttpError(500, "internal", "Internal server error"))
  })

  // Routes load inside a child plugin so they register *after* rate-limit has
  // finished loading — only then does its onRoute hook see them and apply the
  // global + per-route limits. (Decorators, the error handler, and multipart
  // are set on the root instance above and inherited here.)
  app.register(async (instance) => {
    registerHealthRoutes(instance, services)
    registerAuthRoutes(instance, services)
    registerSessionRoutes(instance, services)
    registerPluginRoutes(instance, services)
  })

  return app
}
