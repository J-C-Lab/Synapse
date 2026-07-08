import {
  BrainCircuit,
  House,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  Store,
  Wifi,
} from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import logoDarkUrl from "@/assets/logo-dark.png"
import logoUrl from "@/assets/logo.png"
import { HomePage } from "@/components/pages/home-page"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { UpdateBanner } from "@/components/update-banner"
import { useAnyModalOpen } from "@/hooks/use-any-modal-open"
import { useTheme } from "@/hooks/use-theme"
import { getSettings, isElectron, openFloatingBallFeature, setTitleBarDimmed } from "@/lib/electron"
import { cn } from "@/lib/utils"

/** Minimal renderer-side accelerator prettifier for the launcher tooltip —
 * intentionally lighter than the full parser in launcher-settings.tsx since
 * this only ever needs to render a short hint, not round-trip a capture. */
function prettyHotkey(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "commandorcontrol":
        case "cmdorctrl":
        case "control":
        case "ctrl":
          return "Ctrl"
        case "command":
        case "cmd":
          return "⌘"
        case "alt":
          return "Alt"
        case "shift":
          return "Shift"
        case "space":
          return "Space"
        default:
          return part
      }
    })
    .join("+")
}

const ChatPage = lazy(() =>
  import("@/components/pages/chat-page").then((m) => ({ default: m.ChatPage }))
)
const SettingsPage = lazy(() =>
  import("@/components/pages/settings-page").then((m) => ({ default: m.SettingsPage }))
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

export type NavId = "home" | "cortex" | "settings" | "plugins" | "marketplace" | "lan-transfer"

const NAV_IDS = new Set<NavId>([
  "home",
  "cortex",
  "settings",
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
  const { resolvedScheme } = useTheme()

  const [pendingCortexConversationId, setPendingCortexConversationId] = useState<
    string | undefined
  >(undefined)
  const [hotkey, setHotkey] = useState<string | null>(null)

  useEffect(() => {
    if (!isElectron()) return
    void getSettings().then((settings) => setHotkey(settings.hotkey))
  }, [])

  const anyModalOpen = useAnyModalOpen()

  useEffect(() => {
    if (!isElectron()) return
    void setTitleBarDimmed(anyModalOpen)
  }, [anyModalOpen])

  function handleHomeNavigate(id: NavId, conversationId?: string): void {
    if (id === "cortex") {
      setPendingCortexConversationId(conversationId)
    }
    setNav(id)
  }

  useEffect(() => {
    if (nav === "cortex" || pendingCortexConversationId === undefined) return
    // The user has navigated away from Cortex without ChatPage ever mounting
    // to consume the pending id (e.g. its lazy chunk was still loading, or
    // simply never got the chance) — that visit's resume opportunity has
    // unambiguously passed, so clear it now. This is gated on the OPPOSITE
    // condition from the mount-time race the id-clearing callback fixes
    // (nav !== "cortex", not nav === "cortex"), so it can't reintroduce that
    // bug: it never fires while ChatPage could still be in its Suspense
    // window for this visit, only after that window has definitely closed.
    // Without this, a stale id could silently outlive its visit and get
    // resumed by a later plain sidebar click into Cortex instead of starting
    // a fresh draft.
    setPendingCortexConversationId(undefined)
  }, [nav])

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset">
        {/* No native title bar (see createMainWindow) — this doubles as the
            left half of the draggable title bar strip, like Claude Desktop's
            dark integrated header. */}
        <SidebarHeader className="[-webkit-app-region:drag]">
          <div className="flex items-center px-2 py-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void openFloatingBallFeature("appLauncher")}
                  aria-label={t("nav.openLauncher")}
                  className="group/logo relative size-6 shrink-0 rounded outline-none [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img
                    src={resolvedScheme === "dark" ? logoDarkUrl : logoUrl}
                    alt=""
                    aria-hidden
                    className="absolute inset-0 size-6 transition-opacity duration-200 group-hover/logo:opacity-0 group-focus-visible/logo:opacity-0"
                  />
                  <Search
                    aria-hidden
                    className="absolute inset-0 size-6 p-0.5 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/logo:opacity-100 group-focus-visible/logo:opacity-100"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {hotkey
                  ? t("nav.openLauncherHint", { hotkey: prettyHotkey(hotkey) })
                  : t("nav.openLauncher")}
              </TooltipContent>
            </Tooltip>
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
                    isActive={nav === "cortex"}
                    onClick={() => setNav("cortex")}
                    tooltip={t("nav.cortex")}
                  >
                    <BrainCircuit />
                    <span>{t("nav.cortex")}</span>
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
          <SidebarMenu>
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
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <UpdateBanner />
        {/* Draggable (no native title bar); the overlay window controls sit
            top-right (Windows/Linux) so this never needs to reserve space for
            them — nothing here is right-anchored. */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 [-webkit-app-region:drag]">
          <SidebarTrigger className="[-webkit-app-region:no-drag]" />
          <span className="text-sm font-medium">{t(`nav.${navKey(nav)}`)}</span>
        </header>
        <main
          className={cn(
            "flex-1",
            nav === "cortex"
              ? "flex min-h-0 flex-col overflow-hidden px-4 py-4"
              : "overflow-y-auto px-6 py-8"
          )}
        >
          <div
            className={cn(
              "mx-auto w-full",
              nav === "cortex"
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
              {nav === "home" && <HomePage onNavigate={handleHomeNavigate} />}
              {nav === "cortex" && (
                <ChatPage
                  initialConversationId={pendingCortexConversationId}
                  onInitialConversationConsumed={() => setPendingCortexConversationId(undefined)}
                />
              )}
              {nav === "settings" && <SettingsPage />}
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
    case "cortex":
      return "cortex"
    case "settings":
      return "settings"
    case "plugins":
      return "plugins"
    case "marketplace":
      return "marketplace"
    case "lan-transfer":
      return "lanTransfer"
  }
}
