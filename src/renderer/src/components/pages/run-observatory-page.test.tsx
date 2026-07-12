import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RunObservatoryPage } from "./run-observatory-page"

const listRuns = vi.fn()
const getRun = vi.fn()
const listAiWorkspaces = vi.fn()
const getConversation = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listRuns: (...args: unknown[]) => listRuns(...args),
  getRun: (...args: unknown[]) => getRun(...args),
  listAiWorkspaces: (...args: unknown[]) => listAiWorkspaces(...args),
  getAiConversation: (...args: unknown[]) => getConversation(...args),
}))

const enMessages: Record<string, string> = {
  "runObservatory.title": "Runs",
  "runObservatory.subtitle": "Browse the latest 500 agent runs.",
  "runObservatory.filterOrigin": "Origin",
  "runObservatory.filterOutcome": "Outcome",
  "runObservatory.filterWorkspace": "Workspace",
  "runObservatory.filterAll": "All",
  "runObservatory.emptyList": "No runs match the current filters.",
  "runObservatory.selectPrompt": "Select a run to see its details.",
  "runObservatory.detailConversation": "Conversation",
  "runObservatory.detailWorkspace": "Workspace",
  "runObservatory.detailTrigger": "Trigger instance",
  "runObservatory.detailParentRun": "Parent run",
  "runObservatory.detailChildRuns": "Child runs",
  "runObservatory.detailToolCalls": "Tool calls",
  "runObservatory.detailPlan": "Plan",
  "runObservatory.conversationGone": "This conversation no longer exists.",
  "runObservatory.parentUnavailable":
    "Parent run trace is unavailable. It may have aged out of retention or failed to persist.",
  "runObservatory.noChildRuns": "No child runs.",
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => enMessages[key] ?? key,
  }),
}))

const summaryA = {
  runId: "run-a",
  origin: "interactive",
  outcome: "end_turn",
  conversationId: "c1",
  startedAt: 1000,
  endedAt: 2000,
  toolCallCount: 2,
  failedToolCallCount: 0,
  hasPlan: false,
}
const summaryB = {
  runId: "run-b",
  origin: "mcp",
  outcome: "error",
  workspaceId: "ws-1",
  startedAt: 3000,
  endedAt: 4000,
  toolCallCount: 1,
  failedToolCallCount: 1,
  hasPlan: false,
}

beforeEach(() => {
  listRuns.mockReset()
  getRun.mockReset()
  listAiWorkspaces.mockReset()
  getConversation.mockReset()
  listRuns.mockResolvedValue([summaryA, summaryB])
  listAiWorkspaces.mockResolvedValue([{ id: "ws-1", name: "Project A", createdAt: 0 }])
  getConversation.mockResolvedValue({ id: "c1", workspaceId: "ws-1", messages: [], updatedAt: 0 })
})

afterEach(() => {
  cleanup()
})

describe("run observatory page", () => {
  it("lists runs from a single runs:list call", async () => {
    render(<RunObservatoryPage />)
    expect(await screen.findByText("run-a")).toBeInTheDocument()
    expect(screen.getByText("run-b")).toBeInTheDocument()
    expect(listRuns).toHaveBeenCalledTimes(1)
    expect(listRuns).toHaveBeenCalledWith()
  })

  it("filters the list client-side by origin without a second IPC call", async () => {
    render(<RunObservatoryPage />)
    await screen.findByText("run-a")
    const [originSelect] = screen.getAllByLabelText("Origin")
    fireEvent.change(originSelect, { target: { value: "mcp" } })
    expect(screen.queryByText("run-a")).not.toBeInTheDocument()
    expect(screen.getByText("run-b")).toBeInTheDocument()
    expect(listRuns).toHaveBeenCalledTimes(1)
  })

  it("selecting a run calls getRun and renders its detail", async () => {
    getRun.mockImplementation(async (runId: string) => {
      if (runId === "run-a") {
        return { ...summaryA, toolCalls: [{ name: "probe", startedAt: 1100, ms: 40, ok: true }] }
      }
      return undefined
    })
    listRuns.mockImplementation(async (query?: { parentRunId?: string }) =>
      query?.parentRunId ? [] : [summaryA, summaryB]
    )
    render(<RunObservatoryPage />)
    const [runAListItem] = await screen.findAllByText("run-a")
    fireEvent.click(runAListItem)
    await waitFor(() => expect(getRun).toHaveBeenCalledWith("run-a"))
    expect(await screen.findByText(/probe — ok/)).toBeInTheDocument()
  })

  it("a parentRunId that fails to resolve shows the unavailable message, not a bare not-found", async () => {
    getRun.mockImplementation(async (runId: string) =>
      runId === "run-a" ? { ...summaryA, parentRunId: "gone-parent", toolCalls: [] } : undefined
    )
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))
    await screen.findByText("gone-parent")
    fireEvent.click(screen.getByText("gone-parent"))
    expect(
      await screen.findByText(/aged out of retention or failed to persist/)
    ).toBeInTheDocument()
  })

  it("a conversationId link for a conversation that no longer exists renders as plain text", async () => {
    getRun.mockResolvedValue({ ...summaryA, toolCalls: [] })
    getConversation.mockResolvedValue(undefined)
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))
    await waitFor(() => expect(getConversation).toHaveBeenCalledWith("c1"))
    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument()
  })
})
