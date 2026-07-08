import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CortexQuickEntryCard } from "./cortex-quick-entry-card"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const listAiConversationsMock = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listAiConversations: (...args: unknown[]) => listAiConversationsMock(...args),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("cortexQuickEntryCard", () => {
  it("offers to start a new conversation when there's no history", async () => {
    listAiConversationsMock.mockResolvedValue([])
    const onOpenCortex = vi.fn()

    render(<CortexQuickEntryCard onOpenCortex={onOpenCortex} />)
    const button = await screen.findByRole("button", { name: "home.cortex.start" })
    await userEvent.setup().click(button)

    expect(onOpenCortex).toHaveBeenCalledWith(undefined)
  })

  it("offers to resume the most recently updated conversation", async () => {
    listAiConversationsMock.mockResolvedValue([
      { id: "old", title: "Old chat", workspaceId: "default", updatedAt: 1 },
      { id: "recent", title: "Refactor plan", workspaceId: "default", updatedAt: 100 },
    ])
    const onOpenCortex = vi.fn()

    render(<CortexQuickEntryCard onOpenCortex={onOpenCortex} />)
    expect(await screen.findByText("Refactor plan")).toBeInTheDocument()

    const button = screen.getByRole("button", { name: "home.cortex.continue" })
    await userEvent.setup().click(button)

    expect(onOpenCortex).toHaveBeenCalledWith("recent")
  })

  it("falls back to the untitled label when the recent conversation has no title", async () => {
    listAiConversationsMock.mockResolvedValue([
      { id: "recent", workspaceId: "default", updatedAt: 100 },
    ])

    render(<CortexQuickEntryCard onOpenCortex={vi.fn()} />)

    expect(await screen.findByText("chat.untitled")).toBeInTheDocument()
  })
})
