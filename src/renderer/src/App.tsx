import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { LauncherPanel } from "@/components/launcher-panel"
import { LauncherSettings } from "@/components/launcher-settings"
import { TooltipProvider } from "@/components/ui/tooltip"
import logoUrl from "../../../resources/logo.svg"

function isLauncherRoute(): boolean {
  if (typeof window === "undefined") return false
  return window.location.hash === "#search" || window.location.hash === "#launcher"
}

export function App() {
  const { t } = useTranslation()
  const [launcherRoute, setLauncherRoute] = useState(isLauncherRoute)

  // The same renderer bundle is loaded into two windows that differ only
  // by hash. We honour navigation changes so a `loadURL` swap re-renders
  // into the right shell.
  useEffect(() => {
    const onHashChange = (): void => setLauncherRoute(isLauncherRoute())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  if (launcherRoute) {
    return (
      <TooltipProvider>
        <LauncherPanel />
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background font-sans text-foreground">
        <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-16">
          <header className="flex items-center gap-4">
            <img src={logoUrl} alt="" className="size-12 shrink-0" aria-hidden />
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight">{t("app.title")}</h1>
              <p className="text-sm text-muted-foreground">{t("app.subtitle")}</p>
            </div>
          </header>

          <LauncherSettings />
        </main>
      </div>
    </TooltipProvider>
  )
}
