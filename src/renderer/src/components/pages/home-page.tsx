import type { NavId } from "../app-shell"
import { RefreshCw, Settings as SettingsIcon, Sparkles } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { isElectron, refreshApps } from "@/lib/electron"
import logoUrl from "../../../../../resources/logo.svg"

export function HomePage({ onNavigate }: { onNavigate: (id: NavId) => void }) {
  const { t } = useTranslation()
  const [rescanning, setRescanning] = useState(false)

  async function onRescan() {
    if (!isElectron()) return
    setRescanning(true)
    try {
      await refreshApps()
    } finally {
      setRescanning(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-4">
        <img src={logoUrl} alt="" className="size-12 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("app.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("app.subtitle")}</p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" aria-hidden />
            {t("home.quickActions")}
          </CardTitle>
          <CardDescription>{t("home.quickActionsHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button onClick={onRescan} disabled={rescanning || !isElectron()}>
              <RefreshCw className={`size-3.5 ${rescanning ? "animate-spin" : ""}`} aria-hidden />
              {rescanning ? t("launcher.settings.rescanning") : t("home.rescan")}
            </Button>
            <Button variant="outline" onClick={() => onNavigate("settings")}>
              <SettingsIcon className="size-3.5" aria-hidden />
              {t("home.openSettings")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
