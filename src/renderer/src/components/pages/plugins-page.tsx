import type { ReactNode } from "react"
import type { PluginRegistryEntry } from "@/lib/electron"
import { AlertCircle, Download, PackageSearch, RefreshCw, Trash2 } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ActiveBackgroundPanel } from "@/components/plugins/active-background-panel"
import { DeclaredTriggersPanel } from "@/components/plugins/declared-triggers-panel"
import { PluginCapabilityList } from "@/components/plugins/plugin-capability-list"
import { PluginCapabilityProfileCard } from "@/components/plugins/plugin-capability-profile"
import { PluginCredentialsPanel } from "@/components/plugins/plugin-credentials-panel"
import { TriggerMigrationNoticeBanner } from "@/components/plugins/trigger-migration-notice-banner"
import { localize } from "@/components/plugins/view-utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  invalidateCapabilityProfileCache,
  useCapabilityProfile,
} from "@/hooks/use-capability-profile"
import {
  droppedFilePath,
  ElectronIpcError,
  getSettings,
  importPluginFromFile,
  installPluginPackage,
  isElectron,
  listPlugins,
  onPluginRegistryChanged,
  reloadPlugin,
  setPluginEnabled,
  setPluginPreference,
  uninstallPlugin,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

type ManifestPreference = NonNullable<
  NonNullable<PluginRegistryEntry["manifest"]>["contributes"]["preferences"]
>[number]

type ManifestWithTriggers = NonNullable<PluginRegistryEntry["manifest"]> & {
  triggers?: Array<{
    id: string
    type: string
    handler: string
    uses: Array<{
      capability: string
      budget: { maxCalls: number; period: string }
      scope?: unknown
    }>
    scope?: { contentTypes?: string[] }
    schedule?: { intervalMs: number } | string
  }>
}

const ALL_PLUGIN_SOURCE = "all"
const ALL_PLUGIN_STATUS = "all"
const PLUGIN_SOURCE_FILTERS: Array<PluginRegistryEntry["source"]["kind"]> = [
  "builtin",
  "user",
  "dev",
]
const PLUGIN_STATUS_FILTERS: PluginRegistryEntry["status"][] = [
  "active",
  "disabled",
  "crashed",
  "invalid",
  "shadowed",
]
type PluginSourceFilter = PluginRegistryEntry["source"]["kind"] | typeof ALL_PLUGIN_SOURCE
type PluginStatusFilter = PluginRegistryEntry["status"] | typeof ALL_PLUGIN_STATUS
const PLUGIN_SOURCE_FILTER_OPTIONS: PluginSourceFilter[] = [
  ALL_PLUGIN_SOURCE,
  ...PLUGIN_SOURCE_FILTERS,
]
const PLUGIN_STATUS_FILTER_OPTIONS: PluginStatusFilter[] = [
  ALL_PLUGIN_STATUS,
  ...PLUGIN_STATUS_FILTERS,
]

export function PluginsPage() {
  const { i18n, t } = useTranslation()
  const electronReady = isElectron()
  const [plugins, setPlugins] = useState<PluginRegistryEntry[]>([])
  const [query, setQuery] = useState("")
  const [sourceFilter, setSourceFilter] = useState<PluginSourceFilter>(ALL_PLUGIN_SOURCE)
  const [statusFilter, setStatusFilter] = useState<PluginStatusFilter>(ALL_PLUGIN_STATUS)
  const [loading, setLoading] = useState(electronReady)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [enableConfirm, setEnableConfirm] = useState<PluginRegistryEntry | null>(null)
  // The detail dialog tracks the selected plugin by its composite key (not the
  // object) so it always renders the freshest entry after a toggle/preference
  // mutation replaces the array item.
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [trustedSourcePolicy, setTrustedSourcePolicy] =
    useState<SynapseTrustedSourcePolicy>("official-marketplace")

  const visiblePlugins = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return plugins.filter((plugin) => {
      if (sourceFilter !== ALL_PLUGIN_SOURCE && plugin.source.kind !== sourceFilter) return false
      if (statusFilter !== ALL_PLUGIN_STATUS && plugin.status !== statusFilter) return false
      if (!normalizedQuery) return true
      return pluginSearchText(plugin, i18n.language).toLowerCase().includes(normalizedQuery)
    })
  }, [i18n.language, plugins, query, sourceFilter, statusFilter])

  const detailPlugin = useMemo(
    () => plugins.find((plugin) => pluginKey(plugin) === detailKey) ?? null,
    [plugins, detailKey]
  )

  const load = useCallback(async () => {
    if (!electronReady) return
    setLoading(true)
    setError(null)
    try {
      setPlugins(await listPlugins())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [electronReady])

  useEffect(() => {
    if (!electronReady) return
    void load()
    void getSettings()
      .then((settings) => setTrustedSourcePolicy(settings.trustedSourcePolicy))
      .catch(() => undefined)
    return onPluginRegistryChanged((nextPlugins) => {
      invalidateCapabilityProfileCache()
      setPlugins(nextPlugins)
    })
  }, [electronReady, load])

  const localImportAllowed = trustedSourcePolicy !== "official-marketplace"

  // The host broadcasts a registry change after every install, so the plugin
  // list refreshes itself via onPluginRegistryChanged — these handlers only
  // drive the picker/drop UX and surface success/error.
  async function runImport(action: () => Promise<void>) {
    setImporting(true)
    try {
      await action()
      setError(null)
    } catch (err) {
      const message = errorMessage(err)
      setError(message)
      toast.error(message)
    } finally {
      setImporting(false)
    }
  }

  async function onImportClick() {
    if (!localImportAllowed) return
    await runImport(async () => {
      const plugin = await importPluginFromFile()
      // null = user cancelled the picker; nothing to report.
      if (plugin) toast.success(t("plugins.toasts.imported"))
    })
  }

  async function onDrop(event: React.DragEvent) {
    event.preventDefault()
    setDragActive(false)
    if (importing || !localImportAllowed) return
    const files = Array.from(event.dataTransfer.files)
    const synapseFiles = files.filter((file) => file.name.toLowerCase().endsWith(".syn"))
    if (synapseFiles.length === 0) {
      if (files.length > 0) toast.error(t("plugins.importInvalid"))
      return
    }
    await runImport(async () => {
      for (const file of synapseFiles) {
        await installPluginPackage(droppedFilePath(file))
      }
      toast.success(t("plugins.toasts.imported"))
    })
  }

  async function applyEnabled(plugin: PluginRegistryEntry, enabled: boolean) {
    await mutate(`toggle:${plugin.pluginId}`, async () => {
      upsertPlugin(await setPluginEnabled(plugin.pluginId, enabled))
      toast.success(t(enabled ? "plugins.toasts.enabled" : "plugins.toasts.disabled"))
    })
  }

  async function onToggle(plugin: PluginRegistryEntry, enabled: boolean) {
    const triggers = (plugin.manifest as ManifestWithTriggers | undefined)?.triggers
    if (enabled && triggers?.length) {
      setEnableConfirm(plugin)
      return
    }
    await applyEnabled(plugin, enabled)
  }

  async function onReload(plugin: PluginRegistryEntry) {
    await mutate(`reload:${plugin.pluginId}`, async () => {
      const reloaded = await reloadPlugin(plugin.pluginId)
      if (reloaded) upsertPlugin(reloaded)
      toast.success(t("plugins.toasts.reloaded"))
    })
  }

  async function onUninstall(plugin: PluginRegistryEntry) {
    await mutate(`uninstall:${plugin.pluginId}`, async () => {
      await uninstallPlugin(plugin.pluginId)
      setPlugins((current) => current.filter((item) => !samePlugin(item, plugin)))
      toast.success(t("plugins.toasts.uninstalled"))
    })
  }

  async function onPreferenceChange(
    plugin: PluginRegistryEntry,
    preference: ManifestPreference,
    value: unknown
  ) {
    await mutate(`preference:${plugin.pluginId}:${preference.id}`, async () => {
      await setPluginPreference(plugin.pluginId, preference.id, value)
      setPlugins((current) =>
        current.map((item) =>
          samePlugin(item, plugin)
            ? {
                ...item,
                preferences: {
                  ...item.preferences,
                  [preference.id]: value,
                },
              }
            : item
        )
      )
      toast.success(t("plugins.toasts.preferenceSaved"))
    })
  }

  async function mutate(key: string, action: () => Promise<void>) {
    setPending(key)
    try {
      await action()
      setError(null)
    } catch (err) {
      const message = errorMessage(err)
      setError(message)
      toast.error(message)
    } finally {
      setPending(null)
    }
  }

  function upsertPlugin(plugin: PluginRegistryEntry) {
    setPlugins((current) => current.map((item) => (samePlugin(item, plugin) ? plugin : item)))
  }

  if (!electronReady) {
    return (
      <PageFrame title={t("plugins.title")} subtitle={t("plugins.subtitle")}>
        <Alert>
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t("plugins.unavailableTitle")}</AlertTitle>
          <AlertDescription>{t("plugins.unavailableBody")}</AlertDescription>
        </Alert>
      </PageFrame>
    )
  }

  return (
    <div
      className="relative"
      onDragOver={(event) => {
        event.preventDefault()
        if (!dragActive) setDragActive(true)
      }}
      onDragLeave={(event) => {
        // Only clear when the pointer actually leaves the drop region.
        if (event.currentTarget === event.target) setDragActive(false)
      }}
      onDrop={(event) => void onDrop(event)}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/80">
          <p className="text-sm font-medium text-primary">{t("plugins.dropHint")}</p>
        </div>
      )}
      <PageFrame
        title={t("plugins.title")}
        subtitle={t("plugins.subtitle")}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={importing || !localImportAllowed}
              onClick={() => void onImportClick()}
            >
              <Download className={cn("size-4", importing && "animate-pulse")} aria-hidden />
              {t(importing ? "plugins.actions.importing" : "plugins.actions.import")}
            </Button>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
              {t("plugins.actions.refresh")}
            </Button>
          </div>
        }
      >
        <TriggerMigrationNoticeBanner />
        {!loading && plugins.length > 0 && (
          <>
            <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
              <div className="relative min-w-64 flex-1">
                <PackageSearch
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={t("plugins.searchPlaceholder")}
                  className="pl-9"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("plugins.filters.source")}</span>
                {PLUGIN_SOURCE_FILTER_OPTIONS.map((source) => (
                  <Button
                    key={source}
                    type="button"
                    variant={sourceFilter === source ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSourceFilter(source)}
                  >
                    {source === ALL_PLUGIN_SOURCE
                      ? t("plugins.filters.allSources")
                      : t(`plugins.source.${source}`)}
                  </Button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("plugins.filters.status")}</span>
                {PLUGIN_STATUS_FILTER_OPTIONS.map((status) => (
                  <Button
                    key={status}
                    type="button"
                    variant={statusFilter === status ? "default" : "outline"}
                    size="sm"
                    onClick={() => setStatusFilter(status)}
                  >
                    {status === ALL_PLUGIN_STATUS
                      ? t("plugins.filters.allStatuses")
                      : t(`plugins.status.${status}`)}
                  </Button>
                ))}
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("plugins.visibleCount", {
                total: plugins.length,
                visible: visiblePlugins.length,
              })}
            </p>
          </>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" aria-hidden />
            <AlertTitle>{t("plugins.errorTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("plugins.loading")}</CardTitle>
              <CardDescription>{t("plugins.loadingHint")}</CardDescription>
            </CardHeader>
          </Card>
        ) : plugins.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("plugins.emptyTitle")}</CardTitle>
              <CardDescription>{t("plugins.emptyBody")}</CardDescription>
            </CardHeader>
          </Card>
        ) : visiblePlugins.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("plugins.filteredEmptyTitle")}</CardTitle>
              <CardDescription>{t("plugins.filteredEmptyBody")}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {visiblePlugins.map((plugin) => (
              // eslint-disable-next-line ts/no-use-before-define
              <PluginRow
                key={pluginKey(plugin)}
                locale={i18n.language}
                pending={pending}
                plugin={plugin}
                onOpenDetails={() => setDetailKey(pluginKey(plugin))}
                onToggle={onToggle}
              />
            ))}
          </div>
        )}
      </PageFrame>

      <Dialog
        open={detailPlugin !== null}
        onOpenChange={(open) => {
          if (!open) setDetailKey(null)
        }}
      >
        <DialogContent className="max-h-[85vh] gap-4 overflow-y-auto sm:max-w-2xl">
          {detailPlugin ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
                  <span className="truncate">{pluginTitle(detailPlugin, i18n.language)}</span>
                  <StatusBadge status={detailPlugin.status} />
                  <Badge variant="outline">{detailPlugin.pluginId}</Badge>
                </DialogTitle>
                <DialogDescription>
                  {pluginDescription(detailPlugin, i18n.language)}
                </DialogDescription>
              </DialogHeader>
              <PluginDetails
                locale={i18n.language}
                pending={pending}
                plugin={detailPlugin}
                onPreferenceChange={onPreferenceChange}
                onReload={onReload}
                onUninstall={onUninstall}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={enableConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setEnableConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("plugins.triggers.enableConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("plugins.triggers.enableConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {enableConfirm ? (
            <DeclaredTriggersPanel
              triggers={
                (enableConfirm.manifest as ManifestWithTriggers | undefined)?.triggers ?? []
              }
            />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("plugins.capabilities.deny")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const plugin = enableConfirm
                setEnableConfirm(null)
                if (plugin) void applyEnabled(plugin, true)
              }}
            >
              {t("plugins.capabilities.allow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function pluginSearchText(plugin: PluginRegistryEntry, locale: string): string {
  const manifest = plugin.manifest
  const commandText =
    manifest?.contributes.commands.flatMap((command) => [
      command.id,
      localize(command.title, locale),
      localize(command.subtitle, locale),
      ...(command.keywords ?? []),
    ]) ?? []

  return [
    plugin.pluginId,
    plugin.rootDir,
    plugin.status,
    plugin.source.kind,
    plugin.error,
    manifest?.name,
    manifest?.version,
    manifest?.author,
    localize(manifest?.displayName, locale),
    localize(manifest?.description, locale),
    ...(manifest?.permissions ?? []),
    ...commandText,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
}

function PageFrame({
  action,
  children,
  subtitle,
  title,
}: {
  action?: ReactNode
  children: ReactNode
  subtitle: string
  title: string
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {action}
      </header>
      {children}
    </div>
  )
}

function pluginKey(plugin: PluginRegistryEntry): string {
  return `${plugin.pluginId}:${plugin.source.kind}:${plugin.rootDir}`
}

function pluginTitle(plugin: PluginRegistryEntry, locale: string): string {
  return localize(plugin.manifest?.displayName, locale) || plugin.manifest?.name || plugin.pluginId
}

function pluginDescription(plugin: PluginRegistryEntry, locale: string): string {
  return localize(plugin.manifest?.description, locale) || plugin.error || plugin.rootDir
}

// Compact list row: identity + status + the enable toggle. Clicking the row body
// (everything except the toggle) opens the detail dialog, so a long plugin list
// stays scannable instead of stacking every plugin's full detail panel.
const PluginRow = memo(
  ({
    locale,
    onOpenDetails,
    onToggle,
    pending,
    plugin,
  }: {
    locale: string
    onOpenDetails: () => void
    onToggle: (plugin: PluginRegistryEntry, enabled: boolean) => Promise<void>
    pending: string | null
    plugin: PluginRegistryEntry
  }) => {
    const { t } = useTranslation()
    const manifest = plugin.manifest
    const title = pluginTitle(plugin, locale)
    const description = pluginDescription(plugin, locale)
    const togglePending = pending === `toggle:${plugin.pluginId}`
    const canToggle = plugin.status === "active" || plugin.status === "disabled"

    return (
      <Card className={cn("p-0", plugin.status === "invalid" && "border-destructive/50")}>
        <div className="flex items-center gap-3 p-4">
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col gap-1 text-left"
            aria-label={t("plugins.actions.details", { name: title, defaultValue: title })}
            onClick={onOpenDetails}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{title}</span>
              <StatusBadge status={plugin.status} />
              <Badge variant="outline">{plugin.pluginId}</Badge>
            </span>
            <span className="truncate text-xs text-muted-foreground">{description}</span>
            <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <span>
                {t("plugins.meta.version")}: {manifest?.version ?? "—"}
              </span>
              <span>
                {t("plugins.meta.commands")}: {manifest?.contributes.commands.length ?? 0}
              </span>
              <span>{t(`plugins.source.${plugin.source.kind}`)}</span>
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor={`plugin-enabled-${plugin.pluginId}`} className="text-xs">
              {t(
                plugin.status === "disabled" ? "plugins.actions.enable" : "plugins.actions.disable"
              )}
            </Label>
            <Switch
              id={`plugin-enabled-${plugin.pluginId}`}
              size="sm"
              checked={plugin.status === "active"}
              disabled={!canToggle || togglePending}
              onCheckedChange={(checked) => void onToggle(plugin, checked)}
            />
          </div>
        </div>
      </Card>
    )
  }
)

// Full detail body rendered inside the detail dialog: meta, permissions,
// declared/active triggers, errors, preferences, and the heavier reload/uninstall
// actions that no longer belong on the compact list row.
function PluginDetails({
  locale,
  onPreferenceChange,
  onReload,
  onUninstall,
  pending,
  plugin,
}: {
  locale: string
  onPreferenceChange: (
    plugin: PluginRegistryEntry,
    preference: ManifestPreference,
    value: unknown
  ) => Promise<void>
  onReload: (plugin: PluginRegistryEntry) => Promise<void>
  onUninstall: (plugin: PluginRegistryEntry) => Promise<void>
  pending: string | null
  plugin: PluginRegistryEntry
}) {
  const { t } = useTranslation()
  const manifest = plugin.manifest
  const profile = useCapabilityProfile(plugin.pluginId)
  const reloadPending = pending === `reload:${plugin.pluginId}`
  const uninstallPending = pending === `uninstall:${plugin.pluginId}`
  const canUninstall = plugin.source.kind !== "builtin"

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <span>
          {t("plugins.meta.version")}: {manifest?.version ?? "—"}
        </span>
        <span>
          {t("plugins.meta.author")}: {manifest?.author ?? "—"}
        </span>
        <span>
          {t("plugins.meta.commands")}: {manifest?.contributes.commands.length ?? 0}
        </span>
        <span className="truncate" title={plugin.rootDir}>
          {t("plugins.meta.path")}: {plugin.rootDir}
        </span>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("plugins.permissions.title")}</h3>
        {profile ? <PluginCapabilityProfileCard profile={profile} /> : null}
        <PluginCapabilityList
          pluginId={plugin.pluginId}
          emptyLabel={t("plugins.permissions.none")}
        />
      </div>

      {(manifest?.contributes as { credentials?: unknown[] } | undefined)?.credentials?.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("plugins.credentials.title")}</h3>
          <PluginCredentialsPanel
            pluginId={plugin.pluginId}
            locale={locale}
            emptyLabel={t("plugins.credentials.none")}
          />
        </div>
      ) : null}

      {(manifest as ManifestWithTriggers | undefined)?.triggers?.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("plugins.triggers.declaredTitle")}</h3>
          <DeclaredTriggersPanel triggers={(manifest as ManifestWithTriggers).triggers ?? []} />
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">
          {t("plugins.triggers.activeTitle", { defaultValue: "Active triggers" })}
        </h3>
        <ActiveBackgroundPanel
          pluginId={plugin.pluginId}
          emptyLabel={t("plugins.triggers.none", { defaultValue: "No active triggers" })}
        />
      </div>

      {plugin.error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t("plugins.pluginErrorTitle")}</AlertTitle>
          <AlertDescription>{plugin.error}</AlertDescription>
        </Alert>
      )}

      {manifest?.contributes.preferences?.length ? (
        <>
          <Separator />
          <PluginPreferences
            locale={locale}
            pending={pending}
            plugin={plugin}
            preferences={manifest.contributes.preferences}
            onPreferenceChange={onPreferenceChange}
          />
        </>
      ) : null}

      <Separator />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={reloadPending}
          onClick={() => void onReload(plugin)}
        >
          <RefreshCw className={cn("size-4", reloadPending && "animate-spin")} aria-hidden />
          {t("plugins.actions.reload")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canUninstall || uninstallPending}
          onClick={() => void onUninstall(plugin)}
        >
          <Trash2 className="size-4" aria-hidden />
          {t("plugins.actions.uninstall")}
        </Button>
      </div>
    </div>
  )
}

