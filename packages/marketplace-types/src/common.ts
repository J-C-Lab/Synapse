import { z } from "zod"

// Shared primitive schemas for the marketplace domain. Kept in one place so the
// server, CLI, desktop app, and web portal validate identifiers the same way.

/**
 * Reverse-domain plugin id (e.g. `com.author.foo`). Matches the plugin manifest
 * `id` rule so a published plugin's marketplace id == its manifest id.
 */
export const pluginIdSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/)

/** A user's public handle (URL-safe, lowercase). */
export const handleSchema = z
  .string()
  .min(2)
  .max(39)
  .regex(/^[a-z0-9][a-z0-9-]*$/)

/** Semantic version, same shape the plugin CLI emits for `<id>-<version>.syn`. */
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Z.-]+)?$/i)

/** Lowercase hex SHA-256 — the package integrity digest verified before install. */
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

/** ISO-8601 timestamp string (UTC). Transport-friendly; DBs store as timestamptz. */
export const timestampSchema = z.iso.datetime()

/** An https URL — the marketplace never serves plugin payloads over plaintext.
 *  Also rejects shell metacharacters (`|;` and backtick/newline) as defense
 *  in depth: a `verificationUri`-shaped value flows into an OS "open in
 *  browser" call downstream (plugin-cli's `openBrowser`), and this schema is
 *  the first gate a malicious/compromised server's response passes through.
 *  `&` is deliberately NOT in this set — it's the standard query-parameter
 *  separator (`URLSearchParams.toString()` joins with it), and any real
 *  multi-param url — including GitHub's own OAuth authorize url — has one.
 *  Rejecting it broke device-code login outright (every /auth/device/start
 *  response failed schema validation). */
export const httpsUrlSchema = z
  .string()
  .url()
  .startsWith("https://")
  .refine((url) => !/[|;`\n\r]/.test(url), {
    message: "url must not contain shell metacharacters",
  })

/**
 * A localized, human-facing string: either a single string or a locale→string
 * map (e.g. `{ en: "...", "zh-CN": "..." }`). Mirrors the plugin manifest's
 * `LocalizedString` so display fields round-trip unchanged.
 */
export const localizedStringSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.string().min(1)),
])

/** Plugin visibility — the core private/public boundary of the marketplace. */
export const visibilitySchema = z.enum(["private", "public"])

/** Account role. `developer` is granted after a first publish; `admin` governs. */
export const userRoleSchema = z.enum(["user", "developer", "admin"])

/** Identity provider. GitHub at launch; the model stays provider-agnostic. */
export const authProviderSchema = z.enum(["github"])

/**
 * Lifecycle status of a plugin (the logical entity, across versions).
 * `removed` is a tombstone — rows are never hard-deleted so installs stay
 * reproducible and audits hold.
 */
export const pluginStatusSchema = z.enum(["active", "deprecated", "unlisted", "removed"])

/** Sort order for marketplace listings. */
export const pluginSortSchema = z.enum(["relevance", "downloads", "rating", "recent"])

/** Who/what filed a report: a `user` or the automated upload scan. */
export const reportKindSchema = z.enum(["user", "auto"])

/** Moderation state of a report (the review state machine). */
export const reportStatusSchema = z.enum(["open", "reviewed", "dismissed"])

export type Visibility = z.infer<typeof visibilitySchema>
export type UserRole = z.infer<typeof userRoleSchema>
export type AuthProvider = z.infer<typeof authProviderSchema>
export type PluginStatus = z.infer<typeof pluginStatusSchema>
export type PluginSort = z.infer<typeof pluginSortSchema>
export type ReportKind = z.infer<typeof reportKindSchema>
export type ReportStatus = z.infer<typeof reportStatusSchema>
export type LocalizedString = z.infer<typeof localizedStringSchema>
