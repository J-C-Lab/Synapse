import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./home-page"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ resolvedScheme: "light" }),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => false,
}))

afterEach(cleanup)

describe("homePage", () => {
  it("no longer renders the removed Quick Actions card", () => {
    render(<HomePage onNavigate={vi.fn()} />)
    expect(screen.queryByText("home.quickActions")).not.toBeInTheDocument()
  })

  it("renders the today's-picks placeholder card", () => {
    render(<HomePage onNavigate={vi.fn()} />)
    expect(screen.getByText("home.recommendations.title")).toBeInTheDocument()
    expect(screen.getByText("home.recommendations.placeholder")).toBeInTheDocument()
  })

  it("renders the Cortex, frequent-apps, and plugins cards", () => {
    render(<HomePage onNavigate={vi.fn()} />)
    expect(screen.getByText("home.cortex.title")).toBeInTheDocument()
    expect(screen.getByText("home.frequentApps.title")).toBeInTheDocument()
    expect(screen.getByText("home.plugins.title")).toBeInTheDocument()
  })
})
