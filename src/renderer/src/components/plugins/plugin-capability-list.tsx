import type { PluginCapabilityRow } from "@/lib/electron"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ElectronIpcError, listPluginCapabilities, revokePluginCapability } from "@/lib/electron"
import { cn } from "@/lib/utils"

export function PluginCapabilityList({
  className,
  emptyLabel,
  pluginId,
}: {
  className?: string
  emptyLabel?: string
  pluginId: string
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<PluginCapabilityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await listPluginCapabilities(pluginId))
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

  async function onRevoke(capability: string) {
    setRevoking(capability)
    try {
      await revokePluginCapability(pluginId, capability)
      toast.success(t("plugins.capabilities.revoked"))
      await load()
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
    } finally {
      setRevoking(null)
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

  return (
    <div className={cn("space-y-2", className)}>
      {rows.map((row) => (
        <div
          key={row.id}
          data-testid="capability-row"
          className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1 font-medium" title={row.id}>
            {t(`permissions.items.${row.id}`, { defaultValue: row.id, nsSeparator: false })}
          </span>
          <Badge variant="outline" className="font-normal capitalize">
            {t(`plugins.capabilities.tier.${row.tier}`, { defaultValue: row.tier })}
          </Badge>
          <Badge
            variant={row.tier === "auto" || row.granted ? "default" : "secondary"}
            className="font-normal"
          >
            {row.tier === "auto"
              ? t("plugins.capabilities.alwaysAllowed")
              : row.granted
                ? t("plugins.capabilities.granted")
                : t("plugins.capabilities.notGranted")}
          </Badge>
          {row.granted && row.tier !== "auto" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={revoking === row.id}
              onClick={() => void onRevoke(row.id)}
            >
              {t("plugins.capabilities.revoke")}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
