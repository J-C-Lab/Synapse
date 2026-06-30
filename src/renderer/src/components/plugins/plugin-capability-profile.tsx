import type { PluginCapabilityProfile, ProfileLine } from "@/lib/electron"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const RISK_VARIANT: Record<PluginCapabilityProfile["riskLevel"], string> = {
  low: "bg-emerald-500/15 text-emerald-600",
  medium: "bg-amber-500/15 text-amber-600",
  high: "bg-red-500/15 text-red-600",
}

export function PluginCapabilityProfileCard({
  className,
  profile,
}: {
  className?: string
  profile: PluginCapabilityProfile
}) {
  const { t } = useTranslation()
  const line = (item: ProfileLine): string =>
    String(t(item.code, { defaultValue: item.code, nsSeparator: false, ...item.params }))
  const hasGrantView = profile.grantedSurfaces !== undefined
  const grantLag =
    hasGrantView &&
    (Object.keys(profile.surfaces) as (keyof typeof profile.surfaces)[]).some(
      (key) => profile.surfaces[key] && !profile.grantedSurfaces![key]
    )

  return (
    <div className={cn("space-y-3 rounded-md border border-border/60 p-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {t("profile.title", { defaultValue: "Capabilities" })}
        </span>
        <Badge
          data-testid="profile-risk"
          className={cn("font-normal capitalize", RISK_VARIANT[profile.riskLevel])}
        >
          {t(`profile.risk.${profile.riskLevel}`, { defaultValue: profile.riskLevel })}
        </Badge>
        {grantLag ? (
          <Badge variant="outline" className="font-normal" data-testid="profile-grant-lag">
            {t("profile.grant.partial", { defaultValue: "Partially granted" })}
          </Badge>
        ) : null}
        {hasGrantView && !grantLag && profile.grantedSurfaces ? (
          <Badge
            variant="outline"
            className="border-emerald-500/40 font-normal text-emerald-600"
            data-testid="profile-grant-full"
          >
            {t("profile.grant.active", { defaultValue: "Granted" })}
          </Badge>
        ) : null}
      </div>

      {profile.summaries.length > 0 ? (
        <ul data-testid="profile-summaries" className="space-y-1 text-sm text-muted-foreground">
          {profile.summaries.map((item) => (
            <li key={item.code}>{line(item)}</li>
          ))}
        </ul>
      ) : null}

      {profile.warnings.length > 0 ? (
        <ul data-testid="profile-warnings" className="space-y-1 text-sm text-amber-600">
          {profile.warnings.map((item) => (
            <li key={item.code}>⚠ {line(item)}</li>
          ))}
        </ul>
      ) : null}

      {profile.controls.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {profile.controls.map((control) => (
            <Badge key={control} variant="outline" className="font-normal">
              {t(`profile.control.${control}`, { defaultValue: control })}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
