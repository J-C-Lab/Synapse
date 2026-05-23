import type { NavId } from "../app-shell"
import { Search, Settings as SettingsIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function AppLauncherPage({ onNavigate }: { onNavigate: (id: NavId) => void }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("appLauncher.feature.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("appLauncher.feature.subtitle")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4 text-primary" aria-hidden />
            {t("appLauncher.feature.aboutTitle")}
          </CardTitle>
          <CardDescription>{t("appLauncher.feature.aboutBody")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => onNavigate("settings")}>
            <SettingsIcon className="size-3.5" aria-hidden />
            {t("appLauncher.feature.openSettings")}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
