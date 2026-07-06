import type { CredentialConnectPrompt, PluginCredentialRow } from "@/lib/electron"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PluginCredentialConnectDialog } from "@/components/plugins/plugin-credential-connect-dialog"
import { localize } from "@/components/plugins/view-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  connectPluginCredential,
  disconnectPluginCredential,
  ElectronIpcError,
  listPluginCredentials,
  onCredentialConnectPrompt,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

export function PluginCredentialsPanel({
  className,
  emptyLabel,
  locale,
  pluginId,
}: {
  className?: string
  emptyLabel?: string
  locale: string
  pluginId: string
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<PluginCredentialRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [connectDialogOpen, setConnectDialogOpen] = useState(false)
  const [connectPrompt, setConnectPrompt] = useState<CredentialConnectPrompt | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await listPluginCredentials(pluginId))
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [pluginId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () =>
      onCredentialConnectPrompt((nextPrompt) => {
        if (nextPrompt.pluginId !== pluginId) return
        setConnectPrompt(nextPrompt)
        setConnectDialogOpen(true)
      }),
    [pluginId]
  )

  async function onConnect(row: PluginCredentialRow) {
    if (row.type === "oauth2-pkce") {
      setConnectDialogOpen(true)
      setConnectPrompt(null)
      setConnectError(null)
    }
    setBusy(row.id)
    try {
      await connectPluginCredential(pluginId, row.id)
      toast.success(t("plugins.credentials.connected"))
      setConnectDialogOpen(false)
      setConnectPrompt(null)
      await load()
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      if (row.type === "oauth2-pkce") {
        setConnectError(message)
      } else {
        toast.error(message)
      }
    } finally {
      setBusy(null)
    }
  }

  async function onDisconnect(credentialId: string) {
    setBusy(credentialId)
    try {
      await disconnectPluginCredential(pluginId, credentialId)
      toast.success(t("plugins.credentials.disconnected"))
      await load()
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return <p className={cn("text-xs text-muted-foreground", className)}>{t("plugins.loading")}</p>
  }

  if (rows.length === 0) {
    return emptyLabel ? (
      <Badge variant="outline" className={cn("font-normal text-muted-foreground", className)}>
        {emptyLabel}
      </Badge>
    ) : null
  }

  const oauthBusy =
    busy !== null && rows.some((row) => row.id === busy && row.type === "oauth2-pkce")

  return (
    <>
      <div className={cn("space-y-2", className)}>
        {rows.map((row) => {
          const showConnect =
            (row.type === "static" || row.type === "oauth2-pkce") &&
            (row.status !== "connected" || row.pendingConnect)
          return (
            <div
              key={row.id}
              data-testid="credential-row"
              className="flex flex-col gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium">{localize(row.label, locale)}</span>
                <Badge variant="outline" className="font-normal capitalize">
                  {row.type === "oauth2-pkce"
                    ? t("plugins.credentials.type.oauth")
                    : t("plugins.credentials.type.static")}
                </Badge>
                <Badge
                  variant={row.status === "connected" ? "default" : "secondary"}
                  className="font-normal"
                >
                  {t(`plugins.credentials.status.${row.status}`)}
                </Badge>
              </div>
              {row.injectSummary ? (
                <p className="text-xs text-muted-foreground">{row.injectSummary}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {showConnect ? (
                  <Button
                    variant="default"
                    size="sm"
                    disabled={busy === row.id}
                    onClick={() => void onConnect(row)}
                  >
                    {row.status === "connected" && row.pendingConnect
                      ? t("plugins.credentials.reconnect")
                      : row.status === "needs-reconnect"
                        ? t("plugins.credentials.reconnect")
                        : t("plugins.credentials.connect")}
                  </Button>
                ) : null}
                {row.status === "connected" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === row.id}
                    onClick={() => void onDisconnect(row.id)}
                  >
                    {t("plugins.credentials.disconnectAccount")}
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      <PluginCredentialConnectDialog
        open={connectDialogOpen}
        busy={oauthBusy}
        prompt={connectPrompt}
        error={connectError}
        pluginId={pluginId}
        onOpenChange={setConnectDialogOpen}
      />
    </>
  )
}
