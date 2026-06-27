import { useTranslation } from "react-i18next"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

export interface DeclaredTriggerUse {
  capability: string
  budget: { maxCalls: number; period: string }
  scope?: unknown
}

export interface DeclaredTrigger {
  id: string
  type: string
  handler: string
  uses: DeclaredTriggerUse[]
  scope?: { contentTypes?: string[]; paths?: string[]; events?: string[]; accelerator?: string }
  schedule?: { intervalMs: number } | string
}

export function DeclaredTriggersPanel({
  className,
  triggers,
}: {
  className?: string
  triggers: readonly DeclaredTrigger[]
}) {
  const { t } = useTranslation()
  if (triggers.length === 0) return null

  const hasClipboard = triggers.some((trigger) => trigger.type === "clipboard")
  const hasFsWatch = triggers.some((trigger) => trigger.type === "fs.watch")
  const hasHotkey = triggers.some((trigger) => trigger.type === "hotkey")

  return (
    <div className={cn("space-y-2", className)} data-testid="declared-triggers">
      {hasHotkey ? (
        <Alert variant="destructive">
          <AlertTitle>{t("plugins.triggers.hotkeyDisclosureTitle")}</AlertTitle>
          <AlertDescription>{t("plugins.triggers.hotkeyDisclosureBody")}</AlertDescription>
        </Alert>
      ) : null}
      {hasFsWatch ? (
        <Alert variant="destructive">
          <AlertTitle>{t("plugins.triggers.fsWatchDisclosureTitle")}</AlertTitle>
          <AlertDescription>{t("plugins.triggers.fsWatchDisclosureBody")}</AlertDescription>
        </Alert>
      ) : null}
      {hasClipboard ? (
        <Alert variant="destructive">
          <AlertTitle>{t("plugins.triggers.clipboardDisclosureTitle")}</AlertTitle>
          <AlertDescription>{t("plugins.triggers.clipboardDisclosureBody")}</AlertDescription>
        </Alert>
      ) : null}
      {triggers.map((trigger) => (
        <div
          key={trigger.id}
          className="rounded-md border border-border/60 px-3 py-2 text-sm"
          data-testid="declared-trigger-row"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {t(`plugins.triggers.typeLabel.${trigger.type}`, { defaultValue: trigger.type })}
            </span>
          </div>
          {trigger.type === "clipboard" && trigger.scope?.contentTypes?.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("plugins.triggers.contentTypes", {
                types: trigger.scope.contentTypes.join(", "),
              })}
            </p>
          ) : null}
          {trigger.type === "fs.watch" && trigger.scope?.paths?.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("plugins.triggers.watchPaths", { paths: trigger.scope.paths.join(", ") })}
            </p>
          ) : null}
          {trigger.type === "hotkey" && trigger.scope?.accelerator ? (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("plugins.triggers.hotkeyAccelerator", {
                  accelerator: trigger.scope.accelerator,
                })}
              </p>
              <p className="mt-1 text-xs font-medium text-destructive">
                {t("plugins.triggers.hotkeyCaptureWarning", {
                  accelerator: trigger.scope.accelerator,
                })}
              </p>
            </>
          ) : null}
          {(trigger.type === "timer" || trigger.type === "cron") && trigger.schedule ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("plugins.triggers.scheduleLine", {
                schedule:
                  typeof trigger.schedule === "string"
                    ? trigger.schedule
                    : `${trigger.schedule.intervalMs}ms`,
              })}
            </p>
          ) : null}
          <div className="mt-2 space-y-1">
            <p className="text-xs font-medium">{t("plugins.triggers.allowsTitle")}</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {trigger.uses.map((use) => (
                <li key={`${trigger.id}:${use.capability}`}>
                  {t("plugins.triggers.budgetLine", {
                    capability: t(`permissions.items.${use.capability}`, {
                      defaultValue: use.capability,
                      nsSeparator: false,
                    }),
                    max: use.budget.maxCalls,
                    period: t(`plugins.triggers.period.${use.budget.period}`, {
                      defaultValue: use.budget.period,
                    }),
                  })}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  )
}