function PluginPreferences({
  locale,
  onPreferenceChange,
  pending,
  plugin,
  preferences,
}: {
  locale: string
  onPreferenceChange: (
    plugin: PluginRegistryEntry,
    preference: ManifestPreference,
    value: unknown
  ) => Promise<void>
  pending: string | null
  plugin: PluginRegistryEntry
  preferences: ManifestPreference[]
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">{t("plugins.preferences.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("plugins.preferences.body")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {preferences.map((preference) => (
          <PreferenceControl
            key={preference.id}
            locale={locale}
            pending={pending === `preference:${plugin.pluginId}:${preference.id}`}
            plugin={plugin}
            preference={preference}
            onPreferenceChange={onPreferenceChange}
          />
        ))}
      </div>
    </div>
  )
}

function PreferenceControl({
  locale,
  onPreferenceChange,
  pending,
  plugin,
  preference,
}: {
  locale: string
  onPreferenceChange: (
    plugin: PluginRegistryEntry,
    preference: ManifestPreference,
    value: unknown
  ) => Promise<void>
  pending: boolean
  plugin: PluginRegistryEntry
  preference: ManifestPreference
}) {
  const { t } = useTranslation()
  const id = `plugin-preference-${plugin.pluginId}-${preference.id}`
  const value =
    plugin.preferences && preference.id in plugin.preferences
      ? plugin.preferences[preference.id]
      : preference.default
  const label = localize(preference.label, locale) || preference.id

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
      <Label htmlFor={id}>{label}</Label>
      {preference.type === "checkbox" ? (
        <Switch
          id={id}
          checked={Boolean(value)}
          disabled={pending}
          onCheckedChange={(checked) => void onPreferenceChange(plugin, preference, checked)}
        />
      ) : preference.type === "select" ? (
        <Select
          value={typeof value === "string" ? value : (preference.options?.[0]?.value ?? "")}
          disabled={pending || !preference.options?.length}
          onValueChange={(nextValue) => void onPreferenceChange(plugin, preference, nextValue)}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {preference.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {localize(option.label, locale) || option.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : preference.type === "number" ? (
        <Input
          id={id}
          key={`${plugin.pluginId}:${preference.id}:${String(value)}`}
          type="number"
          disabled={pending}
          defaultValue={typeof value === "number" ? String(value) : ""}
          onBlur={(event) => {
            const raw = event.currentTarget.value.trim()
            if (!raw) return
            const nextValue = Number(raw)
            if (!Number.isFinite(nextValue)) {
              toast.error(t("plugins.preferences.invalidNumber"))
              event.currentTarget.value = typeof value === "number" ? String(value) : ""
              return
            }
            if (nextValue !== value) void onPreferenceChange(plugin, preference, nextValue)
          }}
        />
      ) : (
        <Input
          id={id}
          key={`${plugin.pluginId}:${preference.id}:${String(value)}`}
          disabled={pending}
          defaultValue={typeof value === "string" ? value : ""}
          onBlur={(event) => {
            const nextValue = event.currentTarget.value
            if (nextValue !== value) void onPreferenceChange(plugin, preference, nextValue)
          }}
        />
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: PluginRegistryEntry["status"] }) {
  const { t } = useTranslation()
  const variant =
    status === "active"
      ? "default"
      : status === "disabled"
        ? "secondary"
        : status === "shadowed"
          ? "outline"
          : "destructive"

  return <Badge variant={variant}>{t(`plugins.status.${status}`)}</Badge>
}

function samePlugin(left: PluginRegistryEntry, right: PluginRegistryEntry): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.rootDir === right.rootDir &&
    left.source.kind === right.source.kind
  )
}

function errorMessage(err: unknown): string {
  if (err instanceof ElectronIpcError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
