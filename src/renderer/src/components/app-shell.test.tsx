import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect, useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    <button type="button" onClick={() => onNavigate("cortex", "conv-resume-target")}>
      fake-continue-conversation
    </button>
  ),
}))

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

// These tests probe the exact timing of AppShell's one-shot handoff of a
// "resume this conversation" id to the lazy-loaded ChatPage. React.lazy
// caches its resolved import forever once resolved, so each test here needs
// its OWN never-yet-resolved lazy chunk for ChatPage — achieved by resetting
// the module registry and re-mocking "@/components/pages/chat-page" with a
// fresh controllable promise before freshly (dynamically) re-importing
// AppShell, so a brand new `lazy(...)` instance is created per test.
describe("appShell cortex resume — Suspense timing", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  function mockChatPageModule() {
    const mountSpy = vi.fn()
    let resolveModule: (value: unknown) => void = () => {}
    const modulePromise = new Promise((resolve) => {
      resolveModule = resolve
    })
    vi.doMock("@/components/pages/chat-page", () => modulePromise)

    function resolveWithFakeChatPage() {
      resolveModule({
        ChatPage: ({
          initialConversationId,
          onInitialConversationConsumed,
        }: {
          initialConversationId?: string
          onInitialConversationConsumed?: () => void
        }) => {
          // Mirrors the real ChatPage: it reads `initialConversationId` only
          // once at mount (via a captured/derived-once value), so a later
          // prop change to it — e.g. caused by this very component telling
          // AppShell the id has been consumed — must not change what it
          // already resumed with.
          const mountTimeIdRef = useRef(initialConversationId)
          useEffect(() => {
            mountSpy(initialConversationId)
            onInitialConversationConsumed?.()
            // eslint-disable-next-line react/exhaustive-deps
          }, [])
          return <div data-testid="fake-chat-page">{mountTimeIdRef.current ?? "none"}</div>
        },
      })
      return modulePromise
    }

    return { mountSpy, resolveWithFakeChatPage }
  }

  async function renderFreshAppShell() {
    // `vi.resetModules()` gives "./app-shell" a fresh copy of everything it
    // imports, including "@/hooks/use-theme" — which means AppShell's
    // internal `useTheme()` call reads from a DIFFERENT Context object than
    // the one this file's top-level, pre-reset `ThemeProvider` import
    // provides. Re-import ThemeProvider from the same fresh module graph so
    // the Context identities match.
    const [{ AppShell: FreshAppShell }, { ThemeProvider: FreshThemeProvider }] = await Promise.all([
      import("./app-shell"),
      import("@/hooks/use-theme"),
    ])
    return render(
      <FreshThemeProvider>
        <FreshAppShell />
      </FreshThemeProvider>
    )
  }

  function sidebarButton(container: HTMLElement, text: string): HTMLElement {
    const sidebar = container.querySelector('[data-slot="sidebar"]')
    expect(sidebar).not.toBeNull()
    return within(sidebar as HTMLElement).getByText(text)
  }

  it("keeps the resume id even when ChatPage's lazy chunk has not resolved by the time nav flips", async () => {
    const { mountSpy, resolveWithFakeChatPage } = mockChatPageModule()
    await renderFreshAppShell()

    // Simulate clicking Home's future "continue conversation" card:
    // onNavigate("cortex", conversationId) sets AppShell's
    // pendingCortexConversationId AND flips nav to "cortex" in the same
    // handler. React then attempts to render the lazy ChatPage element for
    // the first time — since its dynamic import has not been triggered
    // before, it suspends and shows the Suspense fallback.
    fireEvent.click(screen.getByText("fake-continue-conversation"))

    // Give any effects tied to the nav flip a chance to run while the lazy
    // chunk is still deliberately unresolved — this is precisely the window
    // the original regression lived in: a `nav`-keyed clearing effect used to
    // fire here and reset the pending id before ChatPage ever mounted.
    await act(async () => {})

    // Now let the lazy chunk "arrive", well after that window, mirroring a
    // real cold dynamic import finally resolving.
    await act(async () => {
      await resolveWithFakeChatPage()
    })

    await waitFor(() => expect(screen.getByTestId("fake-chat-page")).toBeInTheDocument())

    // The point of the fix: even though the lazy chunk resolved well after
    // the nav flip (and any sibling effects in AppShell had already run),
    // ChatPage must still receive the real conversation id, not undefined.
    expect(mountSpy).toHaveBeenCalledWith("conv-resume-target")
    expect(screen.getByTestId("fake-chat-page")).toHaveTextContent("conv-resume-target")
  })

  it("clears the pending id if the user navigates away from Cortex before the lazy chunk resolves", async () => {
    const { mountSpy, resolveWithFakeChatPage } = mockChatPageModule()
    const { container } = await renderFreshAppShell()

    // Click "continue conversation" — sets the pending id and flips nav to
    // "cortex". The lazy chunk is deliberately left unresolved, so ChatPage
    // never gets a chance to mount and consume it via
    // onInitialConversationConsumed.
    fireEvent.click(screen.getByText("fake-continue-conversation"))
    await act(async () => {})

    // Before the chunk ever resolves, the user navigates away — via the
    // PLAIN sidebar Home button, not through "continue conversation" again.
    fireEvent.click(sidebarButton(container, "nav.home"))
    await act(async () => {})

    // ...then back in via the plain sidebar Cortex button (again, not
    // through "continue conversation").
    fireEvent.click(sidebarButton(container, "nav.cortex"))
    await act(async () => {})

    // Only now does the lazy chunk finally arrive.
    await act(async () => {
      await resolveWithFakeChatPage()
    })

    await waitFor(() => expect(screen.getByTestId("fake-chat-page")).toBeInTheDocument())

    // The user's last action before the chunk resolved was a PLAIN sidebar
    // click, not a resume — so ChatPage must mount with no initial id, not
    // the stale "conv-resume-target" id from the earlier "continue
    // conversation" click.
    expect(mountSpy).toHaveBeenCalledWith(undefined)
    expect(screen.getByTestId("fake-chat-page")).toHaveTextContent("none")
  })
})
