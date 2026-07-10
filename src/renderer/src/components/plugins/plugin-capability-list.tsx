import type { PluginCapabilityRow } from "@/lib/electron"
import { Info } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { invalidateCapabilityProfileCache } from "@/hooks/use-capability-profile"
import {
  ElectronIpcError,
  getMcpNonReadOnlyExposed,
  listPluginCapabilities,
  revokePluginCapability,
  setExternalMcpPreauthorized,
  setMcpNonReadOnlyExposed,
} from "@/lib/electron"
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
  const [togglingPreauth, setTogglingPreauth] = useState<string | null>(null)
  const [exposed, setExposed] = useState(false)
  const [togglingExposure, setTogglingExposure] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rowsNow, exposedNow] = await Promise.all([
        listPluginCapabilities(pluginId),
        getMcpNonReadOnlyExposed(pluginId),
      ])
      setRows(rowsNow)
      setExposed(exposedNow)
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
      invalidateCapabilityProfileCache(pluginId)
      toast.success(t("plugins.capabilities.revoked"))
      await load()
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
    } finally {
      setRevoking(null)
    }
  }

  async function onTogglePreauthorized(capability: string, next: boolean) {
    setTogglingPreauth(capability)
    try {
      await setExternalMcpPreauthorized(pluginId, capability, next)
      await load()
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
    } finally {
      setTogglingPreauth(null)
    }
  }

  async function onToggleExposure(next: boolean) {
    setTogglingExposure(true)
    try {
      await setMcpNonReadOnlyExposed(pluginId, next)
      await load()
    } catch (err) {
      const message = err instanceof ElectronIpcError ? err.message : String(err)
      toast.error(message)
    } finally {
      setTogglingExposure(false)
    }
  }

  if (loading) {
    return <p className={cn("text-xs text-muted-foreground", className)}>{t("plugins.loading")}</p>
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2">
        <Switch
          role="switch"
          aria-label={t("plugins.mcpExposure.toggleLabel")}
          checked={exposed}
          disabled={togglingExposure}
          onCheckedChange={(checked) => void onToggleExposure(checked)}
        />
        <label className="text-xs text-muted-foreground">
          {t("plugins.mcpExposure.toggleLabel")}
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="size-3.5 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent>{t("plugins.mcpExposure.warning")}</TooltipContent>
        </Tooltip>
      </div>
      {rows.length === 0 ? (
        emptyLabel ? (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {emptyLabel}
          </Badge>
        ) : null
      ) : (
        rows.map((row) => (
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
            {row.granted && row.tier === "elevated" ? (
              <div className="flex w-full items-center gap-2 pt-1">
                <Switch
                  id={`preauth-${row.id}`}
                  role="switch"
                  aria-label={t("plugins.capabilities.preauthorizeToggle")}
                  checked={row.externalMcpPreauthorized}
                  disabled={togglingPreauth === row.id}
                  onCheckedChange={(checked) => void onTogglePreauthorized(row.id, checked)}
                />
                <label htmlFor={`preauth-${row.id}`} className="text-xs text-muted-foreground">
                  {t("plugins.capabilities.preauthorizeLabel")}
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>{t("plugins.capabilities.preauthorizeWarning")}</TooltipContent>
                </Tooltip>
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  )
}
