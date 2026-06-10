import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Buffer } from "node:buffer"
import type { Services } from "../services/context"
import {
  createReviewRequestSchema,
  listReviewsResponseSchema,
  myPluginsResponseSchema,
  paginationQuerySchema,
  pluginDetailResponseSchema,
  publishRequestSchema,
  publishResponseSchema,
  rateRequestSchema,
  rateResponseSchema,
  resolveDownloadResponseSchema,
  searchPluginsQuerySchema,
  searchPluginsResponseSchema,
} from "@synapse/marketplace-types"
import { badRequest, notFound, unauthorized } from "../lib/errors"
import { parseBody } from "../lib/http"
import {
  toPluginDto,
  toPluginSummaryDto,
  toPluginVersionDto,
  toRatingDto,
  toReviewDto,
} from "../mappers"
import { authenticate, resolveOptionalUser } from "./middleware"

interface MultipartUpload {
  metadata: unknown
  packageBytes: Buffer
}

/** Read the `metadata` JSON field and the `package` file part from a request. */
async function readPublishUpload(request: FastifyRequest): Promise<MultipartUpload> {
  if (!request.isMultipart()) {
    throw badRequest("Publish must be a multipart/form-data request")
  }

  let metadata: unknown
  let packageBytes: Buffer | undefined

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname === "package") {
        packageBytes = await part.toBuffer()
      } else {
        await part.toBuffer() // drain unexpected files
      }
    } else if (part.fieldname === "metadata") {
      try {
        metadata = JSON.parse(String(part.value))
      } catch {
        throw badRequest("metadata field is not valid JSON")
      }
    }
  }

  if (metadata === undefined) throw badRequest("Missing metadata field")
  if (!packageBytes) throw badRequest("Missing package file")
  return { metadata, packageBytes }
}

function parseSearchQuery(query: Record<string, unknown>): {
  q?: string
  category?: string
  sort: "relevance" | "downloads" | "rating" | "recent"
  page: number
  perPage: number
} {
  return searchPluginsQuerySchema.parse({
    q: query.q,
    category: query.category,
    sort: query.sort,
    page: query.page === undefined ? undefined : Number(query.page),
    perPage: query.perPage === undefined ? undefined : Number(query.perPage),
  })
}

export function registerPluginRoutes(app: FastifyInstance, services: Services): void {
  // Publish a new version (auth + multipart: `metadata` JSON + `package` file).
  app.post("/plugins", { preHandler: authenticate(services) }, async (request, reply) => {
    if (!request.user) throw unauthorized("Not authenticated")
    const upload = await readPublishUpload(request)
    const meta = parseBody(publishRequestSchema, upload.metadata)

    const detail = await services.plugins.publish({
      ownerUserId: request.user.id,
      manifest: meta.manifest,
      sha256: meta.sha256,
      sizeBytes: meta.sizeBytes,
      packageBytes: upload.packageBytes,
      visibility: meta.visibility,
    })

    const published = detail.versions.find((v) => v.version === meta.manifest.version)
    if (!published) throw notFound("Published version not found")
    return reply.status(201).send(
      publishResponseSchema.parse({
        plugin: toPluginDto(detail.plugin),
        version: toPluginVersionDto(published),
      })
    )
  })

  // Public catalog search.
  app.get("/plugins", async (request, reply) => {
    const params = parseSearchQuery(request.query as Record<string, unknown>)
    const result = await services.plugins.search(params)
    return reply.send(
      searchPluginsResponseSchema.parse({
        items: result.items.map((row) => toPluginSummaryDto(row.plugin, row.ownerHandle)),
        page: result.page,
        perPage: result.perPage,
        total: result.total,
      })
    )
  })

  // The caller's own plugins (any visibility).
  app.get("/plugins/mine", { preHandler: authenticate(services) }, async (request, reply) => {
    if (!request.user) throw unauthorized("Not authenticated")
    const owned = await services.plugins.listByOwner(request.user.id)
    return reply.send(
      myPluginsResponseSchema.parse({
        items: owned.map((row) => toPluginSummaryDto(row.plugin, row.ownerHandle)),
      })
    )
  })

  // Full plugin detail (private plugins visible only to their owner).
  app.get("/plugins/:id", async (request, reply) => {
    const { id } = request.params as { id: string }
    const viewer = await resolveOptionalUser(services, request)
    const detail = await services.plugins.getDetail(id, viewer?.id)
    if (!detail) throw notFound(`Plugin "${id}" not found`)
    return reply.send(
      pluginDetailResponseSchema.parse({
        plugin: toPluginDto(detail.plugin),
        ownerHandle: detail.ownerHandle,
        versions: detail.versions.map(toPluginVersionDto),
        myRating: detail.myRating ? toRatingDto(detail.myRating) : undefined,
      })
    )
  })

  // Resolve a signed download URL for a specific version (counts a download).
  app.get("/plugins/:id/versions/:version/download", async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string }
    const viewer = await resolveOptionalUser(services, request)
    const resolved = await services.plugins.resolveDownload(id, version, viewer?.id)
    return reply.send(
      resolveDownloadResponseSchema.parse({
        version: resolved.version,
        downloadUrl: resolved.downloadUrl,
        sha256: resolved.sha256,
        expiresAt: resolved.expiresAt.toISOString(),
      })
    )
  })

  // Upsert the caller's star rating; returns the rating + refreshed aggregate.
  app.put("/plugins/:id/rating", { preHandler: authenticate(services) }, async (request, reply) => {
    if (!request.user) throw unauthorized("Not authenticated")
    const { id } = request.params as { id: string }
    const body = parseBody(rateRequestSchema, request.body)
    const result = await services.plugins.rate(id, request.user.id, body.stars)
    return reply.send(
      rateResponseSchema.parse({ rating: toRatingDto(result.rating), stats: result.stats })
    )
  })

  // Paginated reviews for a plugin.
  app.get("/plugins/:id/reviews", async (request, reply) => {
    const { id } = request.params as { id: string }
    const viewer = await resolveOptionalUser(services, request)
    const query = paginationQuerySchema.parse({
      page: queryNumber((request.query as Record<string, unknown>).page),
      perPage: queryNumber((request.query as Record<string, unknown>).perPage),
    })
    const result = await services.plugins.listReviews(id, query.page, query.perPage, viewer?.id)
    return reply.send(
      listReviewsResponseSchema.parse({
        items: result.items.map(toReviewDto),
        page: result.page,
        perPage: result.perPage,
        total: result.total,
      })
    )
  })

  // Upsert the caller's free-text review.
  app.post(
    "/plugins/:id/reviews",
    { preHandler: authenticate(services) },
    async (request, reply) => {
      if (!request.user) throw unauthorized("Not authenticated")
      const { id } = request.params as { id: string }
      const body = parseBody(createReviewRequestSchema, request.body)
      const review = await services.plugins.upsertReview(id, request.user.id, body.body)
      return reply.status(201).send(toReviewDto(review))
    }
  )
}

function queryNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value)
}
