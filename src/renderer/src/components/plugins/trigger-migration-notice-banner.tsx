import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { dismissTriggerMigrationNotice, getTriggerMigrationNotice } from "@/lib/electron"

export function TriggerMigrationNoticeBanner() {
  const { t } = useTranslation()
  const [affected, setAffected] = useState<Array<{ pluginId: string; triggerId: string }>>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void getTriggerMigrationNotice().then((state) => {
      setAffected(state.affectedTriggers)
      setDismissed(state.dismissedAt !== undefined)
    })
  }, [])

  if (dismissed || affected.length === 0) return null

  return (
    <Alert>
      <AlertTitle>{t("plugins.triggers.migrationNoticeTitle")}</AlertTitle>
      <AlertDescription>
        {t("plugins.triggers.migrationNoticeBody", {
          triggers: affected.map((a) => `${a.pluginId}/${a.triggerId}`).join(", "),
        })}
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => {
            void dismissTriggerMigrationNotice()
            setDismissed(true)
          }}
        >
          {t("plugins.triggers.migrationNoticeDismiss")}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
