import type { ReactNode } from "react"
import type { MarketplaceDetail, MarketplaceSummary, PluginRegistryEntry } from "@/lib/electron"
import {
  AlertCircle,
  Download,
  PackageSearch,
  RefreshCw,
  Send,
  ShieldCheck,
  Store,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { localize } from "@/components/plugins/view-utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ElectronIpcError,
  getMarketplaceDetail,
  installMarketplaceBackendPlugin,
  isElectron,
  listPlugins,
  onPluginRegistryChanged,
  searchMarketplace,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

export function MarketplacePage() {
  const { i18n, t } = useTranslation()
  const electronReady = isElectron()
  const [entries, setEntries] = useState<MarketplaceSummary[]>([])
  const [installed, setInstalled] = useState<Map<string, PluginRegistryEntry>>(() => new Map())
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(electronReady)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(
    async (search: string) => {
      if (!electronReady) return
      setLoading(true)
      setError(null)
      try {
        const [result, plugins] = await Promise.all([searchMarketplace(search), listPlugins()])
        setEntries(result.items)
        setInstalled(installedPluginMap(plugins))
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [electronReady]
  )

  // Debounced search as the query changes.
  useEffect(() => {
    if (!electronReady) return
    const handle = setTimeout(() => void load(query), 250)
    return () => clearTimeout(handle)
  }, [electronReady, load, query])

  useEffect(() => {
    if (!electronReady) return
    return onPluginRegistryChanged((plugins) => setInstalled(installedPluginMap(plugins)))
  }, [electronReady])

  if (!electronReady) {
    return (
      <MarketplaceFrame>
        <Alert>
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t("marketplace.unavailableTitle")}</AlertTitle>
          <AlertDescription>{t("marketplace.unavailableBody")}</AlertDescription>
        </Alert>
      </MarketplaceFrame>
    )
  }

  return (
    <MarketplaceFrame
      action={
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(query)}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
          {t("marketplace.actions.refresh")}
        </Button>
      }
    >
      <div className="rounded-lg border bg-card p-3">
        <div className="relative min-w-64 flex-1">
          <PackageSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("marketplace.searchPlaceholder")}
            className="pl-9"
          />
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t("marketplace.errorTitle")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("marketplace.loading")}</CardTitle>
            <CardDescription>{t("marketplace.loadingHint")}</CardDescription>
          </CardHeader>
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-56 items-center justify-center gap-3 text-sm text-muted-foreground">
            <PackageSearch className="size-4" aria-hidden />
            {t("marketplace.empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {entries.map((entry) => (
            <MarketplaceCard
              key={entry.id}
              entry={entry}
              installed={installed.get(entry.id)}
              locale={i18n.language}
              onOpen={() => setSelectedId(entry.id)}
            />
          ))}
        </div>
      )}

      <PluginDetailDialog
        pluginId={selectedId}
        installed={selectedId ? installed.get(selectedId) : undefined}
        locale={i18n.language}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onInstalled={(plugin) => {
          setInstalled((current) => new Map(current).set(plugin.pluginId, plugin))
          setSelectedId(null)
        }}
      />
    </MarketplaceFrame>
  )
}

function MarketplaceFrame({ action, children }: { action?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("marketplace.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("marketplace.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {action}
          <SubmitPluginButton />
        </div>
      </header>
      {children}
    </div>
  )
}

function SubmitPluginButton() {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button disabled>
            <Send className="size-4" aria-hidden />
            {t("marketplace.submit")}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{t("marketplace.submitTooltip")}</TooltipContent>
    </Tooltip>
  )
}

