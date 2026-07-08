import type { NavId } from "../app-shell"
import type { MarketplaceSummary, PluginRegistryEntry } from "@/lib/electron"
import { Puzzle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { localize } from "@/components/plugins/view-utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isElectron, listPlugins, searchMarketplace } from "@/lib/electron"
import { hasUpdate } from "@/lib/plugin-version"

interface UpdateRow {
  id: string
  name: string
  from: string
  to: string
  description: string
}

interface TrendingRow {
  id: string
  name: string
  downloads: number
  description: string
  ownerHandle: string
}

const TRENDING_LIMIT = 10

export function PluginsStatusCard({ onNavigate }: { onNavigate: (id: NavId) => void }) {
  const { t, i18n } = useTranslation()
  const [loading, setLoading] = useState(() => isElectron())
  const [updates, setUpdates] = useState<UpdateRow[]>([])
  const [trending, setTrending] = useState<TrendingRow[]>([])
  const [tab, setTab] = useState<"updates" | "trending">("updates")
  const [openUpdate, setOpenUpdate] = useState<UpdateRow | null>(null)
  const [openTrending, setOpenTrending] = useState<TrendingRow | null>(null)
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
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Puzzle className="size-4 text-primary" aria-hidden />
          {t("home.plugins.title")}
        </CardTitle>
        {!loading && (
          <Tabs value={tab} onValueChange={(value) => setTab(value as "updates" | "trending")}>
            <TabsList>
              <TabsTrigger value="updates">{t("home.plugins.updatesTab")}</TabsTrigger>
              <TabsTrigger value="trending">{t("home.plugins.trendingTab")}</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : tab === "updates" ? (
          <div className="flex flex-col gap-2">
            {updates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("home.plugins.updatesEmpty")}</p>
            ) : (
              updates.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setOpenUpdate(row)}
                  className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-left text-sm shadow-sm transition-shadow outline-none hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t("home.plugins.updateLine", { from: row.from, to: row.to })}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {trending.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("home.plugins.trendingEmpty")}</p>
            ) : (
              trending.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setOpenTrending(row)}
                  className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-left text-sm shadow-sm transition-shadow outline-none hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t("home.plugins.downloadsLine", { count: row.downloads })}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </CardContent>

      <Dialog open={openUpdate !== null} onOpenChange={(open) => !open && setOpenUpdate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{openUpdate?.name}</DialogTitle>
            <DialogDescription>
              {openUpdate &&
                t("home.plugins.updateLine", { from: openUpdate.from, to: openUpdate.to })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{openUpdate?.description}</p>
          <DialogFooter>
            <Button
              onClick={() => {
                setOpenUpdate(null)
                onNavigate("plugins")
              }}
            >
              {t("home.plugins.viewInPlugins")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openTrending !== null} onOpenChange={(open) => !open && setOpenTrending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{openTrending?.name}</DialogTitle>
            <DialogDescription>
              {openTrending && t("home.plugins.downloadsLine", { count: openTrending.downloads })}
              {openTrending?.ownerHandle ? ` · ${openTrending.ownerHandle}` : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{openTrending?.description}</p>
          <DialogFooter>
            <Button
              onClick={() => {
                setOpenTrending(null)
                onNavigate("marketplace")
              }}
            >
              {t("home.plugins.viewInMarketplace")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
        description: localize(plugin.manifest.description, locale),
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
      description: localize(entry.description, locale),
      ownerHandle: entry.ownerHandle,
    }))
}
