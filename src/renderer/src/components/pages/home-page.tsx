import type { NavId } from "../app-shell"
import { Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { CortexQuickEntryCard } from "@/components/home/cortex-quick-entry-card"
import { FrequentAppsCard } from "@/components/home/frequent-apps-card"
import { PluginsStatusCard } from "@/components/home/plugins-status-card"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function HomePage({
  onNavigate,
}: {
  onNavigate: (id: NavId, conversationId?: string) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">{t("app.title")}</h1>
        <p className="text-pretty text-sm text-muted-foreground">{t("app.subtitle")}</p>
      </header>

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" aria-hidden />
            {t("home.recommendations.title")}
          </CardTitle>
          <CardDescription>{t("home.recommendations.placeholder")}</CardDescription>
        </CardHeader>
      </Card>

      <CortexQuickEntryCard onOpenCortex={(id) => onNavigate("cortex", id)} />

      <div className="grid items-start gap-4 md:grid-cols-2">
        <FrequentAppsCard />
        <PluginsStatusCard onNavigate={onNavigate} />
      </div>
    </div>
  )
}