function MarketplaceCard({
  entry,
  installed,
  locale,
  onOpen,
}: {
  entry: MarketplaceSummary
  installed?: PluginRegistryEntry
  locale: string
  onOpen: () => void
}) {
  const { t } = useTranslation()
  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted">
            <Store className="size-4 text-muted-foreground" aria-hidden />
          </span>
          <Badge variant={installed ? "default" : "outline"}>
            {installed ? t("marketplace.installState.installed") : `v${entry.latestVersion ?? "?"}`}
          </Badge>
        </div>
        <div className="min-w-0">
          <CardTitle className="truncate text-base">
            {localize(entry.displayName, locale)}
          </CardTitle>
          <CardDescription className="mt-1 line-clamp-2">
            {localize(entry.description, locale)}
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t("marketplace.by", { handle: entry.ownerHandle })}</span>
          <span>·</span>
          <span>{entry.stats.downloads} ↓</span>
        </div>
        <Button type="button" variant="outline" className="w-full" onClick={onOpen}>
          {t("marketplace.viewDetails")}
        </Button>
      </CardContent>
    </Card>
  )
}

function PluginDetailDialog({
  pluginId,
  installed,
  locale,
  onOpenChange,
  onInstalled,
}: {
  pluginId: string | null
  installed?: PluginRegistryEntry
  locale: string
  onOpenChange: (open: boolean) => void
  onInstalled: (plugin: PluginRegistryEntry) => void
}) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pluginId) {
      setDetail(null)
      setError(null)
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    getMarketplaceDetail(pluginId)
      .then((result) => active && setDetail(result))
      .catch((err) => active && setError(errorMessage(err)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [pluginId])

  const latest = detail ? latestVersion(detail) : undefined
  const manifest = latest?.manifestSnapshot
  const permissions = manifest?.permissions ?? []
  const tools = manifest?.contributes.tools ?? []

  async function install() {
    if (!detail || !latest) return
    setInstalling(true)
    setError(null)
    try {
      const plugin = await installMarketplaceBackendPlugin(detail.plugin.id, latest.version)
      toast.success(t("marketplace.toasts.installed"))
      onInstalled(plugin)
    } catch (err) {
      const message = errorMessage(err)
      setError(message)
      toast.error(message)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Dialog open={Boolean(pluginId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        {loading || !detail ? (
          <DialogHeader>
            <DialogTitle>{t("marketplace.loading")}</DialogTitle>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{localize(detail.plugin.displayName, locale)}</DialogTitle>
              <DialogDescription>{localize(detail.plugin.description, locale)}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t("marketplace.by", { handle: detail.ownerHandle })}</span>
              <span>·</span>
              <span>v{latest?.version}</span>
              <span>·</span>
              <span>{detail.plugin.stats.downloads} ↓</span>
            </div>

            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
                {t("marketplace.detail.permissionsTitle")}
              </h3>
              {permissions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("marketplace.detail.permissionsNone")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {permissions.map((permission) => (
                    <Badge key={permission} variant="secondary" className="font-mono font-normal">
                      {permission}
                    </Badge>
                  ))}
                </div>
              )}
            </section>

            {tools.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("marketplace.detail.toolsTitle")}</h3>
                <ul className="space-y-1.5">
                  {tools.map((tool) => (
                    <li key={tool.name} className="text-xs">
                      <span className="font-mono">{tool.name}</span>
                      <span className="text-muted-foreground"> — {tool.description}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("marketplace.detail.versions")}</h3>
              <div className="flex flex-wrap gap-1.5">
                {detail.versions.map((version) => (
                  <Badge key={version.version} variant="outline" className="font-normal">
                    v{version.version}
                  </Badge>
                ))}
              </div>
            </section>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button
                type="button"
                disabled={installing || Boolean(installed) || !latest}
                onClick={() => void install()}
              >
                <Download className={cn("size-4", installing && "animate-pulse")} aria-hidden />
                {installed
                  ? t("marketplace.installState.installed")
                  : installing
                    ? t("marketplace.detail.installing")
                    : t("marketplace.detail.install")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function latestVersion(
  detail: MarketplaceDetail
): MarketplaceDetail["versions"][number] | undefined {
  const target = detail.plugin.latestVersion
  return detail.versions.find((version) => version.version === target) ?? detail.versions[0]
}

function installedPluginMap(entries: PluginRegistryEntry[]): Map<string, PluginRegistryEntry> {
  return new Map(entries.map((entry) => [entry.manifest?.id ?? entry.pluginId, entry]))
}

function errorMessage(err: unknown): string {
  if (err instanceof ElectronIpcError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
