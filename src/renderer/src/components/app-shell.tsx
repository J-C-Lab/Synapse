import {
  CircleDot,
  House,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  Store,
  Wifi,
} from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import logoUrl from "@/assets/logo.svg"
import { AppLauncherPage } from "@/components/pages/app-launcher-page"
import { FloatingBallPage } from "@/components/pages/floating-ball-page"
import { HomePage } from "@/components/pages/home-page"
import { LanTransferPage } from "@/components/pages/lan-transfer-page"
import { MarketplacePage } from "@/components/pages/marketplace-page"
import { PluginsPage } from "@/components/pages/plugins-page"
import { SettingsPage } from "@/components/pages/settings-page"
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
import { cn } from "@/lib/utils"

export type NavId =
  | "home"
  | "settings"
  | "app-launcher"
  | "floating-ball"
  | "plugins"
  | "marketplace"
  | "lan-transfer"

export function AppShell() {
  const { t } = useTranslation()
  const [nav, setNav] = useState<NavId>("home")

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
            DesKit
          </span>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <span className="text-sm font-medium">{t(`nav.${navKey(nav)}`)}</span>
        </header>
        <main className="flex-1 overflow-y-auto px-6 py-8">
          <div
            className={cn(
              "mx-auto w-full",
              nav === "plugins" || nav === "marketplace" || nav === "lan-transfer"
                ? "max-w-5xl"
                : "max-w-3xl"
            )}
          >
            {nav === "home" && <HomePage onNavigate={setNav} />}
            {nav === "settings" && <SettingsPage />}
            {nav === "app-launcher" && <AppLauncherPage onNavigate={setNav} />}
            {nav === "floating-ball" && <FloatingBallPage onNavigate={setNav} />}
            {nav === "plugins" && <PluginsPage />}
            {nav === "marketplace" && <MarketplacePage />}
            {nav === "lan-transfer" && <LanTransferPage />}
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
