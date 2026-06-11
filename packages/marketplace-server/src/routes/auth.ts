import type { FastifyInstance } from "fastify"
import type { Services } from "../services/context"
import {
  deviceCodePollRequestSchema,
  deviceCodePollResponseSchema,
  deviceCodeStartResponseSchema,
} from "@synapsepkg/marketplace-types"
import { z } from "zod"
import { githubAuthorizeUrl } from "../auth/github"
import { parseBody } from "../lib/http"
import { toUserDto } from "../mappers"

const approveBodySchema = z
  .object({
    userCode: z.string().min(1),
    /** GitHub OAuth authorization code from the browser leg. */
    code: z.string().min(1),
  })
  .strict()

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  /** The device grant's user code, round-tripped through OAuth `state`. */
  state: z.string().min(1),
})

function htmlPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h1>${title}</h1><p>${body}</p></body>`
}

/** CLI device-authorization flow (RFC 8628-style) + GitHub browser leg. */
export function registerAuthRoutes(app: FastifyInstance, services: Services): void {
  // The CLI starts a grant; the verification URL is the GitHub authorize URL
  // with the user code carried in `state`, so opening it completes the grant.
  app.post(
    "/auth/device/start",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const grant = await services.deviceCodes.start()
      const verificationUri = githubAuthorizeUrl({
        clientId: services.config.GITHUB_CLIENT_ID ?? "",
        redirectUri: new URL("/auth/github/callback", services.config.PUBLIC_BASE_URL).toString(),
        state: grant.userCode,
      })
      return reply.send(
        deviceCodeStartResponseSchema.parse({
          deviceCode: grant.deviceCode,
          userCode: grant.userCode,
          verificationUri,
          interval: grant.interval,
          expiresAt: grant.expiresAt.toISOString(),
        })
      )
    }
  )

  // GitHub redirects here after the user authorizes; resolve the identity and
  // approve the pending device grant identified by `state`.
  app.get("/auth/github/callback", async (request, reply) => {
    const parsed = callbackQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .status(400)
        .type("text/html")
        .send(htmlPage("Sign-in failed", "Missing authorization code."))
    }
    const profile = await services.github.exchangeCodeForProfile(parsed.data.code)
    const user = await services.users.upsertFromIdentity({ provider: "github", ...profile })
    await services.deviceCodes.approve(parsed.data.state, user.id)
    return reply.type("text/html").send(htmlPage("Signed in", "You can return to your terminal."))
  })

  // Programmatic approval that skips the browser leg. Registered only when
  // explicitly enabled (tests / non-browser flows); in production the GitHub
  // callback above is the sole approval path, so this surface is not exposed.
  if (services.config.ENABLE_DEVICE_APPROVE_ENDPOINT) {
    app.post(
      "/auth/device/approve",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const body = parseBody(approveBodySchema, request.body)
        const profile = await services.github.exchangeCodeForProfile(body.code)
        const user = await services.users.upsertFromIdentity({ provider: "github", ...profile })
        await services.deviceCodes.approve(body.userCode, user.id)
        return reply.send({ status: "ok" as const })
      }
    )
  }

  // The CLI polls until the grant is approved, then receives a session token.
  // Real clients poll every `interval` (5s) for up to 15 min, so the ceiling is
  // generous relative to the global default.
  app.post(
    "/auth/device/poll",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = parseBody(deviceCodePollRequestSchema, request.body)
      const result = await services.deviceCodes.poll(body.deviceCode)
      if (result.status === "pending") {
        return reply.send(deviceCodePollResponseSchema.parse({ status: "pending" }))
      }

      const session = await services.sessions.issue(result.user.id)
      return reply.send(
        deviceCodePollResponseSchema.parse({
          status: "authorized",
          accessToken: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: toUserDto(result.user),
        })
      )
    }
  )
}
