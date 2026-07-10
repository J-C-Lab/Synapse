import type { PluginTriggerRow, TriggerInstanceRow } from "@/lib/electron"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  createTriggerInstance,
  ElectronIpcError,
  killTrigger,
  listAiWorkspaces,
  listTriggerInstances,
  listTriggers,
  pauseTrigger,
  pauseTriggerInstance,
  reactivateTriggerInstance,
  removeTriggerInstance,
  resumeTrigger,
  resumeTriggerInstance,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "faulted" || status === "budget-exhausted" || status === "failed") {
    return "destructive"
  }
  if (status === "throttled" || status === "paused") return "secondary"
  return "outline"
}

function AgentTriggerRow({ row }: { row: PluginTriggerRow }) {
  const { t } = useTranslation()
  const [instances, setInstances] = useState<TriggerInstanceRow[]>([])
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setInstances(await listTriggerInstances(row.pluginId, row.triggerId))
  }, [row.pluginId, row.triggerId])

  useEffect(() => {
    void load()
    void listAiWorkspaces().then(setWorkspaces)
  }, [load])

  async function act(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    try {
      await fn()
      await load()
    } catch (err) {
      toast.error(err instanceof ElectronIpcError ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      data-testid="trigger-row"
      className="flex flex-col gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium">
          {t(`plugins.triggers.typeLabel.${row.type}`, { defaultValue: row.type })}
        </span>
        <select
          className="rounded border bg-transparent px-2 py-1 text-xs"
          onChange={(e) => {
            if (e.target.value) {
              void act("add", () =>
                createTriggerInstance(row.pluginId, row.triggerId, e.target.value)
              )
            }
          }}
          value=""
        >
          <option value="">{t("plugins.triggers.addToWorkspace")}</option>
          {workspaces
            .filter((w) => !instances.some((i) => i.workspaceId === w.id))
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
        </select>
      </div>
      {instances.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("plugins.triggers.noInstances")}</p>
      ) : (
        instances.map((instance) => (
          <div
            key={instance.id}
            className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-2 text-xs"
          >
            <span className="min-w-0 flex-1">{instance.workspaceName}</span>
            <Badge
              variant={instance.stale ? "destructive" : statusVariant(instance.status)}
              className="font-normal capitalize"
            >
              {instance.stale
                ? t("plugins.triggers.needsReview")
                : t(`plugins.triggers.status.${instance.status}`, {
                    defaultValue: instance.status,
                  })}
            </Badge>
            {instance.budgets.map((budget) => (
              <span key={budget.capabilityId} className="text-muted-foreground">
                {t("plugins.triggers.budgetUsage", {
                  capability: t(`permissions.items.${budget.capabilityId}`, {
                    defaultValue: budget.capabilityId,
                    nsSeparator: false,
                  }),
                  used: budget.used,
                  max: budget.max,
                })}
              </span>
            ))}
            {instance.stale ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy === instance.id}
                onClick={() => act(instance.id, () => reactivateTriggerInstance(instance.id))}
              >
                {t("plugins.triggers.reactivate")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy === instance.id}
                onClick={() =>
                  act(instance.id, () =>
                    instance.paused
                      ? resumeTriggerInstance(instance.id)
                      : pauseTriggerInstance(instance.id)
                  )
                }
              >
                {t(instance.paused ? "plugins.triggers.resume" : "plugins.triggers.pause")}
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={busy === instance.id}
              onClick={() => act(instance.id, () => removeTriggerInstance(instance.id))}
            >
              {t("plugins.triggers.remove")}
            </Button>
          </div>
        ))
      )}
    </div>
  )
}

export function ActiveBackgroundPanel({
  className,
  emptyLabel,
  pluginId,
}: {
  className?: string
  emptyLabel?: string
  pluginId?: string
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<PluginTriggerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const all = await listTriggers()
      setRows(pluginId ? all.filter((row) => row.pluginId === pluginId) : all)
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

  async function act(key: string, fn: () => Promise<void>, successKey: string): Promise<void> {
    setBusy(key)
    try {
      await fn()
      toast.success(t(successKey))
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

  return (
    <div className={cn("space-y-2", className)}>
      {rows.map((row) => {
        if (row.isAgentTrigger) {
          return <AgentTriggerRow key={`${row.pluginId}:${row.triggerId}`} row={row} />
        }
        const rowKey = `${row.pluginId}:${row.triggerId}`
        return (
          <div
            key={rowKey}
            data-testid="trigger-row"
            className="flex flex-col gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 font-medium">
                {t(`plugins.triggers.typeLabel.${row.type}`, { defaultValue: row.type })}
              </span>
              <Badge variant={statusVariant(row.status)} className="font-normal capitalize">
                {t(`plugins.triggers.status.${row.status}`, { defaultValue: row.status })}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {row.budgets.map((budget) => (
                <span key={budget.capabilityId}>
                  {t("plugins.triggers.budgetUsage", {
                    capability: t(`permissions.items.${budget.capabilityId}`, {
                      defaultValue: budget.capabilityId,
                      nsSeparator: false,
                    }),
                    used: budget.used,
                    max: budget.max,
                  })}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === `${rowKey}:pause`}
                onClick={() =>
                  act(
                    `${rowKey}:pause`,
                    () => pauseTrigger(row.pluginId, row.triggerId),
                    "plugins.triggers.paused"
                  )
                }
              >
                {t("plugins.triggers.pause")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === `${rowKey}:resume`}
                onClick={() =>
                  act(
                    `${rowKey}:resume`,
                    () => resumeTrigger(row.pluginId, row.triggerId),
                    "plugins.triggers.resumed"
                  )
                }
              >
                {t("plugins.triggers.resume")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy === `${rowKey}:kill`}
                onClick={() =>
                  act(
                    `${rowKey}:kill`,
                    () => killTrigger(row.pluginId, row.triggerId),
                    "plugins.triggers.killed"
                  )
                }
              >
                {t("plugins.triggers.kill")}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
