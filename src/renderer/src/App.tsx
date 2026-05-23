import { useEffect, useState } from "react"
import { AppShell } from "@/components/app-shell"
import { LauncherPanel } from "@/components/launcher-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeProvider } from "@/hooks/use-theme"

function isLauncherRoute(): boolean {
  if (typeof window === "undefined") return false
  return window.location.hash === "#search" || window.location.hash === "#launcher"
}

export function App() {
  const [launcherRoute, setLauncherRoute] = useState(isLauncherRoute)

  // The same renderer bundle is loaded into two windows that differ only
  // by hash. We honour navigation changes so a `loadURL` swap re-renders
  // into the right shell.
  useEffect(() => {
    const onHashChange = (): void => setLauncherRoute(isLauncherRoute())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  return (
    <ThemeProvider>
      <TooltipProvider>
        {launcherRoute ? (
          <LauncherPanel />
        ) : (
          <div className="h-screen bg-background font-sans text-foreground">
            <AppShell />
          </div>
        )}
      </TooltipProvider>
    </ThemeProvider>
  )
}
