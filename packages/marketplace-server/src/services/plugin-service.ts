import type { PluginSort, Visibility } from "@synapsepkg/marketplace-types"
import type { PluginManifest } from "@synapsepkg/plugin-manifest"
import type { Buffer } from "node:buffer"
import type { MarketplaceDb } from "../db/client"
import type { StorageProvider } from "../storage/types"
import { createHash } from "node:crypto"
import { and, avg, count, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm"
import { downloads, plugins, pluginVersions, ratings, reports, reviews, users } from "../db/schema"
import { newId } from "../lib/crypto"
import { badRequest, conflict, forbidden, notFound } from "../lib/errors"
import { assessManifestRisk } from "../lib/risk"
import { compareVersions } from "../lib/semver"

/** A download by the same user inside this window does not re-count. */
const DOWNLOAD_DEDUP_WINDOW_MS = 60 * 60 * 1000

export type PluginRow = typeof plugins.$inferSelect
export type PluginVersionRow = typeof pluginVersions.$inferSelect
export type RatingRow = typeof ratings.$inferSelect
export type ReviewRow = typeof reviews.$inferSelect
export type ReportRow = typeof reports.$inferSelect

export interface PluginStats {
  downloads: number
  ratingAvg: number
  ratingCount: number
}

export interface ReviewPage {
  items: ReviewRow[]
  page: number
  perPage: number
  total: number
}

export interface PublishInput {
  ownerUserId: string
  manifest: PluginManifest
  sha256: string
  sizeBytes: number
  packageBytes: Buffer
  visibility: Visibility
}

export interface PluginWithOwner {
  plugin: PluginRow
  ownerHandle: string
}

export interface PluginDetail extends PluginWithOwner {
  versions: PluginVersionRow[]
  /** The viewer's own rating, when authenticated and present. */
  myRating?: RatingRow
}

export interface SearchParams {
  q?: string
  category?: string
  sort: PluginSort
  page: number
  perPage: number
}

export interface SearchResult {
  items: PluginWithOwner[]
  page: number
  perPage: number
  total: number
}

export class PluginService {
  constructor(
    private readonly db: MarketplaceDb,
    private readonly storage: StorageProvider
  ) {}

  /**
   * Publish a new version. Verifies ownership, that the version is new and
   * strictly greater than the current latest, and that the uploaded bytes match
   * the declared digest/size; uploads to storage, records an immutable version,
   * and upserts the plugin (promoting the publisher to `developer`).
   */
  async publish(input: PublishInput): Promise<PluginDetail> {
    const pluginId = input.manifest.id
    const version = input.manifest.version

    this.verifyPayload(input)

    const existing = await this.getPluginRow(pluginId)
    if (existing && existing.ownerUserId !== input.ownerUserId) {
      throw forbidden(`You do not own plugin "${pluginId}"`)
    }
    if (existing) {
      if (await this.versionExists(pluginId, version)) {
        throw conflict(`Version ${version} of "${pluginId}" already exists`)
      }
      if (existing.latestVersion && compareVersions(version, existing.latestVersion) <= 0) {
        throw conflict(
          `Version ${version} must be greater than the current latest ${existing.latestVersion}`
        )
      }
    }

    const key = `plugins/${pluginId}/${version}/${pluginId}-${version}.syn`
    const stored = await this.storage.put(key, input.packageBytes, "application/zip")

    // Upsert the plugin first so the version row's FK is satisfied.
    if (existing) {
      await this.db
        .update(plugins)
        .set({
          visibility: input.visibility,
          displayName: input.manifest.displayName,
          description: input.manifest.description,
          latestVersion: version,
          updatedAt: new Date(),
        })
        .where(eq(plugins.id, pluginId))
    } else {
      await this.db.insert(plugins).values({
        id: pluginId,
        ownerUserId: input.ownerUserId,
        visibility: input.visibility,
        status: "active",
        displayName: input.manifest.displayName,
        description: input.manifest.description,
        latestVersion: version,
      })
    }

    await this.db.insert(pluginVersions).values({
      pluginId,
      version,
      synapseEngine: input.manifest.engines.synapse,
      packageUrl: stored.url,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      manifestSnapshot: input.manifest,
    })

    await this.db
      .update(users)
      .set({ role: "developer" })
      .where(and(eq(users.id, input.ownerUserId), eq(users.role, "user")))

    await this.autoFlag(pluginId, input.manifest)

    const detail = await this.getDetail(pluginId, input.ownerUserId)
    if (!detail) throw notFound(`Plugin "${pluginId}" not found after publish`)
    return detail
  }

  /** Upload scan: flag a high-risk publish into the admin queue (deduped). */
  private async autoFlag(pluginId: string, manifest: PublishInput["manifest"]): Promise<void> {
    const risk = assessManifestRisk(manifest)
    if (risk.level !== "high") return
    const open = await this.db
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(eq(reports.pluginId, pluginId), eq(reports.kind, "auto"), eq(reports.status, "open"))
      )
      .limit(1)
    if (open.length > 0) return
    await this.db.insert(reports).values({
      id: newId(),
      pluginId,
      reporterUserId: null,
      kind: "auto",
      reason: `Automated scan: ${risk.reasons.join("; ")}`,
    })
  }

  /** Public catalog search. Only public, active plugins are returned. */
  async search(params: SearchParams): Promise<SearchResult> {
    const filters = [eq(plugins.visibility, "public"), eq(plugins.status, "active")]
    if (params.q) {
      const like = `%${params.q}%`
      const match = or(ilike(plugins.id, like), sql`${plugins.displayName}::text ILIKE ${like}`)
      if (match) filters.push(match)
    }
    if (params.category) {
      filters.push(sql`${plugins.categories} ? ${params.category}`)
    }
    const where = and(...filters)

    const totalRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(plugins)
      .where(where)
    const total = totalRows[0]?.count ?? 0

    const rows = await this.db
      .select({ plugin: plugins, ownerHandle: users.handle })
      .from(plugins)
      .innerJoin(users, eq(users.id, plugins.ownerUserId))
      .where(where)
      .orderBy(this.orderFor(params.sort))
      .limit(params.perPage)
      .offset((params.page - 1) * params.perPage)

    return {
      items: rows.map((row) => ({ plugin: row.plugin, ownerHandle: row.ownerHandle })),
      page: params.page,
      perPage: params.perPage,
      total,
    }
  }

  /** Plugins owned by a user, any visibility. */
  async listByOwner(ownerUserId: string): Promise<PluginWithOwner[]> {
    const rows = await this.db
      .select({ plugin: plugins, ownerHandle: users.handle })
      .from(plugins)
      .innerJoin(users, eq(users.id, plugins.ownerUserId))
      .where(eq(plugins.ownerUserId, ownerUserId))
      .orderBy(desc(plugins.updatedAt))
    return rows.map((row) => ({ plugin: row.plugin, ownerHandle: row.ownerHandle }))
  }

  /**
   * Full plugin view with versions. Private plugins are visible only to their
   * owner; to others they 404 (existence is not leaked).
   */
  async getDetail(pluginId: string, viewerUserId?: string): Promise<PluginDetail | undefined> {
    const owned = await this.getPluginWithOwner(pluginId)
    if (!owned) return undefined
    if (!this.canView(owned.plugin, viewerUserId)) return undefined

    const versions = await this.db
      .select()
      .from(pluginVersions)
      .where(eq(pluginVersions.pluginId, pluginId))
      .orderBy(desc(pluginVersions.publishedAt))

    const myRating = viewerUserId ? await this.getRating(pluginId, viewerUserId) : undefined
    return { ...owned, versions, myRating }
  }

  /** Resolve a download: a short-lived signed URL plus the digest to verify. */
  async resolveDownload(
    pluginId: string,
    version: string,
    viewerUserId?: string
  ): Promise<{ version: string; downloadUrl: string; sha256: string; expiresAt: Date }> {
    const owned = await this.getPluginWithOwner(pluginId)
    if (!owned || !this.canView(owned.plugin, viewerUserId)) {
      throw notFound(`Plugin "${pluginId}" not found`)
    }

    const rows = await this.db
      .select()
      .from(pluginVersions)
      .where(and(eq(pluginVersions.pluginId, pluginId), eq(pluginVersions.version, version)))
      .limit(1)
    const row = rows[0]
    if (!row || row.yankedAt) throw notFound(`Version ${version} of "${pluginId}" is not available`)

    await this.recordDownload(pluginId, version, viewerUserId)

    const ttlSeconds = 300
    const key = `plugins/${pluginId}/${version}/${pluginId}-${version}.syn`
    const downloadUrl = await this.storage.signedDownloadUrl(key, ttlSeconds)
    return {
      version,
      downloadUrl,
      sha256: row.sha256,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    }
  }

  /**
   * Record a download event and bump the denormalized counter. An authenticated
   * user re-downloading the same plugin within {@link DOWNLOAD_DEDUP_WINDOW_MS}
   * does not re-count (basic anti-inflation; stronger abuse controls are M7).
   */
  private async recordDownload(pluginId: string, version: string, userId?: string): Promise<void> {
    const now = new Date()
    let counts = true
    if (userId) {
      const cutoff = new Date(now.getTime() - DOWNLOAD_DEDUP_WINDOW_MS)
      const recent = await this.db
        .select({ at: downloads.at })
        .from(downloads)
        .where(
          and(
            eq(downloads.pluginId, pluginId),
            eq(downloads.userId, userId),
            gt(downloads.at, cutoff)
          )
        )
        .limit(1)
      counts = recent.length === 0
    }

    await this.db
      .insert(downloads)
      .values({ id: newId(), pluginId, version, userId: userId ?? null, at: now })
    if (counts) {
      await this.db
        .update(plugins)
        .set({ downloads: sql`${plugins.downloads} + 1` })
        .where(eq(plugins.id, pluginId))
    }
  }

  /** Upsert the caller's 1–5 star rating and recompute the plugin's aggregate. */
  async rate(
    pluginId: string,
    userId: string,
    stars: number
  ): Promise<{ rating: RatingRow; stats: PluginStats }> {
    const owned = await this.getPluginWithOwner(pluginId)
    if (!owned || !this.canView(owned.plugin, userId)) {
      throw notFound(`Plugin "${pluginId}" not found`)
    }

    const now = new Date()
    await this.db
      .insert(ratings)
      .values({ pluginId, userId, stars, updatedAt: now })
      .onConflictDoUpdate({
        target: [ratings.pluginId, ratings.userId],
        set: { stars, updatedAt: now },
      })

    const agg = await this.db
      .select({ avgStars: avg(ratings.stars), total: count() })
      .from(ratings)
      .where(eq(ratings.pluginId, pluginId))
    const ratingAvg = Number(agg[0]?.avgStars ?? 0)
    const ratingCount = Number(agg[0]?.total ?? 0)

    await this.db
      .update(plugins)
      .set({ ratingAvg, ratingCount, updatedAt: now })
      .where(eq(plugins.id, pluginId))

    const rating = await this.getRating(pluginId, userId)
    return {
      rating: rating!,
      stats: { downloads: owned.plugin.downloads, ratingAvg, ratingCount },
    }
  }

  /** Upsert the caller's free-text review. */
  async upsertReview(pluginId: string, userId: string, body: string): Promise<ReviewRow> {
    const owned = await this.getPluginWithOwner(pluginId)
    if (!owned || !this.canView(owned.plugin, userId)) {
      throw notFound(`Plugin "${pluginId}" not found`)
    }
    const now = new Date()
    await this.db
      .insert(reviews)
      .values({ pluginId, userId, body, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [reviews.pluginId, reviews.userId],
        set: { body, updatedAt: now },
      })
    const rows = await this.db
      .select()
      .from(reviews)
      .where(and(eq(reviews.pluginId, pluginId), eq(reviews.userId, userId)))
      .limit(1)
    return rows[0]!
  }

  /** Paginated reviews, newest first. */
  async listReviews(
    pluginId: string,
    page: number,
    perPage: number,
    viewerUserId?: string
  ): Promise<ReviewPage> {
    const owned = await this.getPluginWithOwner(pluginId)
    if (!owned || !this.canView(owned.plugin, viewerUserId)) {
      throw notFound(`Plugin "${pluginId}" not found`)
    }
    const totalRows = await this.db
      .select({ total: count() })
      .from(reviews)
      .where(eq(reviews.pluginId, pluginId))
    const total = Number(totalRows[0]?.total ?? 0)
    const items = await this.db
      .select()
      .from(reviews)
      .where(eq(reviews.pluginId, pluginId))
      .orderBy(desc(reviews.updatedAt))
      .limit(perPage)
      .offset((page - 1) * perPage)
    return { items, page, perPage, total }
  }

  /** Owner toggles a plugin between public and private. */
  async setVisibility(
    pluginId: string,
    ownerUserId: string,
    visibility: Visibility
  ): Promise<void> {
    await this.requireOwned(pluginId, ownerUserId)
    await this.db
      .update(plugins)
      .set({ visibility, updatedAt: new Date() })
      .where(eq(plugins.id, pluginId))
  }

  /**
   * Owner withdraws a version (marks it yanked, never deletes — installs stay
   * reproducible). `latestVersion` is recomputed from the remaining non-yanked
   * versions.
   */
  async yankVersion(
    pluginId: string,
    ownerUserId: string,
    version: string,
    reason?: string
  ): Promise<void> {
    await this.requireOwned(pluginId, ownerUserId)
    const existing = await this.db
      .select({ version: pluginVersions.version })
      .from(pluginVersions)
      .where(and(eq(pluginVersions.pluginId, pluginId), eq(pluginVersions.version, version)))
      .limit(1)
    if (existing.length === 0) {
      throw notFound(`Version ${version} of "${pluginId}" not found`)
    }

    await this.db
      .update(pluginVersions)
      .set({ yankedAt: new Date(), yankReason: reason ?? null })
      .where(and(eq(pluginVersions.pluginId, pluginId), eq(pluginVersions.version, version)))

    const active = await this.db
      .select({ version: pluginVersions.version })
      .from(pluginVersions)
      .where(and(eq(pluginVersions.pluginId, pluginId), isNull(pluginVersions.yankedAt)))
    const latest = active.map((row) => row.version).sort((a, b) => compareVersions(b, a))[0]
    await this.db
      .update(plugins)
      .set({ latestVersion: latest ?? null, updatedAt: new Date() })
      .where(eq(plugins.id, pluginId))
  }

  /** File an abuse/quality report against a viewable plugin. */
  async report(pluginId: string, reporterUserId: string, reason: string): Promise<void> {
    const owned = await this.getPluginWithOwner(pluginId)
    if (!owned || !this.canView(owned.plugin, reporterUserId)) {
      throw notFound(`Plugin "${pluginId}" not found`)
    }
    await this.db.insert(reports).values({ id: newId(), pluginId, reporterUserId, reason })
  }

  /** Admin takedown — tombstones the plugin (hidden everywhere, not deleted). */
  async adminRemove(pluginId: string, role: string): Promise<void> {
    if (role !== "admin") throw forbidden("Admin role required")
    const plugin = await this.getPluginRow(pluginId)
    if (!plugin) throw notFound(`Plugin "${pluginId}" not found`)
    await this.db
      .update(plugins)
      .set({ status: "removed", updatedAt: new Date() })
      .where(eq(plugins.id, pluginId))
  }

  /** Admin restore — undo a takedown (back to active). */
  async adminRestore(pluginId: string, role: string): Promise<void> {
    if (role !== "admin") throw forbidden("Admin role required")
    const plugin = await this.getPluginRow(pluginId)
    if (!plugin) throw notFound(`Plugin "${pluginId}" not found`)
    await this.db
      .update(plugins)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(plugins.id, pluginId))
  }

  /** The admin review queue, by report status (newest first). */
  async listReports(
    role: string,
    status: "open" | "reviewed" | "dismissed" = "open"
  ): Promise<ReportRow[]> {
    if (role !== "admin") throw forbidden("Admin role required")
    return this.db
      .select()
      .from(reports)
      .where(eq(reports.status, status))
      .orderBy(desc(reports.createdAt))
  }

  /** Resolve a report — mark it actioned or dismissed. */
  async resolveReport(
    role: string,
    reportId: string,
    status: "reviewed" | "dismissed"
  ): Promise<void> {
    if (role !== "admin") throw forbidden("Admin role required")
    const updated = await this.db
      .update(reports)
      .set({ status })
      .where(eq(reports.id, reportId))
      .returning({ id: reports.id })
    if (updated.length === 0) throw notFound("Report not found")
  }

  private async requireOwned(pluginId: string, ownerUserId: string): Promise<PluginRow> {
    const plugin = await this.getPluginRow(pluginId)
    if (!plugin) throw notFound(`Plugin "${pluginId}" not found`)
    if (plugin.ownerUserId !== ownerUserId) throw forbidden(`You do not own plugin "${pluginId}"`)
    return plugin
  }

  private async getRating(pluginId: string, userId: string): Promise<RatingRow | undefined> {
    const rows = await this.db
      .select()
      .from(ratings)
      .where(and(eq(ratings.pluginId, pluginId), eq(ratings.userId, userId)))
      .limit(1)
    return rows[0]
  }

  private verifyPayload(input: PublishInput): void {
    if (input.packageBytes.byteLength !== input.sizeBytes) {
      throw badRequest(
        `Declared size ${input.sizeBytes} does not match uploaded ${input.packageBytes.byteLength}`
      )
    }
    const digest = createHash("sha256").update(input.packageBytes).digest("hex")
    if (digest !== input.sha256) {
      throw badRequest("Uploaded package digest does not match the declared sha256")
    }
  }

  private canView(plugin: PluginRow, viewerUserId?: string): boolean {
    if (plugin.status === "removed") return false
    if (plugin.visibility === "public") return true
    return Boolean(viewerUserId && viewerUserId === plugin.ownerUserId)
  }

  private orderFor(sort: PluginSort): ReturnType<typeof desc> {
    switch (sort) {
      case "downloads":
        return desc(plugins.downloads)
      case "rating":
        return desc(plugins.ratingAvg)
      case "recent":
        return desc(plugins.updatedAt)
      case "relevance":
      default:
        // A simple popularity score: average rating weighted by how many people
        // rated, plus a log-damped download count. Keeps a single 5-star plugin
        // from outranking a widely-installed, well-reviewed one.
        return desc(
          sql`${plugins.ratingAvg} * ln(${plugins.ratingCount} + 1) + ln(${plugins.downloads} + 1)`
        )
    }
  }

  private async getPluginRow(pluginId: string): Promise<PluginRow | undefined> {
    const rows = await this.db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1)
    return rows[0]
  }

  private async getPluginWithOwner(pluginId: string): Promise<PluginWithOwner | undefined> {
    const rows = await this.db
      .select({ plugin: plugins, ownerHandle: users.handle })
      .from(plugins)
      .innerJoin(users, eq(users.id, plugins.ownerUserId))
      .where(eq(plugins.id, pluginId))
      .limit(1)
    const row = rows[0]
    return row ? { plugin: row.plugin, ownerHandle: row.ownerHandle } : undefined
  }

  private async versionExists(pluginId: string, version: string): Promise<boolean> {
    const rows = await this.db
      .select({ version: pluginVersions.version })
      .from(pluginVersions)
      .where(and(eq(pluginVersions.pluginId, pluginId), eq(pluginVersions.version, version)))
      .limit(1)
    return rows.length > 0
  }
}
