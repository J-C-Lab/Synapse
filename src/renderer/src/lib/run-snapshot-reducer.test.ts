import type { AgentRunEvent, AgentRunSnapshot } from "@synapse/agent-protocol"
import { beforeEach, describe, expect, it } from "vitest"
import { applyRunEvent, initRunSnapshotReducerState } from "./run-snapshot-reducer"

function baseSnapshot(overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
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

// Auto-increments so a test that applies several events in sequence (a
// pending_approval → running → completed walk, say) doesn't have to hand-
// track sequence numbers itself — each call just gets "the next one".
// Tests that need a SPECIFIC sequence (gap/duplicate/stale detection) pass
// it explicitly via overrides, which always wins.
let nextSequence = 6

beforeEach(() => {
  nextSequence = 6
})

function eventBase(
  overrides: Partial<AgentRunEvent> & { type: AgentRunEvent["type"] }
): AgentRunEvent {
  const sequence = overrides.sequence ?? nextSequence++
  return {
    schemaVersion: 1,
    eventId: `evt-${sequence}`,
    runId: "run-1",
    rootRunId: "run-1",
    sequence,
    timestamp: 1,
    persisted: true,
    ...overrides,
  } as AgentRunEvent
}

describe("applyRunEvent", () => {
  it("ignores an event for a different runId", () => {
    const state = initRunSnapshotReducerState(baseSnapshot())
    const outcome = applyRunEvent(
      state,
      eventBase({
        type: "run_status_changed",
        runId: "other-run",
        status: "completed",
        recovery: { kind: "automatic" },
      })
    )
    expect(outcome.kind).toBe("ignored")
    expect(outcome.state.snapshot).toBe(state.snapshot)
  })

  it("ignores an event at or before the snapshot's own lastSequence", () => {
    const state = initRunSnapshotReducerState(baseSnapshot({ lastSequence: 5 }))
    const outcome = applyRunEvent(
      state,
      eventBase({
        type: "run_status_changed",
        sequence: 5,
        status: "completed",
        recovery: { kind: "automatic" },
      })
    )
    expect(outcome.kind).toBe("ignored")
  })

  it("reports a gap when sequence skips ahead of lastSequence + 1", () => {
    const state = initRunSnapshotReducerState(baseSnapshot({ lastSequence: 5 }))
    const outcome = applyRunEvent(
      state,
      eventBase({
        type: "run_status_changed",
        sequence: 8,
        status: "completed",
        recovery: { kind: "automatic" },
      })
    )
    expect(outcome.kind).toBe("gap")
    // The snapshot itself is untouched — the caller must catch up via
    // getRunEventsSince before trusting it again.
    expect(outcome.state.snapshot.lastSequence).toBe(5)
  })

  it("is idempotent: applying the exact same event twice only updates state once", () => {
    let state = initRunSnapshotReducerState(baseSnapshot({ lastSequence: 5 }))
    const event = eventBase({
      type: "run_status_changed",
      eventId: "evt-fixed",
      sequence: 6,
      status: "completed",
      recovery: { kind: "automatic" },
    })
    const first = applyRunEvent(state, event)
    expect(first.kind).toBe("applied")
    state = first.state
    expect(state.snapshot.status).toBe("completed")
    expect(state.snapshot.lastSequence).toBe(6)

    // A duplicate broadcast (e.g. after a renderer reconnect) of the exact
    // same eventId must never re-apply or bump lastSequence twice.
    const second = applyRunEvent(state, event)
    expect(second.kind).toBe("ignored")
    expect(second.state).toBe(state)
  })

  it("updates status and recovery on run_status_changed", () => {
    const state = initRunSnapshotReducerState(baseSnapshot())
    const outcome = applyRunEvent(
      state,
      eventBase({
        type: "run_status_changed",
        status: "waiting_approval",
        recovery: { kind: "requires_review", reason: "unknown-tool-outcome" },
      })
    )
    expect(outcome.kind).toBe("applied")
    if (outcome.kind !== "applied") throw new Error("unreachable")
    expect(outcome.state.snapshot.status).toBe("waiting_approval")
    expect(outcome.state.snapshot.recovery).toEqual({
      kind: "requires_review",
      reason: "unknown-tool-outcome",
    })
  })

  it("appends a new tool call on tool_requested and never duplicates it on replay", () => {
    let state = initRunSnapshotReducerState(baseSnapshot())
    const requested = eventBase({
      type: "tool_requested",
      modelStep: 0,
      ordinal: 0,
      toolUseId: "t1",
      safeName: "read",
      fqName: "com.x/read",
    })
    const first = applyRunEvent(state, requested)
    expect(first.kind).toBe("applied")
    state = first.state
    expect(state.snapshot.toolCalls).toEqual([
      {
        ordinal: 0,
        modelStep: 0,
        toolUseId: "t1",
        safeName: "read",
        fqName: "com.x/read",
        status: "approved",
      },
    ])

    // A reload's initial getRunSnapshot() already reflects this call — a
    // stale re-delivery of the same event must not add a second card.
    const replay = applyRunEvent(state, requested)
    expect(replay.kind).toBe("ignored")
  })

  it("walks a tool call through pending_approval → running → completed without duplicating it", () => {
    let state = initRunSnapshotReducerState(
      baseSnapshot({
        toolCalls: [
          {
            ordinal: 0,
            modelStep: 0,
            toolUseId: "t1",
            safeName: "act",
            fqName: "com.x/act",
            status: "approved",
          },
        ],
      })
    )

    state = applyExpectApplied(
      state,
      eventBase({ type: "approval_pending", approvalId: "appr-1", ordinal: 0, safeName: "act" })
    )
    expect(state.snapshot.toolCalls[0]!.status).toBe("pending_approval")
    expect(state.snapshot.pendingApprovalIds).toEqual(["appr-1"])

    state = applyExpectApplied(
      state,
      eventBase({
        type: "approval_resolved",
        approvalId: "appr-1",
        allowed: true,
        remember: "once",
      })
    )
    expect(state.snapshot.toolCalls[0]!.status).toBe("approved")
    expect(state.snapshot.pendingApprovalIds).toEqual([])

    state = applyExpectApplied(
      state,
      eventBase({ type: "tool_started", ordinal: 0, toolUseId: "t1", attemptId: "attempt-1" })
    )
    expect(state.snapshot.toolCalls[0]!.status).toBe("running")

    state = applyExpectApplied(
      state,
      eventBase({
        type: "tool_completed",
        ordinal: 0,
        toolUseId: "t1",
        attemptId: "attempt-1",
        isError: false,
        complete: true,
      })
    )
    expect(state.snapshot.toolCalls[0]!.status).toBe("completed")
    expect(state.snapshot.toolCalls[0]!.isError).toBe(false)
    expect(state.snapshot.toolCalls).toHaveLength(1)
  })

  it("resolves an approval that was already pending in the initial snapshot (no live approval_pending event)", () => {
    const state = initRunSnapshotReducerState(
      baseSnapshot({
        pendingApprovalIds: ["appr-1"],
        toolCalls: [
          {
            ordinal: 0,
            modelStep: 0,
            toolUseId: "t1",
            safeName: "act",
            fqName: "com.x/act",
            status: "pending_approval",
          },
        ],
      })
    )
    const outcome = applyRunEvent(
      state,
      eventBase({
        type: "approval_resolved",
        approvalId: "appr-1",
        allowed: false,
        remember: "once",
      })
    )
    expect(outcome.kind).toBe("applied")
    if (outcome.kind !== "applied") throw new Error("unreachable")
    expect(outcome.state.snapshot.toolCalls[0]!.status).toBe("denied")
  })

  it("passes through plan_updated, artifact_created, and finalization_phase_updated", () => {
    let state = initRunSnapshotReducerState(baseSnapshot())

    state = applyExpectApplied(
      state,
      eventBase({ type: "plan_updated", plan: [{ title: "step 1", status: "in_progress" }] })
    )
    expect(state.snapshot.plan).toEqual([{ title: "step 1", status: "in_progress" }])

    state = applyExpectApplied(
      state,
      eventBase({
        type: "artifact_created",
        artifact: {
          uri: "artifact://run/run-1/a1",
          kind: "text",
          mediaType: "text/plain",
          capturedBytes: 10,
          complete: true,
        },
      })
    )
    expect(state.snapshot.artifacts).toHaveLength(1)

    state = applyExpectApplied(
      state,
      eventBase({
        type: "finalization_phase_updated",
        finalizationId: "f1",
        phase: "trace_upserted",
      })
    )
    expect(state.snapshot.finalizationPhase).toBe("trace_upserted")
  })

  it("no-ops on sequence-bump-only event types (text_delta, run_started, ...)", () => {
    const state = initRunSnapshotReducerState(baseSnapshot())
    const outcome = applyRunEvent(
      state,
      eventBase({ type: "text_delta", text: "hi", persisted: false })
    )
    expect(outcome.kind).toBe("applied")
    if (outcome.kind !== "applied") throw new Error("unreachable")
    expect(outcome.state.snapshot.lastSequence).toBe(6)
    expect(outcome.state.snapshot.status).toBe(state.snapshot.status)
  })
})

function applyExpectApplied(
  state: ReturnType<typeof initRunSnapshotReducerState>,
  event: AgentRunEvent
): ReturnType<typeof initRunSnapshotReducerState> {
  const outcome = applyRunEvent(state, event)
  if (outcome.kind !== "applied") throw new Error(`expected "applied", got "${outcome.kind}"`)
  return outcome.state
}
