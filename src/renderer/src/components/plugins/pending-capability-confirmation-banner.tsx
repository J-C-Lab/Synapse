import type { PendingTriggerCapabilityConfirmation } from "@/lib/electron"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { confirmTriggerCapabilities, listPendingTriggerCapabilities } from "@/lib/electron"

export function PendingCapabilityConfirmationBanner() {
  const { t } = useTranslation()
  const [pending, setPending] = useState<PendingTriggerCapabilityConfirmation[]>([])

  async function refresh() {
    setPending(await listPendingTriggerCapabilities())
  }

  useEffect(() => {
    void refresh()
  }, [])

  if (pending.length === 0) return null

  return (
    <>
      {pending.map((entry) => (
        <Alert key={entry.pluginId}>
          <AlertTitle>{t("plugins.triggers.pendingCapabilityTitle")}</AlertTitle>
          <AlertDescription>
            {t("plugins.triggers.pendingCapabilityBody", {
              plugin: entry.pluginId,
              capabilities: entry.capabilities.map((c) => c.capabilityId).join(", "),
            })}
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                void confirmTriggerCapabilities(
                  entry.pluginId,
                  entry.capabilities.map((c) => c.capabilityId)
                ).then(() => refresh())
              }}
            >
              {t("plugins.triggers.pendingCapabilityConfirm")}
            </Button>
          </AlertDescription>
        </Alert>
      ))}
    </>
  )
}
