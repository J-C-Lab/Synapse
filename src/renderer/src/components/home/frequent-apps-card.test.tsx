import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FrequentAppsCard } from "./frequent-apps-card"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))

const getFrequentAppsMock = vi.fn()
const launchAppMock = vi.fn()
const removeFrequentAppMock = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getFrequentApps: (...args: unknown[]) => getFrequentAppsMock(...args),
  launchApp: (...args: unknown[]) => launchAppMock(...args),
  removeFrequentApp: (...args: unknown[]) => removeFrequentAppMock(...args),
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

  it("renders the real app icon when one was resolved", async () => {
    getFrequentAppsMock.mockResolvedValue([
      {
        entry: { id: "vscode", kind: "win32", name: "VS Code", nameLower: "vs code", target: "x" },
        lastLaunchedAt: Date.now(),
        iconDataUrl: "data:image/png;base64,abc",
      },
    ])

    const { container } = render(<FrequentAppsCard />)
    await screen.findByRole("button", { name: /VS Code/ })

    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,abc")
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

  it("removes an app from the list when its delete button is clicked", async () => {
    getFrequentAppsMock.mockResolvedValue([
      {
        entry: { id: "vscode", kind: "win32", name: "VS Code", nameLower: "vs code", target: "x" },
        lastLaunchedAt: Date.now(),
      },
    ])
    removeFrequentAppMock.mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(<FrequentAppsCard />)
    await screen.findByRole("button", { name: /VS Code/ })
    await user.click(screen.getByRole("button", { name: "home.frequentApps.remove" }))

    expect(removeFrequentAppMock).toHaveBeenCalledWith("vscode")
    expect(screen.queryByRole("button", { name: /VS Code/ })).not.toBeInTheDocument()
  })

  it("does not launch the app when its delete button is clicked", async () => {
    getFrequentAppsMock.mockResolvedValue([
      {
        entry: { id: "vscode", kind: "win32", name: "VS Code", nameLower: "vs code", target: "x" },
        lastLaunchedAt: Date.now(),
      },
    ])
    removeFrequentAppMock.mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(<FrequentAppsCard />)
    await user.click(await screen.findByRole("button", { name: "home.frequentApps.remove" }))

    expect(launchAppMock).not.toHaveBeenCalled()
  })

  it("shows a short empty-state message with no action when there's no usage yet", async () => {
    getFrequentAppsMock.mockResolvedValue([])

    render(<FrequentAppsCard />)

    expect(await screen.findByText("home.frequentApps.empty")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})
