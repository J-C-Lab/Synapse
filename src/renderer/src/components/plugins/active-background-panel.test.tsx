import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ActiveBackgroundPanel } from "@/components/plugins/active-background-panel"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  listTriggers: vi.fn(),
  listTriggerInstances: vi.fn(),
  listAiWorkspaces: vi.fn(),
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
    mocks.listAiWorkspaces.mockResolvedValue([
      { id: "default", name: "Default", createdAt: 0 },
      { id: "work", name: "Work", createdAt: 0 },
    ])
    mocks.listTriggerInstances.mockResolvedValue([])
    mocks.pauseTrigger.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  it("renders instance rows for an agent-trigger, grouped under its template", async () => {
    mocks.listTriggers.mockResolvedValue([
      {
        pluginId: "com.synapse.github-inbox",
        triggerId: "poll-inbox",
        type: "timer",
        status: "active",
        isAgentTrigger: true,
        budgets: [],
      },
    ])
    mocks.listTriggerInstances.mockResolvedValue([
      {
        id: "instance-1",
        workspaceId: "work",
        workspaceName: "Work",
        paused: false,
        stale: false,
        status: "idle",
        budgets: [],
      },
    ])
    render(<ActiveBackgroundPanel />)
    await waitFor(() => expect(screen.getByText("Work")).toBeInTheDocument())
  })

  it("shows faulted status and calls pause on click for non-agent triggers", async () => {
    mocks.listTriggers.mockResolvedValue([
      {
        pluginId: "com.example.timer",
        triggerId: "tick",
        type: "timer",
        status: "faulted",
        isAgentTrigger: false,
        budgets: [{ capabilityId: "notification", used: 1, max: 5 }],
      },
    ])
    render(<ActiveBackgroundPanel pluginId="com.example.timer" />)
    await waitFor(() => expect(screen.getByText("faulted")).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "plugins.triggers.pause" }))
    expect(mocks.pauseTrigger).toHaveBeenCalledWith("com.example.timer", "tick")
  })
})
