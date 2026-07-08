import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "@/hooks/use-theme"
import { AppShell } from "./app-shell"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => false,
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
