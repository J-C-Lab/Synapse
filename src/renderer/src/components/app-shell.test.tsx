import { cleanup, render, screen } from "@testing-library/react"
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
    renderAppShell()
    // The fallback nav is "home", which renders as "nav.home" text in both
    // the sidebar item and the header's current-tab label — hence
    // getAllByText rather than getByText (which would throw on >1 match).
    expect(screen.getAllByText("nav.home").length).toBeGreaterThan(0)
  })
})
