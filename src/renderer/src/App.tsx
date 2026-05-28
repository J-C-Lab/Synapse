import { useEffect, useState } from "react"
import { AppShell } from "@/components/app-shell"
import { FloatingBallPanel } from "@/components/floating-ball-panel"
import { LauncherPanel } from "@/components/launcher-panel"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeProvider } from "@/hooks/use-theme"

type RendererRoute = "shell" | "launcher" | "floating-ball"

function isLauncherRoute(): boolean {
  if (typeof window === "undefined") return false
  return window.location.hash === "#search" || window.location.hash === "#launcher"
}

function getRendererRoute(): RendererRoute {
  if (typeof window === "undefined") return "shell"
  if (window.location.hash === "#floating-ball") return "floating-ball"
  return isLauncherRoute() ? "launcher" : "shell"
}

export function App() {
  const [route, setRoute] = useState<RendererRoute>(getRendererRoute)

  // The same renderer bundle is loaded into two windows that differ only
  // by hash. We honour navigation changes so a `loadURL` swap re-renders
  // into the right shell.
  useEffect(() => {
    const onHashChange = (): void => setRoute(getRendererRoute())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  return (
    <ThemeProvider>
      <TooltipProvider>
        {route === "launcher" ? (
          <LauncherPanel />
        ) : route === "floating-ball" ? (
          <FloatingBallPanel />
        ) : (
          <div className="h-screen bg-background font-sans text-foreground">
            <AppShell />
          </div>
        )}
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  )
}
