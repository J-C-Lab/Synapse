import { manifestSchema } from "@synapsepkg/plugin-manifest"
import { z } from "zod"
import {
  authProviderSchema,
  handleSchema,
  httpsUrlSchema,
  localizedStringSchema,
  pluginIdSchema,
  pluginStatusSchema,
  reportKindSchema,
  reportStatusSchema,
  semverSchema,
  sha256Schema,
  timestampSchema,
  userRoleSchema,
  visibilitySchema,
} from "./common"

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * A marketplace account. Identity is provider-agnostic: a `User` owns one or
 * more {@link authIdentitySchema} rows, so adding Google/email later never
 * migrates the user table.
 */
export const userSchema = z
  .object({
    id: z.string().min(1),
    handle: handleSchema,
    displayName: z.string().min(1),
    avatarUrl: httpsUrlSchema.optional(),
    role: userRoleSchema,
    createdAt: timestampSchema,
  })
  .strict()

/** A linked external identity (e.g. a GitHub login) resolving to a `User`. */
export const authIdentitySchema = z
  .object({
    userId: z.string().min(1),
    provider: authProviderSchema,
    /** The provider's stable user id (not the display login, which can change). */
    providerUserId: z.string().min(1),
    createdAt: timestampSchema,
  })
  .strict()

// ── Plugin & versions ─────────────────────────────────────────────────────────

/** Aggregate download/rating counters, denormalized onto the plugin for listing. */
export const pluginStatsSchema = z
  .object({
    downloads: z.number().int().nonnegative(),
    ratingAvg: z.number().min(0).max(5),
    ratingCount: z.number().int().nonnegative(),
  })
  .strict()

/**
 * A plugin as a logical entity, spanning all its versions. The package payload
 * and per-version metadata live in {@link pluginVersionSchema}.
 */
export const pluginSchema = z
  .object({
    id: pluginIdSchema,
    ownerUserId: z.string().min(1),
    visibility: visibilitySchema,
    status: pluginStatusSchema,
    displayName: localizedStringSchema,
    description: localizedStringSchema,
    categories: z.array(z.string().min(1)).default([]),
    homepage: httpsUrlSchema.optional(),
    icon: httpsUrlSchema.optional(),
    /** Highest published, non-yanked version; absent until the first publish. */
    latestVersion: semverSchema.optional(),
    stats: pluginStatsSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()

/**
 * An immutable published version. Versions are never mutated in place; a bad
 * release is {@link pluginVersionSchema yanked}, not deleted, so existing
 * installs stay reproducible.
 */
export const pluginVersionSchema = z
  .object({
    pluginId: pluginIdSchema,
    version: semverSchema,
    /** `engines.synapse` range the package was built against. */
    synapseEngine: z.string().min(1),
    /** Signed object-storage URL for the `.syn` package. */
    packageUrl: httpsUrlSchema,
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive(),
    /**
     * The full manifest as published — drives install-time permission/tool
     * disclosure and audit without unpacking the archive. Single source of
     * truth is the plugin manifest schema.
     */
    manifestSnapshot: manifestSchema,
    publishedAt: timestampSchema,
    /** Set when withdrawn; the row and package remain for reproducibility. */
    yankedAt: timestampSchema.optional(),
    yankReason: z.string().min(1).optional(),
  })
  .strict()

// ── Social: downloads, ratings, reviews ───────────────────────────────────────

/** A single download event — the fact table behind the download counter. */
export const downloadSchema = z
  .object({
    pluginId: pluginIdSchema,
    version: semverSchema,
    /** Absent for anonymous downloads (public plugins may not require auth). */
    userId: z.string().min(1).optional(),
    at: timestampSchema,
  })
  .strict()

/** A user's star rating (1–5) for a plugin. One row per (user, plugin). */
export const ratingSchema = z
  .object({
    pluginId: pluginIdSchema,
    userId: z.string().min(1),
    stars: z.number().int().min(1).max(5),
    updatedAt: timestampSchema,
  })
  .strict()

/** An optional free-text review attached to a user's rating of a plugin. */
export const reviewSchema = z
  .object({
    pluginId: pluginIdSchema,
    userId: z.string().min(1),
    body: z.string().min(1).max(4000),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()

/**
 * An abuse/quality report against a plugin. Filed by a user, or by the
 * automated upload scan (`kind: "auto"`, `reporterUserId` null). Moves through
 * the review state machine: open → reviewed | dismissed.
 */
export const reportSchema = z
  .object({
    id: z.string().min(1),
    pluginId: pluginIdSchema,
    reporterUserId: z.string().min(1).nullable(),
    kind: reportKindSchema,
    reason: z.string().min(1),
    status: reportStatusSchema,
    createdAt: timestampSchema,
  })
  .strict()

// ── Projections ───────────────────────────────────────────────────────────────

/**
 * The compact shape used in listings and search results — enough to render a
 * card without the full plugin record or version history.
 */
export const pluginSummarySchema = z
  .object({
    id: pluginIdSchema,
    ownerHandle: handleSchema,
    visibility: visibilitySchema,
    displayName: localizedStringSchema,
    description: localizedStringSchema,
    categories: z.array(z.string().min(1)).default([]),
    icon: httpsUrlSchema.optional(),
    latestVersion: semverSchema.optional(),
    stats: pluginStatsSchema,
    updatedAt: timestampSchema,
  })
  .strict()

export type User = z.infer<typeof userSchema>
export type AuthIdentity = z.infer<typeof authIdentitySchema>
export type PluginStats = z.infer<typeof pluginStatsSchema>
export type Plugin = z.infer<typeof pluginSchema>
export type PluginVersion = z.infer<typeof pluginVersionSchema>
export type Download = z.infer<typeof downloadSchema>
export type Rating = z.infer<typeof ratingSchema>
export type Review = z.infer<typeof reviewSchema>
export type Report = z.infer<typeof reportSchema>
export type PluginSummary = z.infer<typeof pluginSummarySchema>
