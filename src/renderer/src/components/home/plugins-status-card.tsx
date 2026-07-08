import type { MarketplaceSummary, PluginRegistryEntry } from "@/lib/electron"
import { Puzzle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { localize } from "@/components/plugins/view-utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isElectron, listPlugins, searchMarketplace } from "@/lib/electron"
import { hasUpdate } from "@/lib/plugin-version"

interface UpdateRow {
  id: string
  name: string
  from: string
  to: string
}

interface TrendingRow {
  id: string
  name: string
  downloads: number
}

const TRENDING_LIMIT = 5

export function PluginsStatusCard() {
  const { t, i18n } = useTranslation()
  const [loading, setLoading] = useState(() => isElectron())
  const [updates, setUpdates] = useState<UpdateRow[]>([])
  const [trending, setTrending] = useState<TrendingRow[]>([])
  const [tab, setTab] = useState<"updates" | "trending">("updates")
  const autoSelectedRef = useRef(false)

  useEffect(() => {
    if (!isElectron()) return
    void Promise.all([listPlugins(), searchMarketplace()]).then(([installed, search]) => {
      setUpdates(computeUpdates(installed, search.items, i18n.language))
      setTrending(computeTrending(search.items, i18n.language))
      setLoading(false)
    })
  }, [i18n.language])

  useEffect(() => {
    if (autoSelectedRef.current || loading) return
    autoSelectedRef.current = true
    setTab(updates.length > 0 ? "updates" : "trending")
  }, [loading, updates])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Puzzle className="size-4 text-primary" aria-hidden />
          {t("home.plugins.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(value as "updates" | "trending")}>
            <TabsList>
              <TabsTrigger value="updates">{t("home.plugins.updatesTab")}</TabsTrigger>
              <TabsTrigger value="trending">{t("home.plugins.trendingTab")}</TabsTrigger>
            </TabsList>
            <TabsContent value="updates" className="mt-3 flex flex-col gap-2">
              {updates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("home.plugins.updatesEmpty")}</p>
              ) : (
                updates.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between rounded-md bg-accent/50 px-2 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("home.plugins.updateLine", { from: row.from, to: row.to })}
                    </span>
                  </div>
                ))
              )}
            </TabsContent>
            <TabsContent value="trending" className="mt-3 flex flex-col gap-2">
              {trending.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("home.plugins.trendingEmpty")}</p>
              ) : (
                trending.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between rounded-md bg-accent/50 px-2 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {t("home.plugins.downloadsLine", { count: row.downloads })}
                    </span>
                  </div>
                ))
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  )
}

// Limitation: searchMarketplace() with no query only returns the backend's
// default result page, so an installed plugin outside that page won't be
// checked for updates. Acceptable for a v1 status card; a dedicated
// "check these specific plugin ids" endpoint would remove this gap.
function computeUpdates(
  installed: PluginRegistryEntry[],
  marketplace: MarketplaceSummary[],
  locale: string
): UpdateRow[] {
  const byId = new Map(marketplace.map((entry) => [entry.id, entry]))
  const rows: UpdateRow[] = []
  for (const plugin of installed) {
    if (!plugin.manifest) continue
    const match = byId.get(plugin.manifest.id)
    if (match?.latestVersion && hasUpdate(plugin.manifest.version, match.latestVersion)) {
      rows.push({
        id: plugin.manifest.id,
        name: localize(plugin.manifest.displayName, locale),
        from: plugin.manifest.version,
        to: match.latestVersion,
      })
    }
  }
  return rows
}

function computeTrending(marketplace: MarketplaceSummary[], locale: string): TrendingRow[] {
  return [...marketplace]
    .sort((a, b) => b.stats.downloads - a.stats.downloads)
    .slice(0, TRENDING_LIMIT)
    .map((entry) => ({
      id: entry.id,
      name: localize(entry.displayName, locale),
      downloads: entry.stats.downloads,
    }))
}
