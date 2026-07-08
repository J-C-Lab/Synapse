import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect, useRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "@/hooks/use-theme"
import { AppShell } from "./app-shell"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => false,
}))

vi.mock("@/components/pages/home-page", () => ({
  // Stands in for the future "continue conversation" card on Home: clicking
  // it calls onNavigate with a second (conversationId) argument, exactly like
  // that card will, without depending on it having been built yet.
  HomePage: ({ onNavigate }: { onNavigate: (id: string, conversationId?: string) => void }) => (
    <button type="button" onClick={() => onNavigate("cortex", "conv-cold-start")}>
      fake-continue-conversation
    </button>
  ),
}))

// AppShell lazy-loads ChatPage via `lazy(() => import("@/components/pages/chat-page")...)`.
// Mocking the module's factory to return an externally-controlled promise lets
// the test hold the dynamic import pending on demand — reproducing the real
// "cold" first-navigation window where React has already committed the
// Suspense fallback (and any sibling effects in AppShell have already run)
// but the lazy chunk has not resolved and ChatPage has not mounted yet.
const { chatPageMountSpy, resolveChatPageModule, chatPageModulePromise } = vi.hoisted(() => {
  const spy = vi.fn()
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise((res) => {
    resolve = res
  })
  return { chatPageMountSpy: spy, resolveChatPageModule: resolve, chatPageModulePromise: promise }
})

vi.mock("@/components/pages/chat-page", () => chatPageModulePromise)

// jsdom does not implement matchMedia; ThemeProvider and the sidebar's
// useIsMobile hook both call it on mount to detect the OS color scheme /
// viewport width.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

afterEach(() => {
  cleanup()
  window.location.hash = ""
})

function renderAppShell() {
  return render(
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  )
}

describe("appShell nav", () => {
  it("no longer offers App Launcher or Floating Ball as top-level tabs", () => {
    renderAppShell()
    expect(screen.queryByText("nav.appLauncher")).not.toBeInTheDocument()
    expect(screen.queryByText("nav.floatingBall")).not.toBeInTheDocument()
  })

  it("shows the renamed Cortex tab", () => {
    renderAppShell()
    expect(screen.getByText("nav.cortex")).toBeInTheDocument()
  })

  it("ignores a stale #/app-launcher hash and falls back to home", () => {
    window.location.hash = "#/app-launcher"
    const { container } = renderAppShell()
    // The sidebar's Home menu item always renders the literal text
    // "nav.home" unconditionally — it is a static label, not gated on the
    // fallback logic — so asserting anywhere in the document would pass even
    // if the fallback were broken. Scope to the header's current-tab label,
    // which only reads "nav.home" when `nav` actually resolved to "home".
    const header = container.querySelector("header")
    expect(header).not.toBeNull()
    expect(within(header!).getByText("nav.home")).toBeInTheDocument()
  })
})

describe("appShell cortex resume — cold Suspense race", () => {
  it("keeps the resume id even when ChatPage's lazy chunk has not resolved by the time nav flips", async () => {
    renderAppShell()

    // Simulate clicking Home's future "continue conversation" card:
    // onNavigate("cortex", conversationId) sets AppShell's
    // pendingCortexConversationId AND flips nav to "cortex" in the same
    // handler. React then attempts to render the lazy ChatPage element for
    // the first time in this test run — since its dynamic import has not
    // been triggered before, it suspends and shows the Suspense fallback.
    fireEvent.click(screen.getByText("fake-continue-conversation"))

    // Give any effects tied to the nav flip a chance to run while the lazy
    // chunk is still deliberately unresolved — this is precisely the window
    // the regression lived in: a `nav`-keyed clearing effect in AppShell used
    // to fire here and reset the pending id before ChatPage ever mounted.
    await act(async () => {})

    // Now let the lazy chunk "arrive", well after that window, mirroring a
    // real cold dynamic import finally resolving.
    await act(async () => {
      resolveChatPageModule({
        ChatPage: ({
          initialConversationId,
          onInitialConversationConsumed,
        }: {
          initialConversationId?: string
          onInitialConversationConsumed?: () => void
        }) => {
          // Mirrors the real ChatPage: it reads `initialConversationId` only
          // once at mount (via a captured/derived-once value), so a later
          // prop change to undefined — caused by this very component telling
          // AppShell the id has been consumed — must not un-resume it.
          const mountTimeIdRef = useRef(initialConversationId)
          useEffect(() => {
            chatPageMountSpy(initialConversationId)
            onInitialConversationConsumed?.()
            // eslint-disable-next-line react/exhaustive-deps
          }, [])
          return <div data-testid="fake-chat-page">{mountTimeIdRef.current ?? "none"}</div>
        },
      })
      await chatPageModulePromise
    })

    await waitFor(() => expect(screen.getByTestId("fake-chat-page")).toBeInTheDocument())

    // The point of the fix: even though the lazy chunk resolved well after
    // the nav flip (and any sibling effects in AppShell had already run),
    // ChatPage must still receive the real conversation id, not undefined.
    expect(chatPageMountSpy).toHaveBeenCalledWith("conv-cold-start")
    expect(screen.getByTestId("fake-chat-page")).toHaveTextContent("conv-cold-start")
  })
})
