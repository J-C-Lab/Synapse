import type { FastifyInstance } from "fastify"
import type { Services } from "../services/context"
import {
  deviceCodePollRequestSchema,
  deviceCodePollResponseSchema,
  deviceCodeStartResponseSchema,
} from "@synapse/marketplace-types"
import { z } from "zod"
import { parseBody } from "../lib/http"
import { toUserDto } from "../mappers"

const approveBodySchema = z
  .object({
    userCode: z.string().min(1),
    /** GitHub OAuth authorization code from the browser leg. */
    code: z.string().min(1),
  })
  .strict()

/** CLI device-authorization flow (RFC 8628-style) + browser approval. */
export function registerAuthRoutes(app: FastifyInstance, services: Services): void {
  // The CLI starts a grant and shows the user code + verification URL.
  app.post("/auth/device/start", async (_request, reply) => {
    const grant = await services.deviceCodes.start()
    return reply.send(
      deviceCodeStartResponseSchema.parse({
        deviceCode: grant.deviceCode,
        userCode: grant.userCode,
        verificationUri: new URL("/device", services.config.PUBLIC_BASE_URL).toString(),
        interval: grant.interval,
        expiresAt: grant.expiresAt.toISOString(),
      })
    )
  })

  // The browser leg: resolve the GitHub identity and approve the grant.
  app.post("/auth/device/approve", async (request, reply) => {
    const body = parseBody(approveBodySchema, request.body)
    const profile = await services.github.exchangeCodeForProfile(body.code)
    const user = await services.users.upsertFromIdentity({ provider: "github", ...profile })
    await services.deviceCodes.approve(body.userCode, user.id)
    return reply.send({ status: "ok" as const })
  })

  // The CLI polls until the grant is approved, then receives a session token.
  app.post("/auth/device/poll", async (request, reply) => {
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
  })
}
