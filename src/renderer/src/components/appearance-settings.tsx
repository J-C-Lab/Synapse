import { Monitor, Moon, Palette, Sun } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useTheme } from "@/hooks/use-theme"
import { cn } from "@/lib/utils"

const ACCENTS: { id: DeskitThemeAccent; swatchClass: string }[] = [
  // Hard-coded swatches so the picker always shows the palette options
  // regardless of which accent is currently active on :root.
  { id: "neutral", swatchClass: "bg-zinc-900 dark:bg-zinc-100" },
  { id: "blue", swatchClass: "bg-[oklch(0.55_0.20_254)] dark:bg-[oklch(0.70_0.18_254)]" },
  { id: "green", swatchClass: "bg-[oklch(0.55_0.18_152)] dark:bg-[oklch(0.72_0.17_152)]" },
  { id: "rose", swatchClass: "bg-[oklch(0.60_0.22_16)] dark:bg-[oklch(0.72_0.20_16)]" },
  { id: "violet", swatchClass: "bg-[oklch(0.55_0.24_295)] dark:bg-[oklch(0.72_0.21_295)]" },
]

const MODE_ICONS: Record<DeskitThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}

export function AppearanceSettings() {
  const { t } = useTranslation()
  const { themeMode, accent, setThemeMode, setAccent } = useTheme()

  const modes: DeskitThemeMode[] = ["light", "dark", "system"]

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Palette className="size-4 text-primary" aria-hidden />
          {t("appearance.title")}
        </CardTitle>
        <CardDescription>{t("appearance.subtitle")}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("appearance.mode")}</span>
          <ButtonGroup>
            {modes.map((m) => {
              const Icon = MODE_ICONS[m]
              const active = themeMode === m
              return (
                <Button
                  key={m}
                  type="button"
                  variant={active ? "default" : "outline"}
                  size="sm"
                  onClick={() => setThemeMode(m)}
                  aria-pressed={active}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {t(`appearance.mode.${m}`)}
                </Button>
              )
            })}
          </ButtonGroup>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("appearance.accent")}</span>
          <div className="flex flex-wrap items-center gap-3">
            {ACCENTS.map(({ id, swatchClass }) => {
              const active = accent === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setAccent(id)}
                  aria-label={t(`appearance.accent.${id}`)}
                  aria-pressed={active}
                  className={cn(
                    "relative size-7 cursor-pointer rounded-full border border-border/60 transition-transform",
                    "hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    active && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                    swatchClass
                  )}
                />
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
