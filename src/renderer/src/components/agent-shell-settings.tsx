import { Terminal } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { getSettings, isElectron, onSettingsChanged, updateSettings } from "@/lib/electron"

export function AgentShellSettings() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    if (!isElectron()) return
    void getSettings().then((settings) => setEnabled(settings.allowAgentShell))
    return onSettingsChanged((settings) => setEnabled(settings.allowAgentShell))
  }, [])

  async function setAllowAgentShell(next: boolean) {
    setEnabled(next)
    if (isElectron()) {
      const settings = await updateSettings({ allowAgentShell: next })
      setEnabled(settings.allowAgentShell)
    }
  }

  if (!isElectron()) return null

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Terminal className="size-4 text-primary" aria-hidden />
          {t("settings.agentShell.title")}
        </CardTitle>
        <CardDescription>{t("settings.agentShell.description")}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">{t("settings.agentShell.title")}</span>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => void setAllowAgentShell(checked)}
            aria-label={t("settings.agentShell.title")}
          />
        </div>
        {enabled ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.agentShell.rootsMovedNotice")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
