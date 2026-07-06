import {
  Bot,
  CircleDot,
  House,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  Store,
  Wifi,
} from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import logoUrl from "@/assets/logo.png"
import { HomePage } from "@/components/pages/home-page"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { UpdateBanner } from "@/components/update-banner"
import { cn } from "@/lib/utils"

const ChatPage = lazy(() =>
  import("@/components/pages/chat-page").then((m) => ({ default: m.ChatPage }))
)
const SettingsPage = lazy(() =>
  import("@/components/pages/settings-page").then((m) => ({ default: m.SettingsPage }))
)
const AppLauncherPage = lazy(() =>
  import("@/components/pages/app-launcher-page").then((m) => ({ default: m.AppLauncherPage }))
)
const FloatingBallPage = lazy(() =>
  import("@/components/pages/floating-ball-page").then((m) => ({ default: m.FloatingBallPage }))
)
const PluginsPage = lazy(() =>
  import("@/components/pages/plugins-page").then((m) => ({ default: m.PluginsPage }))
)
const MarketplacePage = lazy(() =>
  import("@/components/pages/marketplace-page").then((m) => ({ default: m.MarketplacePage }))
)
const LanTransferPage = lazy(() =>
  import("@/components/pages/lan-transfer-page").then((m) => ({ default: m.LanTransferPage }))
)

export type NavId =
  | "home"
  | "assistant"
  | "settings"
  | "app-launcher"
  | "floating-ball"
  | "plugins"
  | "marketplace"
  | "lan-transfer"

const NAV_IDS = new Set<NavId>([
  "home",
  "assistant",
  "settings",
  "app-launcher",
  "floating-ball",
  "plugins",
  "marketplace",
  "lan-transfer",
])

function readNavFromLocation(): NavId {
  const raw = window.location.hash.replace(/^#\/?/, "")
  return NAV_IDS.has(raw as NavId) ? (raw as NavId) : "home"
}

function useNav(): [NavId, (id: NavId) => void] {
  const [nav, setNavState] = useState<NavId>(readNavFromLocation)

  const setNav = useCallback((id: NavId) => {
    setNavState(id)
    const nextHash = id === "home" ? "" : `#/${id}`
    if (window.location.hash !== nextHash) {
      const base = `${window.location.pathname}${window.location.search}`
      window.history.replaceState(null, "", id === "home" ? base : `${base}#/${id}`)
    }
  }, [])

  useEffect(() => {
    const onHashChange = () => setNavState(readNavFromLocation())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  return [nav, setNav]
}

export function AppShell() {
  const { t } = useTranslation()
  const [nav, setNav] = useNav()

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <img src={logoUrl} alt="" className="size-6 shrink-0" aria-hidden />
            <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
              {t("app.title")}
            </span>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "home"}
                    onClick={() => setNav("home")}
                    tooltip={t("nav.home")}
                  >
                    <House />
                    <span>{t("nav.home")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "assistant"}
                    onClick={() => setNav("assistant")}
                    tooltip={t("nav.assistant")}
                  >
                    <Bot />
                    <span>{t("nav.assistant")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "lan-transfer"}
                    onClick={() => setNav("lan-transfer")}
                    tooltip={t("nav.lanTransfer")}
                  >
                    <Wifi />
                    <span>{t("nav.lanTransfer")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "settings"}
                    onClick={() => setNav("settings")}
                    tooltip={t("nav.settings")}
                  >
                    <SettingsIcon />
                    <span>{t("nav.settings")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="mt-auto">
            <SidebarGroupLabel>{t("nav.features")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "app-launcher"}
                    onClick={() => setNav("app-launcher")}
                    tooltip={t("nav.appLauncher")}
                  >
                    <Search />
                    <span>{t("nav.appLauncher")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "floating-ball"}
                    onClick={() => setNav("floating-ball")}
                    tooltip={t("nav.floatingBall")}
                  >
                    <CircleDot />
                    <span>{t("nav.floatingBall")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "plugins"}
                    onClick={() => setNav("plugins")}
                    tooltip={t("nav.plugins")}
                  >
                    <Puzzle />
                    <span>{t("nav.plugins")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "marketplace"}
                    onClick={() => setNav("marketplace")}
                    tooltip={t("nav.marketplace")}
                  >
                    <Store />
                    <span>{t("nav.marketplace")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <span className="px-2 py-1 text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
            Synapse
          </span>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <UpdateBanner />
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <span className="text-sm font-medium">{t(`nav.${navKey(nav)}`)}</span>
        </header>
        <main
          className={cn(
            "flex-1",
            nav === "assistant"
              ? "flex min-h-0 flex-col overflow-hidden px-4 py-4"
              : "overflow-y-auto px-6 py-8"
          )}
        >
          <div
            className={cn(
              "mx-auto w-full",
              nav === "assistant"
                ? "flex min-h-0 flex-1 flex-col"
                : nav === "plugins" || nav === "marketplace" || nav === "lan-transfer"
                  ? "max-w-5xl"
                  : "max-w-3xl"
            )}
          >
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-24">
                  <Spinner className="size-6 text-muted-foreground" />
                </div>
              }
            >
              {nav === "home" && <HomePage onNavigate={setNav} />}
              {nav === "assistant" && <ChatPage />}
              {nav === "settings" && <SettingsPage />}
              {nav === "app-launcher" && <AppLauncherPage onNavigate={setNav} />}
              {nav === "floating-ball" && <FloatingBallPage onNavigate={setNav} />}
              {nav === "plugins" && <PluginsPage />}
              {nav === "marketplace" && <MarketplacePage />}
              {nav === "lan-transfer" && <LanTransferPage />}
            </Suspense>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

function navKey(id: NavId): string {
  switch (id) {
    case "home":
      return "home"
    case "assistant":
      return "assistant"
    case "settings":
      return "settings"
    case "app-launcher":
      return "appLauncher"
    case "floating-ball":
      return "floatingBall"
    case "plugins":
      return "plugins"
    case "marketplace":
      return "marketplace"
    case "lan-transfer":
      return "lanTransfer"
  }
}
