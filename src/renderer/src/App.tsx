import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ElectronDemo } from "@/components/electron-demo"
import { LauncherPanel } from "@/components/launcher-panel"
import { LauncherSettings } from "@/components/launcher-settings"
import { TooltipProvider } from "@/components/ui/tooltip"

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
      <div className="flex min-h-screen flex-col items-center justify-center bg-background text-foreground font-sans">
        <main className="flex w-full max-w-3xl flex-col items-center gap-8 px-8 py-16 sm:items-start">
          <h1 className="text-3xl font-semibold tracking-tight">{t("app.title")}</h1>
          <p className="max-w-md text-base text-muted-foreground">{t("app.subtitle")}</p>
          <LauncherSettings />
          <ElectronDemo />
        </main>
      </div>
    </TooltipProvider>
  )
}
