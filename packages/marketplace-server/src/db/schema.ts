import type {
  AuthProvider,
  LocalizedString,
  PluginStatus,
  UserRole,
  Visibility,
} from "@synapse/marketplace-types"
import type { PluginManifest } from "@synapse/plugin-manifest"
import { integer, jsonb, pgTable, primaryKey, real, text, timestamp } from "drizzle-orm/pg-core"

// Postgres schema for the marketplace. Column shapes mirror
// `@synapse/marketplace-types` so DB rows map cleanly onto the API contract.
// Timestamps are stored as `timestamptz` and surface as JS `Date`; the mapping
// layer serializes them to ISO strings at the API boundary.

const createdAt = timestamp("created_at", { withTimezone: true, mode: "date" })
  .notNull()
  .defaultNow()
const updatedAt = timestamp("updated_at", { withTimezone: true, mode: "date" })
  .notNull()
  .defaultNow()

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  role: text("role").$type<UserRole>().notNull().default("user"),
  createdAt,
})

/**
 * External identities linked to a user. Keeping this separate from `users`
 * keeps identity provider-agnostic — adding Google/email later is a new row,
 * not a user-table migration.
 */
export const authIdentities = pgTable(
  "auth_identities",
  {
    provider: text("provider").$type<AuthProvider>().notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerUserId] })]
)

/**
 * Opaque, revocable sessions. We store only a SHA-256 of the bearer token, so
 * a database leak does not expose usable credentials. (Chosen over stateless
 * JWTs for M1: revocation is a row delete, with no signing-key management.)
 */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt,
})

/** Pending CLI device-authorization grants (RFC 8628-style). */
export const deviceCodes = pgTable("device_codes", {
  deviceCode: text("device_code").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  status: text("status").$type<"pending" | "authorized" | "expired">().notNull().default("pending"),
  /** Set when a user approves the grant. */
  userId: text("user_id").references(() => users.id),
  intervalSeconds: integer("interval_seconds").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt,
})

export const plugins = pgTable("plugins", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  visibility: text("visibility").$type<Visibility>().notNull().default("private"),
  status: text("status").$type<PluginStatus>().notNull().default("active"),
  displayName: jsonb("display_name").$type<LocalizedString>().notNull(),
  description: jsonb("description").$type<LocalizedString>().notNull(),
  categories: jsonb("categories").$type<string[]>().notNull().default([]),
  homepage: text("homepage"),
  icon: text("icon"),
  latestVersion: text("latest_version"),
  downloads: integer("downloads").notNull().default(0),
  ratingAvg: real("rating_avg").notNull().default(0),
  ratingCount: integer("rating_count").notNull().default(0),
  createdAt,
  updatedAt,
})

/** Immutable published versions. A bad release is yanked, never deleted. */
export const pluginVersions = pgTable(
  "plugin_versions",
  {
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id),
    version: text("version").notNull(),
    synapseEngine: text("synapse_engine").notNull(),
    packageUrl: text("package_url").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    manifestSnapshot: jsonb("manifest_snapshot").$type<PluginManifest>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    yankedAt: timestamp("yanked_at", { withTimezone: true, mode: "date" }),
    yankReason: text("yank_reason"),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.version] })]
)

/** Append-only download events — the fact table behind the download counter. */
export const downloads = pgTable("downloads", {
  id: text("id").primaryKey(),
  pluginId: text("plugin_id")
    .notNull()
    .references(() => plugins.id),
  version: text("version").notNull(),
  userId: text("user_id").references(() => users.id),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})

export const ratings = pgTable(
  "ratings",
  {
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    stars: integer("stars").notNull(),
    updatedAt,
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.userId] })]
)

export const reviews = pgTable(
  "reviews",
  {
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.userId] })]
)

/**
 * Abuse/quality reports triaged by admins (M7 pipeline). Filed by a user, or
 * by the automated upload scan (`kind: "auto"`, `reporterUserId` null).
 */
export const reports = pgTable("reports", {
  id: text("id").primaryKey(),
  pluginId: text("plugin_id")
    .notNull()
    .references(() => plugins.id),
  reporterUserId: text("reporter_user_id").references(() => users.id),
  kind: text("kind").$type<"user" | "auto">().notNull().default("user"),
  reason: text("reason").notNull(),
  status: text("status").$type<"open" | "reviewed" | "dismissed">().notNull().default("open"),
  createdAt,
})

export const schema = {
  users,
  authIdentities,
  sessions,
  deviceCodes,
  plugins,
  pluginVersions,
  downloads,
  ratings,
  reviews,
  reports,
}

export type Schema = typeof schema
