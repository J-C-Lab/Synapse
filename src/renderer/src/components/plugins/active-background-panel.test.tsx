import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ActiveBackgroundPanel } from "@/components/plugins/active-background-panel"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  listTriggers: vi.fn(),
  pauseTrigger: vi.fn(),
  resumeTrigger: vi.fn(),
  killTrigger: vi.fn(),
}))

vi.mock("@/lib/electron", () => ({
  ...mocks,
  ElectronIpcError: class extends Error {},
}))

describe("activeBackgroundPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listTriggers.mockResolvedValue([
      {
        pluginId: "com.example.timer",
        triggerId: "tick",
        type: "timer",
        status: "faulted",
        budgets: [{ capabilityId: "notification", used: 1, max: 5 }],
      },
    ])
    mocks.pauseTrigger.mockResolvedValue(undefined)
  })

  it("shows faulted status and calls pause on click", async () => {
    render(<ActiveBackgroundPanel pluginId="com.example.timer" />)
    await waitFor(() => expect(screen.getByText("faulted")).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "plugins.triggers.pause" }))
    expect(mocks.pauseTrigger).toHaveBeenCalledWith("com.example.timer", "tick")
  })
})
