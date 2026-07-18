import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RunObservatoryPage } from "./run-observatory-page"

const listRuns = vi.fn()
const getRun = vi.fn()
const getRunSnapshot = vi.fn()
const listAiWorkspaces = vi.fn()
const getConversation = vi.fn()
const listRecoverableRuns = vi.fn()
const resumeRun = vi.fn()
const abandonRun = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listRuns: (...args: unknown[]) => listRuns(...args),
  getRun: (...args: unknown[]) => getRun(...args),
  getRunSnapshot: (...args: unknown[]) => getRunSnapshot(...args),
  listAiWorkspaces: (...args: unknown[]) => listAiWorkspaces(...args),
  getAiConversation: (...args: unknown[]) => getConversation(...args),
  listRecoverableRuns: (...args: unknown[]) => listRecoverableRuns(...args),
  resumeRun: (...args: unknown[]) => resumeRun(...args),
  abandonRun: (...args: unknown[]) => abandonRun(...args),
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
  "runObservatory.detailRunId": "Run ID",
  "runObservatory.detailOrigin": "Origin",
  "runObservatory.detailOutcome": "Outcome",
  "runObservatory.detailPrincipal": "Principal",
  "runObservatory.detailInvocation": "Invocation ID",
  "runObservatory.detailStarted": "Started",
  "runObservatory.detailEnded": "Ended",
  "runObservatory.detailConversation": "Conversation",
  "runObservatory.detailWorkspace": "Workspace",
  "runObservatory.detailTrigger": "Trigger instance",
  "runObservatory.detailParentRun": "Parent run",
  "runObservatory.detailChildRuns": "Child runs",
  "runObservatory.detailToolCalls": "Tool calls",
  "runObservatory.detailPlan": "Plan",
  "runObservatory.detailArtifacts": "Artifacts",
  "runObservatory.conversationGone": "This conversation no longer exists.",
  "runObservatory.parentUnavailable":
    "Parent run trace is unavailable. It may have aged out of retention or failed to persist.",
  "runObservatory.noChildRuns": "No child runs.",
  "runObservatory.noArtifacts": "No artifacts.",
  "runObservatory.artifactBytes": "bytes",
  "runObservatory.artifactIncomplete": "incomplete ({{reason}})",
  "runObservatory.recoverableTitle": "Recoverable runs",
  "runObservatory.recoverableResume": "Resume",
  "runObservatory.recoverableAbandon": "Abandon",
  "runObservatory.recoverableBlocked": "Blocked: {{reason}}",
  "runObservatory.recoverableConflict": "Conversation conflict — this run can only be abandoned.",
  "runObservatory.recoverableDecisionRequired": "Needs a decision: {{reason}}",
  "runObservatory.recoverableRetry": "Retry",
  "runObservatory.recoverableMarkFailed": "Mark failed",
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
  getRunSnapshot.mockReset()
  listAiWorkspaces.mockReset()
  getConversation.mockReset()
  listRecoverableRuns.mockReset()
  resumeRun.mockReset()
  abandonRun.mockReset()
  listRuns.mockResolvedValue([summaryA, summaryB])
  getRunSnapshot.mockResolvedValue(undefined)
  listAiWorkspaces.mockResolvedValue([{ id: "ws-1", name: "Project A", createdAt: 0 }])
  getConversation.mockResolvedValue({ id: "c1", workspaceId: "ws-1", messages: [], updatedAt: 0 })
  listRecoverableRuns.mockResolvedValue([])
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

  it("renders every RunTrace provenance field the completion criteria require", async () => {
    getRun.mockResolvedValue({
      ...summaryA,
      invocationId: "inv-42",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      toolCalls: [],
    })
    listRuns.mockImplementation(async (query?: { parentRunId?: string }) =>
      query?.parentRunId ? [] : [summaryA, summaryB]
    )
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))

    const panel = within(await screen.findByTestId("run-detail-panel"))
    expect(panel.getByText("run-a")).toBeInTheDocument()
    expect(panel.getByText("interactive")).toBeInTheDocument()
    expect(panel.getByText("end_turn")).toBeInTheDocument()
    expect(panel.getByText(/external-mcp \(claude-desktop\)/)).toBeInTheDocument()
    expect(panel.getByText("inv-42")).toBeInTheDocument()
  })

  it("shows an em dash for principal/invocationId when the run predates that field", async () => {
    getRun.mockResolvedValue({ ...summaryA, toolCalls: [] })
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))

    const panel = within(await screen.findByTestId("run-detail-panel"))
    await panel.findByText("interactive")
    const dashes = panel.getAllByText("—")
    expect(dashes.length).toBeGreaterThanOrEqual(2)
  })

  it("shows 'No artifacts.' when the run snapshot has none", async () => {
    getRun.mockResolvedValue({ ...summaryA, toolCalls: [] })
    getRunSnapshot.mockResolvedValue({ artifacts: [] })
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))

    expect(await screen.findByText("No artifacts.")).toBeInTheDocument()
  })

  it("lists each artifact from the run snapshot with its kind/mediaType/bytes", async () => {
    getRun.mockResolvedValue({ ...summaryA, toolCalls: [] })
    getRunSnapshot.mockResolvedValue({
      artifacts: [
        {
          uri: "artifact://run/run-a/a1",
          kind: "tool-result",
          mediaType: "text/plain",
          capturedBytes: 5000,
          complete: true,
        },
      ],
    })
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))

    expect(await screen.findByText("artifact://run/run-a/a1")).toBeInTheDocument()
    expect(screen.getByText(/tool-result · text\/plain · 5000 bytes/)).toBeInTheDocument()
  })

  it("marks an incomplete artifact with its truncation reason", async () => {
    getRun.mockResolvedValue({ ...summaryA, toolCalls: [] })
    getRunSnapshot.mockResolvedValue({
      artifacts: [
        {
          uri: "artifact://run/run-a/a1",
          kind: "history",
          mediaType: "application/json",
          capturedBytes: 100,
          complete: false,
          truncationReason: "artifact-limit",
        },
      ],
    })
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))

    // The i18n mock above doesn't interpolate {{reason}} — only assert the
    // static "incomplete" marker renders at all.
    expect(await screen.findByText(/incomplete/)).toBeInTheDocument()
  })

  it("clears the previous run's artifacts while a newly selected run's snapshot is still loading", async () => {
    listRuns.mockImplementation(async (query?: { parentRunId?: string }) =>
      query?.parentRunId ? [] : [summaryA, summaryB]
    )
    getRun.mockResolvedValue({ ...summaryA, toolCalls: [] })
    getRunSnapshot.mockResolvedValueOnce({
      artifacts: [
        {
          uri: "artifact://run/run-a/a1",
          kind: "tool-result",
          mediaType: "text/plain",
          capturedBytes: 1,
          complete: true,
        },
      ],
    })
    render(<RunObservatoryPage />)
    fireEvent.click(await screen.findByText("run-a"))
    await screen.findByText("artifact://run/run-a/a1")

    let resolveSecond!: (value: { artifacts: never[] }) => void
    getRunSnapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve
      })
    )
    fireEvent.click(await screen.findByText("run-b"))
    expect(screen.queryByText("artifact://run/run-a/a1")).not.toBeInTheDocument()
    resolveSecond({ artifacts: [] })
  })

  it("passes includeArchived so runs against archived workspaces still resolve a name", async () => {
    render(<RunObservatoryPage />)
    await screen.findByText("run-a")
    expect(listAiWorkspaces).toHaveBeenCalledWith({ includeArchived: true })
  })

  it("a late response for a previously-selected run does not clobber the currently-selected run's detail", async () => {
    let resolveRunA!: (value: unknown) => void
    getRun.mockImplementation(async (runId: string) => {
      if (runId === "run-a") {
        return new Promise((resolve) => {
          resolveRunA = resolve
        })
      }
      return { ...summaryB, toolCalls: [] }
    })
    render(<RunObservatoryPage />)
    const [runAListItem] = await screen.findAllByText("run-a")
    fireEvent.click(runAListItem)
    await waitFor(() => expect(getRun).toHaveBeenCalledWith("run-a"))

    fireEvent.click(screen.getByText("run-b"))
    const panel = within(await screen.findByTestId("run-detail-panel"))
    await panel.findByText("mcp")

    resolveRunA({ ...summaryA, toolCalls: [] })
    await Promise.resolve()

    expect(panel.getByText("mcp")).toBeInTheDocument()
    expect(panel.queryByText("interactive")).not.toBeInTheDocument()
  })
})

