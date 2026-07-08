import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FrequentAppsCard } from "./frequent-apps-card"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))

const getFrequentAppsMock = vi.fn()
const refreshAppsMock = vi.fn()
const launchAppMock = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getFrequentApps: (...args: unknown[]) => getFrequentAppsMock(...args),
  refreshApps: (...args: unknown[]) => refreshAppsMock(...args),
  launchApp: (...args: unknown[]) => launchAppMock(...args),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("frequentAppsCard", () => {
  it("renders each frequent app as a clickable button with its name", async () => {
    getFrequentAppsMock.mockResolvedValue([
      {
        entry: { id: "vscode", kind: "win32", name: "VS Code", nameLower: "vs code", target: "x" },
        lastLaunchedAt: Date.now() - 60_000,
      },
    ])

    render(<FrequentAppsCard />)

    expect(await screen.findByRole("button", { name: /VS Code/ })).toBeInTheDocument()
  })

  it("launches an app when its tile is clicked", async () => {
    getFrequentAppsMock.mockResolvedValue([
      {
        entry: { id: "vscode", kind: "win32", name: "VS Code", nameLower: "vs code", target: "x" },
        lastLaunchedAt: Date.now(),
      },
    ])
    launchAppMock.mockResolvedValue(true)
    const user = userEvent.setup()

    render(<FrequentAppsCard />)
    await user.click(await screen.findByRole("button", { name: /VS Code/ }))

    expect(launchAppMock).toHaveBeenCalledWith("vscode")
  })

  it("shows an empty state with a working rescan action when there's no usage yet", async () => {
    getFrequentAppsMock.mockResolvedValue([])
    refreshAppsMock.mockResolvedValue([])
    const user = userEvent.setup()

    render(<FrequentAppsCard />)
    expect(await screen.findByText("home.frequentApps.empty")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "home.frequentApps.emptyAction" }))
    await waitFor(() => expect(refreshAppsMock).toHaveBeenCalledTimes(1))
  })

  it("rescans and refetches when the header rescan button is clicked", async () => {
    getFrequentAppsMock.mockResolvedValue([])
    refreshAppsMock.mockResolvedValue([])
    const user = userEvent.setup()

    render(<FrequentAppsCard />)
    await screen.findByText("home.frequentApps.empty")
    await user.click(screen.getByRole("button", { name: "home.frequentApps.rescan" }))

    await waitFor(() => expect(refreshAppsMock).toHaveBeenCalledTimes(1))
    expect(getFrequentAppsMock).toHaveBeenCalledTimes(2) // initial load + post-rescan refetch
  })
})
