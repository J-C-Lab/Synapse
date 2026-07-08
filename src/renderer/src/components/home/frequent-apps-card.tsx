import type { FrequentAppEntry } from "@/lib/electron"
import { AppWindow, Globe, LayoutGrid, Star, X } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { getFrequentApps, isElectron, launchApp, removeFrequentApp } from "@/lib/electron"
import { formatRelativeTime } from "@/lib/format-relative-time"

function KindIcon({ kind, className }: { kind: LauncherAppKind; className?: string }) {
  if (kind === "url") return <Globe className={className} aria-hidden />
  if (kind === "uwp") return <LayoutGrid className={className} aria-hidden />
  return <AppWindow className={className} aria-hidden />
}

export function FrequentAppsCard() {
  const { t, i18n } = useTranslation()
  const [apps, setApps] = useState<FrequentAppEntry[]>([])
  const [loading, setLoading] = useState(() => isElectron())

  useEffect(() => {
    if (!isElectron()) return

    function refresh() {
      void getFrequentApps().then((rows) => {
        setApps(rows)
        setLoading(false)
      })
    }

    refresh()
    // The list can go stale without this component ever unmounting — e.g.
    // launching an app via the global-hotkey launcher popup while this card
    // is already on screen updates usage in the main process, but this card
    // has no push channel for that. Refetching on window focus (the user
    // switching back into the app) catches that case cheaply.
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  async function onLaunch(id: string) {
    const ok = await launchApp(id)
    if (ok) setApps(await getFrequentApps())
  }

  async function onRemove(id: string) {
    setApps((current) => current.filter((row) => row.entry.id !== id))
    await removeFrequentApp(id)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Star className="size-4 text-primary" aria-hidden />
          {t("home.frequentApps.title")}
        </CardTitle>
        <CardDescription>{t("home.frequentApps.subtitle")}</CardDescription>
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
          <p className="text-sm text-muted-foreground">{t("home.frequentApps.empty")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {apps.map(({ entry, lastLaunchedAt, iconDataUrl }) => (
              <div key={entry.id} className="group relative">
                <button
                  type="button"
                  onClick={() => void onLaunch(entry.id)}
                  className="flex w-full flex-col items-center gap-1 rounded-lg p-2 text-center outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                >
                  {iconDataUrl ? (
                    <img src={iconDataUrl} alt="" className="size-5" aria-hidden />
                  ) : (
                    <KindIcon kind={entry.kind} className="size-5 text-muted-foreground" />
                  )}
                  <span className="w-full truncate text-xs font-medium">{entry.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatRelativeTime(lastLaunchedAt, i18n.language)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void onRemove(entry.id)
                  }}
                  aria-label={t("home.frequentApps.remove", { name: entry.name })}
                  className="absolute -right-1 -top-1 z-10 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 outline-none transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="size-2.5" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
