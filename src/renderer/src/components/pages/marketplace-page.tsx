import type { ReactNode } from "react"
import type {
  MarketplaceAccount,
  MarketplaceDetail,
  MarketplaceLoginPrompt,
  MarketplaceReport,
  MarketplaceSummary,
  PluginRegistryEntry,
} from "@/lib/electron"
import {
  AlertCircle,
  Download,
  Eye,
  EyeOff,
  Github,
  Loader2,
  LogOut,
  PackageSearch,
  RefreshCw,
  Send,
  ShieldCheck,
  Store,
  TriangleAlert,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { localize } from "@/components/plugins/view-utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ElectronIpcError,
  getMarketplaceAccount,
  getMarketplaceDetail,
  getSettings,
  installMarketplaceBackendPlugin,
  isElectron,
  listMarketplaceReports,
  listMyMarketplacePlugins,
  listPlugins,
  marketplaceLogin,
  marketplaceLogout,
  onMarketplaceLoginPrompt,
  onPluginRegistryChanged,
  rateMarketplacePlugin,
  removeMarketplacePlugin,
  reportMarketplacePlugin,
  resolveMarketplaceReport,
  searchMarketplace,
  setMarketplaceVisibility,
  yankMarketplaceVersion,
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
  const [account, setAccount] = useState<MarketplaceAccount>({ user: null })
  const [tab, setTab] = useState<"browse" | "mine" | "admin">("browse")
  const [mineEntries, setMineEntries] = useState<MarketplaceSummary[]>([])
  const [mineLoading, setMineLoading] = useState(false)
  const [mineError, setMineError] = useState<string | null>(null)
  const [governancePending, setGovernancePending] = useState<string | null>(null)
  const [reports, setReports] = useState<MarketplaceReport[]>([])
  const [reportsLoading, setReportsLoading] = useState(false)
  const [trustedSourcePolicy, setTrustedSourcePolicy] =
    useState<SynapseTrustedSourcePolicy>("official-marketplace")

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

  useEffect(() => {
    if (!electronReady) return
    let active = true
    void getMarketplaceAccount()
      .then((value) => active && setAccount(value))
      .catch(() => undefined)
    void getSettings()
      .then((settings) => active && setTrustedSourcePolicy(settings.trustedSourcePolicy))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [electronReady])

  const loadMine = useCallback(async () => {
    if (!electronReady || !account.user) return
    setMineLoading(true)
    setMineError(null)
    try {
      const result = await listMyMarketplacePlugins()
      setMineEntries(result.items)
    } catch (err) {
      setMineError(errorMessage(err))
    } finally {
      setMineLoading(false)
    }
  }, [account.user, electronReady])

  useEffect(() => {
    if (tab === "mine") void loadMine()
  }, [loadMine, tab])

  const loadReports = useCallback(async () => {
    if (!electronReady || account.user?.role !== "admin") return
    setReportsLoading(true)
    try {
      const result = await listMarketplaceReports("open")
      setReports(result.items)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setReportsLoading(false)
    }
  }, [account.user?.role, electronReady])

  useEffect(() => {
    if (tab === "admin") void loadReports()
  }, [loadReports, tab])

  async function resolveReport(report: MarketplaceReport, status: "reviewed" | "dismissed") {
    setGovernancePending(`report:${report.id}`)
    try {
      await resolveMarketplaceReport(report.id, status)
      setReports((current) => current.filter((item) => item.id !== report.id))
      toast.success(t("marketplace.governance.reportResolved"))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setGovernancePending(null)
    }
  }

  async function toggleVisibility(entry: MarketplaceSummary) {
    const next = entry.visibility === "public" ? "private" : "public"
    setGovernancePending(`visibility:${entry.id}`)
    try {
      await setMarketplaceVisibility(entry.id, next)
      setMineEntries((current) =>
        current.map((item) => (item.id === entry.id ? { ...item, visibility: next } : item))
      )
      toast.success(t("marketplace.governance.visibilityUpdated"))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setGovernancePending(null)
    }
  }

  async function yankLatest(entry: MarketplaceSummary) {
    if (!entry.latestVersion) return
    setGovernancePending(`yank:${entry.id}`)
    try {
      const detail = await yankMarketplaceVersion(entry.id, entry.latestVersion, undefined)
      setMineEntries((current) =>
        current.map((item) =>
          item.id === entry.id ? { ...item, latestVersion: detail.plugin.latestVersion } : item
        )
      )
      toast.success(t("marketplace.governance.yanked"))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setGovernancePending(null)
    }
  }

  async function adminRemove(entry: MarketplaceSummary) {
    setGovernancePending(`remove:${entry.id}`)
    try {
      await removeMarketplacePlugin(entry.id)
      setEntries((current) => current.filter((item) => item.id !== entry.id))
      toast.success(t("marketplace.governance.removed"))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setGovernancePending(null)
    }
  }

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
        <>
          <AccountControl account={account} onChange={setAccount} />
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(query)}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
            {t("marketplace.actions.refresh")}
          </Button>
        </>
      }
    >
      <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <TabsList>
          <TabsTrigger value="browse">{t("marketplace.tabs.browse")}</TabsTrigger>
          {account.user && <TabsTrigger value="mine">{t("marketplace.tabs.mine")}</TabsTrigger>}
          {account.user?.role === "admin" && (
            <TabsTrigger value="admin">{t("marketplace.tabs.admin")}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="browse" className="mt-4 space-y-4">
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

          <MarketplaceGrid
            emptyText={t("marketplace.empty")}
            entries={entries}
            installed={installed}
            loading={loading}
            locale={i18n.language}
            onOpen={setSelectedId}
          />
        </TabsContent>

        <TabsContent value="mine" className="mt-4 space-y-4">
          {!account.user ? (
            <Alert>
              <AlertCircle className="size-4" aria-hidden />
              <AlertDescription>{t("marketplace.governance.signInRequired")}</AlertDescription>
            </Alert>
          ) : (
            <>
              {mineError && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" aria-hidden />
                  <AlertTitle>{t("marketplace.errorTitle")}</AlertTitle>
                  <AlertDescription>{mineError}</AlertDescription>
                </Alert>
              )}
              <MarketplaceGrid
                emptyText={t("marketplace.governance.emptyMine")}
                entries={mineEntries}
                installed={installed}
                loading={mineLoading}
                locale={i18n.language}
                onOpen={setSelectedId}
                renderActions={(entry) => (
                  <GovernanceActions
                    entry={entry}
                    pending={governancePending}
                    onToggleVisibility={toggleVisibility}
                    onYank={yankLatest}
                  />
                )}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="admin" className="mt-4 space-y-6">
          <ReviewQueue
            reports={reports}
            loading={reportsLoading}
            pending={governancePending}
            onResolve={resolveReport}
            onOpen={setSelectedId}
          />
          <MarketplaceGrid
            emptyText={t("marketplace.governance.emptyAdmin")}
            entries={entries}
            installed={installed}
            loading={loading}
            locale={i18n.language}
            onOpen={setSelectedId}
            renderActions={(entry) => (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={governancePending === `remove:${entry.id}`}
                onClick={() => void adminRemove(entry)}
              >
                <TriangleAlert className="size-4" aria-hidden />
                {t("marketplace.governance.remove")}
              </Button>
            )}
          />
        </TabsContent>
      </Tabs>

      <PluginDetailDialog
        key={selectedId ?? "closed"}
        pluginId={selectedId}
        installed={selectedId ? installed.get(selectedId) : undefined}
        locale={i18n.language}
        canRate={Boolean(account.user)}
        canReport={Boolean(account.user)}
        canInstall={trustedSourcePolicy !== "local-syn"}
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

function AccountControl({
  account,
  onChange,
}: {
  account: MarketplaceAccount
  onChange: (account: MarketplaceAccount) => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState<MarketplaceLoginPrompt | null>(null)
  const [open, setOpen] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(
    () =>
      onMarketplaceLoginPrompt((nextPrompt) => {
        setPrompt(normalizeLoginPrompt(nextPrompt))
        setOpen(true)
      }),
    []
  )

  async function signIn() {
    setBusy(true)
    setOpen(true)
    setPrompt(null)
    setLoginError(null)
    try {
      const user = await marketplaceLogin()
      onChange({ user })
      setOpen(false)
      setPrompt(null)
      toast.success(t("marketplace.account.signedIn", { handle: user.handle }))
    } catch (err) {
      const message = errorMessage(err)
      setLoginError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    try {
      await marketplaceLogout()
      setOpen(false)
      setPrompt(null)
      onChange({ user: null })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (account.user) {
    const user = account.user
    return <MarketplaceAccountMenu busy={busy} user={user} onSignOut={() => void signOut()} />
  }
  return (
    <>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void signIn()}>
        <Github className="size-4" aria-hidden />
        {busy ? t("marketplace.account.signingIn") : t("marketplace.account.signIn")}
      </Button>
      <MarketplaceLoginDialog
        open={open}
        busy={busy}
        prompt={prompt}
        error={loginError}
        onOpenChange={setOpen}
      />
    </>
  )
}

function MarketplaceAccountMenu({
  busy,
  user,
  onSignOut,
}: {
  busy: boolean
  user: NonNullable<MarketplaceAccount["user"]>
  onSignOut: () => void
}) {
  const { t } = useTranslation()
  const label = t("marketplace.account.menuLabel", { handle: user.handle })
  return (
    <HoverCard openDelay={100} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="rounded-full outline-none ring-offset-background transition hover:ring-2 hover:ring-ring hover:ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <MarketplaceAvatar key={user.avatarUrl ?? "none"} user={user} size="sm" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72 p-3">
        <div className="flex items-center gap-3">
          <MarketplaceAvatar key={user.avatarUrl ?? "none"} user={user} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">@{user.handle}</p>
          </div>
        </div>
        <div className="mt-3 border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={onSignOut}
          >
            <LogOut className="size-4" aria-hidden />
            {t("marketplace.account.signOut")}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function MarketplaceAvatar({
  user,
  size,
}: {
  user: NonNullable<MarketplaceAccount["user"]>
  size: "sm" | "lg"
}) {
  // loading → show the neutral circle (no initials flash); loaded → the image;
  // fallback → initials (no avatar URL, or the image failed to load). The
  // parent keys this component on the avatar URL, so a new URL remounts it and
  // re-initializes the status cleanly.
  const [status, setStatus] = useState<"loading" | "loaded" | "fallback">(
    user.avatarUrl ? "loading" : "fallback"
  )

  return (
    <Avatar size={size} className="border bg-muted">
      {user.avatarUrl && status !== "fallback" && (
        <img
          className={cn(
            "aspect-square size-full transition-opacity",
            status === "loaded" ? "opacity-100" : "opacity-0"
          )}
          src={user.avatarUrl}
          alt={user.displayName}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("fallback")}
        />
      )}
      {status === "fallback" && <AvatarFallback>{accountInitial(user)}</AvatarFallback>}
    </Avatar>
  )
}

function MarketplaceLoginDialog({
  open,
  busy,
  prompt,
  error,
  onOpenChange,
}: {
  open: boolean
  busy: boolean
  prompt: MarketplaceLoginPrompt | null
  error: string | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-hidden p-0 sm:max-w-[560px]"
        showCloseButton={false}
      >
        <div className="flex max-h-[calc(100vh-2rem)] min-h-0 w-full flex-col">
          <div className="border-b bg-foreground px-5 py-4 text-background sm:px-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background/10">
                <Github className="size-5" aria-hidden />
              </span>
              <Badge className="border-background/20 bg-background/10 text-background hover:bg-background/10">
                GitHub
              </Badge>
            </div>
            <DialogHeader className="space-y-2 text-left">
              <DialogTitle className="text-xl leading-tight text-background">
                {t("marketplace.account.dialogTitle")}
              </DialogTitle>
              <DialogDescription className="max-w-[46ch] text-background/75">
                {t("marketplace.account.dialogDescription")}
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:px-6">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="rounded-lg border bg-card shadow-sm">
              <div className="flex items-start gap-4 p-5">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Loader2 className="size-5 animate-spin" aria-hidden />
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">
                    {prompt
                      ? t("marketplace.account.browserReady")
                      : t("marketplace.account.preparing")}
                  </p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {t("marketplace.account.waiting")}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <LoginStep
                index="1"
                title={t("marketplace.account.stepBrowser")}
                active={Boolean(prompt) && busy}
              />
              <LoginStep
                index="2"
                title={t("marketplace.account.stepConnect")}
                active={!busy && !error}
              />
            </div>

            <div className="flex items-start gap-3 rounded-md border bg-muted/30 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ShieldCheck className="size-4" aria-hidden />
              </span>
              <p className="text-sm leading-6 text-muted-foreground">
                {t("marketplace.account.secureHint")}
              </p>
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t bg-muted/30 px-5 py-3 sm:px-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("marketplace.account.close")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function LoginStep({ index, title, active }: { index: string; title: string; active: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground",
        active && "border-primary/40 bg-primary/5 text-foreground"
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium",
          active && "bg-primary text-primary-foreground"
        )}
      >
        {index}
      </span>
      <span className="min-w-0 truncate">{title}</span>
    </div>
  )
}

function normalizeLoginPrompt(prompt: MarketplaceLoginPrompt): MarketplaceLoginPrompt {
  const value = prompt as MarketplaceLoginPrompt & {
    verification_uri?: unknown
    user_code?: unknown
    expires_at?: unknown
  }
  return {
    verificationUri: stringOrEmpty(value.verificationUri) || stringOrEmpty(value.verification_uri),
    userCode: stringOrEmpty(value.userCode) || stringOrEmpty(value.user_code),
    expiresAt: stringOrEmpty(value.expiresAt) || stringOrEmpty(value.expires_at),
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function accountInitial(user: NonNullable<MarketplaceAccount["user"]>): string {
  return (user.displayName.trim() || user.handle.trim()).slice(0, 1).toUpperCase() || "?"
}

function ReviewQueue({
  reports,
  loading,
  pending,
  onResolve,
  onOpen,
}: {
  reports: MarketplaceReport[]
  loading: boolean
  pending: string | null
  onResolve: (report: MarketplaceReport, status: "reviewed" | "dismissed") => void
  onOpen: (pluginId: string) => void
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("marketplace.review.title")}</CardTitle>
        <CardDescription>{t("marketplace.review.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">{t("marketplace.loading")}</p>
        ) : reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("marketplace.review.empty")}</p>
        ) : (
          <ul className="divide-y">
            {reports.map((report) => (
              <li key={report.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="truncate font-mono text-sm hover:underline"
                      onClick={() => onOpen(report.pluginId)}
                    >
                      {report.pluginId}
                    </button>
                    <Badge variant={report.kind === "auto" ? "destructive" : "secondary"}>
                      {t(`marketplace.review.kind.${report.kind}`)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{report.reason}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending === `report:${report.id}`}
                    onClick={() => onResolve(report, "reviewed")}
                  >
                    {t("marketplace.review.markReviewed")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending === `report:${report.id}`}
                    onClick={() => onResolve(report, "dismissed")}
                  >
                    {t("marketplace.review.dismiss")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function MarketplaceCard({
  entry,
  installed,
  locale,
  onOpen,
  actions,
}: {
  entry: MarketplaceSummary
  installed?: PluginRegistryEntry
  locale: string
  onOpen: () => void
  actions?: ReactNode
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
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </CardContent>
    </Card>
  )
}

function MarketplaceGrid({
  emptyText,
  entries,
  installed,
  loading,
  locale,
  onOpen,
  renderActions,
}: {
  emptyText: string
  entries: MarketplaceSummary[]
  installed: Map<string, PluginRegistryEntry>
  loading: boolean
  locale: string
  onOpen: (id: string) => void
  renderActions?: (entry: MarketplaceSummary) => ReactNode
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("marketplace.loading")}</CardTitle>
          <CardDescription>{t("marketplace.loadingHint")}</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="flex min-h-56 items-center justify-center gap-3 text-sm text-muted-foreground">
          <PackageSearch className="size-4" aria-hidden />
          {emptyText}
        </CardContent>
      </Card>
    )
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry) => (
        <MarketplaceCard
          key={entry.id}
          entry={entry}
          installed={installed.get(entry.id)}
          locale={locale}
          onOpen={() => onOpen(entry.id)}
          actions={renderActions?.(entry)}
        />
      ))}
    </div>
  )
}

function GovernanceActions({
  entry,
  pending,
  onToggleVisibility,
  onYank,
}: {
  entry: MarketplaceSummary
  pending: string | null
  onToggleVisibility: (entry: MarketplaceSummary) => Promise<void>
  onYank: (entry: MarketplaceSummary) => Promise<void>
}) {
  const { t } = useTranslation()
  const isPublic = entry.visibility === "public"
  return (
    <>
      <Badge variant={isPublic ? "default" : "secondary"}>
        {t(
          isPublic
            ? "marketplace.governance.visibilityPublic"
            : "marketplace.governance.visibilityPrivate"
        )}
      </Badge>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending === `visibility:${entry.id}`}
        onClick={() => void onToggleVisibility(entry)}
      >
        {isPublic ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
        {t(isPublic ? "marketplace.governance.makePrivate" : "marketplace.governance.makePublic")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!entry.latestVersion || pending === `yank:${entry.id}`}
        onClick={() => void onYank(entry)}
      >
        <TriangleAlert className="size-4" aria-hidden />
        {t("marketplace.governance.yank")}
      </Button>
    </>
  )
}

function PluginDetailDialog({
  pluginId,
  installed,
  locale,
  canRate,
  canReport,
  canInstall,
  onOpenChange,
  onInstalled,
}: {
  pluginId: string | null
  installed?: PluginRegistryEntry
  locale: string
  canRate: boolean
  canReport: boolean
  canInstall: boolean
  onOpenChange: (open: boolean) => void
  onInstalled: (plugin: PluginRegistryEntry) => void
}) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null)
  const [loading, setLoading] = useState(Boolean(pluginId))
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pluginId) return
    let active = true
    getMarketplaceDetail(pluginId)
      .then((result) => {
        if (!active) return
        setDetail(result)
        setError(null)
      })
      .catch((err) => active && setError(errorMessage(err)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [pluginId])

  const latest = detail ? latestVersion(detail) : undefined
  const manifest = latest?.manifestSnapshot
  const capabilities = (manifest?.capabilities ?? []).map((cap) => cap.id)
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

  async function rate(stars: number) {
    if (!detail) return
    try {
      const result = await rateMarketplacePlugin(detail.plugin.id, stars)
      setDetail((current) =>
        current
          ? {
              ...current,
              plugin: { ...current.plugin, stats: result.stats },
              myRating: result.rating,
            }
          : current
      )
      toast.success(t("marketplace.rate.thanks"))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  async function report() {
    if (!detail) return
    try {
      await reportMarketplacePlugin(
        detail.plugin.id,
        t("marketplace.governance.defaultReportReason")
      )
      toast.success(t("marketplace.governance.reported"))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const myStars = detail?.myRating?.stars ?? 0

  return (
    <Dialog open={Boolean(pluginId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        {loading || !detail ? (
          <DialogHeader>
            <DialogTitle>{t("marketplace.loading")}</DialogTitle>
            <DialogDescription>{t("marketplace.loadingHint")}</DialogDescription>
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
              {detail.plugin.stats.ratingCount > 0 && (
                <>
                  <span>·</span>
                  <span>
                    ★ {detail.plugin.stats.ratingAvg.toFixed(1)} ({detail.plugin.stats.ratingCount})
                  </span>
                </>
              )}
            </div>

            {canRate && <RatingControl myStars={myStars} onRate={rate} />}

            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
                {t("marketplace.detail.permissionsTitle")}
              </h3>
              {capabilities.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("marketplace.detail.permissionsNone")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {capabilities.map((capability) => (
                    <Badge key={capability} variant="secondary" className="font-mono font-normal">
                      {capability}
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
              {canReport && (
                <Button type="button" variant="outline" onClick={() => void report()}>
                  <TriangleAlert className="size-4" aria-hidden />
                  {t("marketplace.governance.report")}
                </Button>
              )}
              <Button
                type="button"
                disabled={installing || Boolean(installed) || !latest || !canInstall}
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

function RatingControl({
  myStars,
  onRate,
}: {
  myStars: number
  onRate: (stars: number) => Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  async function choose(stars: number) {
    setBusy(true)
    try {
      await onRate(stars)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">{t("marketplace.rate.label")}</span>
      <div className="flex items-center">
        {[1, 2, 3, 4, 5].map((stars) => (
          <button
            key={stars}
            type="button"
            disabled={busy}
            aria-label={t("marketplace.rate.star", { stars })}
            className="px-0.5 text-lg leading-none text-amber-500 disabled:opacity-50"
            onClick={() => void choose(stars)}
          >
            {stars <= myStars ? "★" : "☆"}
          </button>
        ))}
      </div>
    </div>
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
