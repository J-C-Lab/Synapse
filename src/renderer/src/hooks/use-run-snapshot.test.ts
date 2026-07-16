import type { AgentRunEvent, AgentRunSnapshot } from "@synapse/agent-protocol"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useRunSnapshot } from "@/hooks/use-run-snapshot"

const electron = vi.hoisted(() => ({
  getRunSnapshot: vi.fn(),
  getRunEventsSince: vi.fn(),
  onRunEvent: vi.fn(),
}))

vi.mock("@/lib/electron", () => electron)

beforeEach(() => {
  vi.clearAllMocks()
})

function snapshot(overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
  return {
    identity: { runId: "run-1", rootRunId: "run-1", origin: "interactive" },
    status: "running",
    recovery: { kind: "automatic" },
    lastSequence: 5,
    createdAt: 1,
    updatedAt: 1,
    pendingApprovalIds: [],
    childTasks: [],
    artifacts: [],
    messages: [],
    toolCalls: [],
    ...overrides,
  }
}

function event(overrides: Partial<AgentRunEvent> & { type: AgentRunEvent["type"] }): AgentRunEvent {
  return {
    schemaVersion: 1,
    eventId: `evt-${overrides.sequence}`,
    runId: "run-1",
    rootRunId: "run-1",
    timestamp: 1,
    persisted: true,
    ...overrides,
  } as AgentRunEvent
}

describe("useRunSnapshot", () => {
  it("returns undefined until the initial snapshot resolves, then returns it", async () => {
    electron.getRunSnapshot.mockResolvedValue(snapshot())
    electron.onRunEvent.mockReturnValue(() => {})

    const { result } = renderHook(() => useRunSnapshot("run-1"))
    expect(result.current).toBeUndefined()

    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.status).toBe("running")
    expect(electron.getRunSnapshot).toHaveBeenCalledWith("run-1")
  })

  it("returns undefined and calls nothing when runId is undefined", () => {
    const { result } = renderHook(() => useRunSnapshot(undefined))
    expect(result.current).toBeUndefined()
    expect(electron.getRunSnapshot).not.toHaveBeenCalled()
    expect(electron.onRunEvent).not.toHaveBeenCalled()
  })

  it("folds a live pushed event into the snapshot", async () => {
    electron.getRunSnapshot.mockResolvedValue(snapshot())
    let pushed: ((event: AgentRunEvent) => void) | undefined
    electron.onRunEvent.mockImplementation((handler: (event: AgentRunEvent) => void) => {
      pushed = handler
      return () => {}
    })

    const { result } = renderHook(() => useRunSnapshot("run-1"))
    await waitFor(() => expect(result.current).toBeDefined())

    act(() => {
      pushed?.(
        event({
          type: "run_status_changed",
          sequence: 6,
          status: "completed",
          recovery: { kind: "automatic" },
        })
      )
    })

    await waitFor(() => expect(result.current?.status).toBe("completed"))
    expect(result.current?.lastSequence).toBe(6)
  })

  it("catches up via getRunEventsSince when a live event reports a sequence gap", async () => {
    electron.getRunSnapshot.mockResolvedValue(snapshot({ lastSequence: 5 }))
    electron.getRunEventsSince.mockResolvedValue([
      event({
        type: "run_status_changed",
        sequence: 6,
        status: "waiting_approval",
        recovery: { kind: "automatic" },
      }),
      event({
        type: "run_status_changed",
        sequence: 7,
        status: "completed",
        recovery: { kind: "automatic" },
      }),
    ])
    let pushed: ((event: AgentRunEvent) => void) | undefined
    electron.onRunEvent.mockImplementation((handler: (event: AgentRunEvent) => void) => {
      pushed = handler
      return () => {}
    })

    const { result } = renderHook(() => useRunSnapshot("run-1"))
    await waitFor(() => expect(result.current).toBeDefined())

    // Skips straight to sequence 9 — a real gap relative to lastSequence 5.
    act(() => {
      pushed?.(
        event({
          type: "run_status_changed",
          sequence: 9,
          status: "cancelled",
          recovery: { kind: "automatic" },
        })
      )
    })

    await waitFor(() => expect(electron.getRunEventsSince).toHaveBeenCalledWith("run-1", 5))
    // The catch-up's own two events (6, 7) are what actually land — the
    // gap-triggering event itself (9) is never applied on its own.
    await waitFor(() => expect(result.current?.status).toBe("completed"))
    expect(result.current?.lastSequence).toBe(7)
  })

  it("unsubscribes on unmount", async () => {
    electron.getRunSnapshot.mockResolvedValue(snapshot())
    const unsubscribe = vi.fn()
    electron.onRunEvent.mockReturnValue(unsubscribe)

    const { unmount } = renderHook(() => useRunSnapshot("run-1"))
    await waitFor(() => expect(electron.onRunEvent).toHaveBeenCalled())

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
