import type {
  Plugin,
  PluginSummary,
  PluginVersion,
  Rating,
  Report,
  Review,
  User,
} from "@synapsepkg/marketplace-types"
import type {
  PluginRow,
  PluginVersionRow,
  RatingRow,
  ReportRow,
  ReviewRow,
} from "./services/plugin-service"
import type { UserRow } from "./services/user-service"
import {
  pluginSchema,
  pluginSummarySchema,
  pluginVersionSchema,
  ratingSchema,
  reportSchema,
  reviewSchema,
  userSchema,
} from "@synapsepkg/marketplace-types"

// Map DB rows to API DTOs. Timestamps become ISO strings here; parsing through
// the marketplace-types schema guarantees the response matches the contract
// (and catches any Date→string slip-ups).

export function toUserDto(row: UserRow): User {
  return userSchema.parse({
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl ?? undefined,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  })
}

export function toPluginDto(row: PluginRow): Plugin {
  return pluginSchema.parse({
    id: row.id,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    status: row.status,
    displayName: row.displayName,
    description: row.description,
    categories: row.categories,
    homepage: row.homepage ?? undefined,
    icon: row.icon ?? undefined,
    latestVersion: row.latestVersion ?? undefined,
    stats: {
      downloads: row.downloads,
      ratingAvg: row.ratingAvg,
      ratingCount: row.ratingCount,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export function toPluginSummaryDto(row: PluginRow, ownerHandle: string): PluginSummary {
  return pluginSummarySchema.parse({
    id: row.id,
    ownerHandle,
    visibility: row.visibility,
    displayName: row.displayName,
    description: row.description,
    categories: row.categories,
    icon: row.icon ?? undefined,
    latestVersion: row.latestVersion ?? undefined,
    stats: {
      downloads: row.downloads,
      ratingAvg: row.ratingAvg,
      ratingCount: row.ratingCount,
    },
    updatedAt: row.updatedAt.toISOString(),
  })
}

export function toRatingDto(row: RatingRow): Rating {
  return ratingSchema.parse({
    pluginId: row.pluginId,
    userId: row.userId,
    stars: row.stars,
    updatedAt: row.updatedAt.toISOString(),
  })
}

export function toReportDto(row: ReportRow): Report {
  return reportSchema.parse({
    id: row.id,
    pluginId: row.pluginId,
    reporterUserId: row.reporterUserId,
    kind: row.kind,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  })
}

export function toReviewDto(row: ReviewRow): Review {
  return reviewSchema.parse({
    pluginId: row.pluginId,
    userId: row.userId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export function toPluginVersionDto(row: PluginVersionRow): PluginVersion {
  return pluginVersionSchema.parse({
    pluginId: row.pluginId,
    version: row.version,
    synapseEngine: row.synapseEngine,
    packageUrl: row.packageUrl,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    manifestSnapshot: row.manifestSnapshot,
    publishedAt: row.publishedAt.toISOString(),
    yankedAt: row.yankedAt ? row.yankedAt.toISOString() : undefined,
    yankReason: row.yankReason ?? undefined,
  })
}
