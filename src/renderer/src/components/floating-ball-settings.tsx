import { CircleDot, Search } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { getSettings, isElectron, onSettingsChanged, updateSettings } from "@/lib/electron"

const AVAILABLE_FLOATING_BALL_FEATURES: SynapseFloatingBallFeature[] = ["appLauncher"]

const FEATURE_ICONS: Record<SynapseFloatingBallFeature, typeof Search> = {
  appLauncher: Search,
}

export function FloatingBallSettings() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  const [features, setFeatures] = useState<SynapseFloatingBallFeature[]>(["appLauncher"])

  useEffect(() => {
    if (!isElectron()) return
    void getSettings().then((settings) => {
      setEnabled(settings.floatingBallEnabled)
      setFeatures(settings.floatingBallFeatures)
    })
    return onSettingsChanged((settings) => {
      setEnabled(settings.floatingBallEnabled)
      setFeatures(settings.floatingBallFeatures)
    })
  }, [])

  async function setFloatingBallEnabled(next: boolean) {
    setEnabled(next)
    if (isElectron()) {
      const settings = await updateSettings({ floatingBallEnabled: next })
      setEnabled(settings.floatingBallEnabled)
      setFeatures(settings.floatingBallFeatures)
    }
  }

  async function toggleFeature(feature: SynapseFloatingBallFeature, checked: boolean) {
    const next = checked
      ? [...features, feature]
      : features.filter((existing) => existing !== feature)
    const normalized = next.length > 0 ? next.slice(0, 6) : features
    setFeatures(normalized)
    if (isElectron()) {
      const settings = await updateSettings({ floatingBallFeatures: normalized })
      setEnabled(settings.floatingBallEnabled)
      setFeatures(settings.floatingBallFeatures)
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleDot className="size-4 text-primary" aria-hidden />
          {t("floatingBall.settings.title")}
        </CardTitle>
        <CardDescription>{t("floatingBall.settings.subtitle")}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">{t("floatingBall.settings.enable")}</span>
            <span className="text-xs text-muted-foreground">
              {t("floatingBall.settings.enableHint")}
            </span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => void setFloatingBallEnabled(checked)}
            aria-label={t("floatingBall.settings.enable")}
          />
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("floatingBall.settings.menuFeatures")}</span>
            <span className="text-xs text-muted-foreground">
              {t("floatingBall.settings.menuFeaturesHint")}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {AVAILABLE_FLOATING_BALL_FEATURES.map((feature) => {
              const Icon = FEATURE_ICONS[feature]
              const checked = features.includes(feature)
              return (
                <label
                  key={feature}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <Checkbox
                    checked={checked}
                    disabled={!enabled || (checked && features.length === 1)}
                    onCheckedChange={(value) => toggleFeature(feature, value === true)}
                  />
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  <span>{t(`floatingBall.features.${feature}`)}</span>
                </label>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
