import type { UpdateState } from "@/lib/electron"
import { Download, RefreshCw, X } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  downloadUpdate,
  getUpdateStatus,
  installUpdate,
  isElectron,
  onUpdateEvent,
} from "@/lib/electron"

// A thin banner that surfaces the auto-update lifecycle. The flow is manual:
// when an update is available the user clicks Download, and when it is ready
// they click Restart — the app never restarts itself under them. Hidden for the
// idle/checking/not-available/error states to stay out of the way.

export function UpdateBanner() {
  const { t } = useTranslation()
  const [state, setState] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!isElectron()) return
    let active = true
    void getUpdateStatus().then((next) => {
      if (active) setState(next)
    })
    const off = onUpdateEvent((next) => {
      setState(next)
      setDismissed(false)
    })
    return () => {
      active = false
      off()
    }
  }, [])

  if (!state || dismissed) return null

  if (state.status === "available") {
    return (
      <Banner
        icon={<Download className="size-4" />}
        message={t("updates.available", { version: state.version })}
        action={
          <Button size="sm" onClick={() => void downloadUpdate()}>
            {t("updates.download")}
          </Button>
        }
        onDismiss={() => setDismissed(true)}
        dismissLabel={t("updates.dismiss")}
      />
    )
  }

  if (state.status === "downloading") {
    return (
      <Banner
        icon={<Download className="size-4 animate-pulse" />}
        message={t("updates.downloading", { percent: state.percent ?? 0 })}
      />
    )
  }

  if (state.status === "downloaded") {
    return (
      <Banner
        icon={<RefreshCw className="size-4" />}
        message={t("updates.ready", { version: state.version })}
        action={
          <Button size="sm" onClick={() => void installUpdate()}>
            {t("updates.restart")}
          </Button>
        }
        onDismiss={() => setDismissed(true)}
        dismissLabel={t("updates.dismiss")}
      />
    )
  }

  return null
}

function Banner({
  icon,
  message,
  action,
  onDismiss,
  dismissLabel,
}: {
  icon: React.ReactNode
  message: string
  action?: React.ReactNode
  onDismiss?: () => void
  dismissLabel?: string
}) {
  return (
    <div className="flex items-center gap-3 border-b bg-primary/10 px-4 py-2 text-sm">
      <span className="text-primary">{icon}</span>
      <span className="flex-1">{message}</span>
      {action}
      {onDismiss && (
        <Button variant="ghost" size="icon" className="size-7" onClick={onDismiss}>
          <X className="size-4" />
          <span className="sr-only">{dismissLabel}</span>
        </Button>
      )}
    </div>
  )
}
