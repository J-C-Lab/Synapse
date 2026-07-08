import type { FrequentAppEntry } from "@/lib/electron"
import { AppWindow, Globe, LayoutGrid, RefreshCw, Star } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { getFrequentApps, isElectron, launchApp, refreshApps } from "@/lib/electron"
import { formatRelativeTime } from "@/lib/format-relative-time"
import { cn } from "@/lib/utils"

function KindIcon({ kind, className }: { kind: LauncherAppKind; className?: string }) {
  if (kind === "url") return <Globe className={className} aria-hidden />
  if (kind === "uwp") return <LayoutGrid className={className} aria-hidden />
  return <AppWindow className={className} aria-hidden />
}

export function FrequentAppsCard() {
  const { t, i18n } = useTranslation()
  const [apps, setApps] = useState<FrequentAppEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!isElectron()) {
      setLoading(false)
      return
    }
    void getFrequentApps().then((rows) => {
      setApps(rows)
      setLoading(false)
    })
  }, [])

  async function onRescan() {
    setRefreshing(true)
    try {
      await refreshApps()
      setApps(await getFrequentApps())
    } finally {
      setRefreshing(false)
    }
  }

  async function onLaunch(id: string) {
    const ok = await launchApp(id)
    if (ok) setApps(await getFrequentApps())
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Star className="size-4 text-primary" aria-hidden />
            {t("home.frequentApps.title")}
          </CardTitle>
          <CardDescription>{t("home.frequentApps.subtitle")}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void onRescan()} disabled={refreshing}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
          {t("home.frequentApps.rescan")}
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              // eslint-disable-next-line react/no-array-index-key -- fixed-count loading placeholders, never reordered
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : apps.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">{t("home.frequentApps.empty")}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onRescan()}
              disabled={refreshing}
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
              {t("home.frequentApps.emptyAction")}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {apps.map(({ entry, lastLaunchedAt }) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => void onLaunch(entry.id)}
                className="flex flex-col items-center gap-1 rounded-lg border border-transparent p-2 text-center hover:bg-accent focus-visible:border-ring focus-visible:outline-none"
              >
                <KindIcon kind={entry.kind} className="size-5 text-muted-foreground" />
                <span className="w-full truncate text-xs font-medium">{entry.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {formatRelativeTime(lastLaunchedAt, i18n.language)}
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