describe("run observatory page — recoverable runs", () => {
  const recoverableRun = {
    runId: "run-stuck",
    rootRunId: "run-stuck",
    origin: "interactive" as const,
    status: "suspended_unknown_tool_outcome" as const,
    recovery: { kind: "requires_review" as const, reason: "unknown-tool-outcome" as const },
    createdAt: 1,
    updatedAt: 2,
  }

  it("does not render the panel when there is nothing to recover", async () => {
    render(<RunObservatoryPage />)
    await screen.findByText("run-a")
    expect(screen.queryByTestId("recoverable-runs-panel")).not.toBeInTheDocument()
  })

  it("lists a recoverable run and resumes it", async () => {
    listRecoverableRuns.mockResolvedValue([recoverableRun])
    resumeRun.mockResolvedValue({ ok: true })
    render(<RunObservatoryPage />)

    const panel = within(await screen.findByTestId("recoverable-runs-panel"))
    expect(panel.getByText("run-stuck")).toBeInTheDocument()

    listRecoverableRuns.mockResolvedValue([])
    fireEvent.click(panel.getByText("Resume"))

    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith("run-stuck", undefined))
    await waitFor(() => expect(listRecoverableRuns).toHaveBeenCalledTimes(2))
  })

  it("shows a blocked reason and does not refresh the list", async () => {
    listRecoverableRuns.mockResolvedValue([recoverableRun])
    resumeRun.mockResolvedValue({ ok: false, reason: "blocked", blockedReason: "deadline-expired" })
    render(<RunObservatoryPage />)

    const panel = within(await screen.findByTestId("recoverable-runs-panel"))
    fireEvent.click(panel.getByText("Resume"))

    await panel.findByText(/Blocked:/)
    expect(listRecoverableRuns).toHaveBeenCalledTimes(1)
  })

  it("offers retry/mark-failed when a decision is required, and resolves with the chosen decision", async () => {
    listRecoverableRuns.mockResolvedValue([recoverableRun])
    resumeRun.mockResolvedValueOnce({
      ok: false,
      reason: "decision_required",
      reviewReason: "unknown-tool-outcome",
    })
    render(<RunObservatoryPage />)

    const panel = within(await screen.findByTestId("recoverable-runs-panel"))
    fireEvent.click(panel.getByText("Resume"))
    await panel.findByText(/Needs a decision:/)

    resumeRun.mockResolvedValueOnce({ ok: true })
    fireEvent.click(panel.getByText("Retry"))

    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith("run-stuck", { kind: "retry" }))
  })

  it("abandons a run and refreshes the recoverable list", async () => {
    listRecoverableRuns.mockResolvedValue([recoverableRun])
    render(<RunObservatoryPage />)

    const panel = within(await screen.findByTestId("recoverable-runs-panel"))
    listRecoverableRuns.mockResolvedValue([])
    fireEvent.click(panel.getByText("Abandon"))

    await waitFor(() => expect(abandonRun).toHaveBeenCalledWith("run-stuck"))
    await waitFor(() => expect(listRecoverableRuns).toHaveBeenCalledTimes(2))
  })
})
