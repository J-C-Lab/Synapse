import type { PluginSort, Visibility } from "@synapse/marketplace-types"
import type { PluginManifest } from "@synapse/plugin-manifest"
import type { Buffer } from "node:buffer"
import type { MarketplaceDb } from "../db/client"
import type { StorageProvider } from "../storage/types"
import { createHash } from "node:crypto"
import { and, desc, eq, ilike, or, sql } from "drizzle-orm"
import { plugins, pluginVersions, users } from "../db/schema"
import { badRequest, conflict, forbidden, notFound } from "../lib/errors"
import { compareVersions } from "../lib/semver"

export type PluginRow = typeof plugins.$inferSelect
export type PluginVersionRow = typeof pluginVersions.$inferSelect

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

    const detail = await this.getDetail(pluginId, input.ownerUserId)
    if (!detail) throw notFound(`Plugin "${pluginId}" not found after publish`)
    return detail
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

    return { ...owned, versions }
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
      case "relevance":
      default:
        return desc(plugins.updatedAt)
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
