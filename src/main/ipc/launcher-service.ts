import type { AppEntry, FrequentAppEntry, SearchResult } from "../launcher/types"
import type { UserSettings } from "../settings/settings"
import { app } from "electron"
import { AppCache } from "../launcher/app-cache"
import { resolveAppIcon } from "../launcher/app-icon"
import { launchApp } from "../launcher/launch-app"
import { searchApps } from "../launcher/search"
import { logger } from "../logging"
import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
  settingsFilePath,
} from "../settings/settings"

/**
 * Glue layer between IPC and the launcher domain. Owned by main/index.ts
 * so we have a single mutable cache + settings object per process.
 */
export class LauncherService {
  readonly cache = new AppCache()
  private settings: UserSettings = { ...defaultSettings }
  private settingsPath: string | null = null

  async init(): Promise<UserSettings> {
    this.settingsPath = settingsFilePath(app.getPath("userData"))
    this.settings = await loadSettings(this.settingsPath)
    return this.settings
  }

  getSettings(): UserSettings {
    return this.settings
  }

  async updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    const next = normalizeSettings({ ...this.settings, ...patch })
    this.settings = next
    if (this.settingsPath) await saveSettings(this.settingsPath, next)
    return next
  }

  async search(query: string): Promise<SearchResult[]> {
    if (this.cache.list().length === 0) {
      await this.cache.refresh()
    }
    return searchApps(this.cache.list(), query, { limit: 30 })
  }

  async launchById(id: string): Promise<boolean> {
    const entry = this.cache.list().find((app) => app.id === id)
    if (!entry) return false
    const ok = await launchApp(entry)
    if (ok) await this.recordLaunch(id)
    return ok
  }

  refreshApps(): Promise<readonly AppEntry[]> {
    return this.cache.refresh()
  }

  async getFrequentApps(limit = 8): Promise<FrequentAppEntry[]> {
    if (this.cache.list().length === 0) {
      await this.cache.refresh()
    }
    const byId = new Map(this.cache.list().map((entry) => [entry.id, entry]))
    const rows = Object.entries(this.settings.appUsage)
      .map(([id, usage]) => {
        const entry = byId.get(id)
        return entry ? { entry, lastLaunchedAt: usage.lastLaunchedAt } : null
      })
      .filter((row): row is FrequentAppEntry => row !== null)
      .sort((a, b) => b.lastLaunchedAt - a.lastLaunchedAt)
      .slice(0, limit)

    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        iconDataUrl: await resolveAppIcon(row.entry.iconPath),
      }))
    )
  }

  /** Removes an app from the Home page's frequent-apps list without uninstalling it. */
  async removeFrequentApp(id: string): Promise<void> {
    if (!(id in this.settings.appUsage)) return
    const appUsage = { ...this.settings.appUsage }
    delete appUsage[id]
    const next: UserSettings = { ...this.settings, appUsage }
    this.settings = next
    if (this.settingsPath) {
      try {
        await saveSettings(this.settingsPath, next)
      } catch (err) {
        logger.child("launcher-service").warn("failed to persist frequent-app removal", { err })
      }
    }
  }

  private async recordLaunch(id: string): Promise<void> {
    const previous = this.settings.appUsage[id]
    const next: UserSettings = {
      ...this.settings,
      appUsage: {
        ...this.settings.appUsage,
        [id]: { lastLaunchedAt: Date.now(), launchCount: (previous?.launchCount ?? 0) + 1 },
      },
    }
    this.settings = next
    if (this.settingsPath) {
      try {
        await saveSettings(this.settingsPath, next)
      } catch (err) {
        // Usage telemetry is incidental to the launch itself — a persistence
        // failure here must never propagate out of launchById() and fail an
        // otherwise-successful launch (see launcher:launch in main/index.ts,
        // which only calls hideSearchWindow() once launchById() resolves).
        logger.child("launcher-service").warn("failed to persist app usage", { err })
      }
    }
  }
}
