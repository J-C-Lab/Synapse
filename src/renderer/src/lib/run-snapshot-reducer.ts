import type { AgentRunEvent, AgentRunSnapshot } from "@synapse/agent-protocol"

// Pure renderer-side reducer for the snapshot-then-subscribe pattern (P1-2):
// getRunSnapshot() gives a point-in-time base, onRunEvent() pushes every
// event live from then on. This module owns folding one event into that
// base — eventId de-duplication (a renderer reload or a duplicate
// main-process broadcast must never double-apply an event), sequence-gap
// detection (a dropped/out-of-order event must trigger a getRunEventsSince
// catch-up rather than silently drifting), and the actual per-event-type
// state transitions a run-detail view needs to avoid ever showing a
// duplicated or stale tool card.
//
// Deliberately does NOT reconstruct full message/tool-result content from
// events alone — several event types (tool_completed, approval_resolved)
// only carry status fields, not content, by design (the same
// never-duplicate-tool-arguments-or-results boundary the host's
// run-projection.ts documents). A resultPreview only ever comes from a
// snapshot (initial or gap-catch-up refetch); live events only ever move a
// tool call between statuses.

export interface RunSnapshotReducerState {
  snapshot: AgentRunSnapshot
  seenEventIds: ReadonlySet<string>
  /** approvalId → ordinal, recorded on approval_pending so the later
   *  approval_resolved event (which carries no ordinal of its own) can still
   *  find the tool call it resolves. */
  pendingApprovalOrdinals: Readonly<Record<string, number>>
}

export function initRunSnapshotReducerState(snapshot: AgentRunSnapshot): RunSnapshotReducerState {
  // The snapshot carries no approvalId directly on a tool call —
  // pendingApprovalIds is the only place it's carried — so pair them up
  // positionally by relative order among pending calls. Both arrays are
  // derived from the same checkpoint scan order (run-projection.ts), so this
  // pairing is exact. Without it, an approval that was already pending
  // BEFORE this subscribe attached (so no live approval_pending event will
  // ever arrive for it) would leave its later approval_resolved event unable
  // to find the ordinal it resolves.
  const pendingOrdinalsInOrder = snapshot.toolCalls
    .filter((call) => call.status === "pending_approval")
    .map((call) => call.ordinal)
  const pendingApprovalOrdinals: Record<string, number> = {}
  snapshot.pendingApprovalIds.forEach((approvalId, index) => {
    const ordinal = pendingOrdinalsInOrder[index]
    if (ordinal !== undefined) pendingApprovalOrdinals[approvalId] = ordinal
  })
  return { snapshot, seenEventIds: new Set(), pendingApprovalOrdinals }
}

export type ApplyRunEventOutcome =
  | { kind: "applied"; state: RunSnapshotReducerState }
  /** Different runId, an already-seen eventId, or a sequence at/before the
   *  snapshot's own lastSequence — always a safe no-op, never an error. */
  | { kind: "ignored"; state: RunSnapshotReducerState }
  /** event.sequence skipped ahead of lastSequence + 1 — the caller must
   *  call getRunEventsSince(runId, state.snapshot.lastSequence) and fold
   *  every returned event back in via applyRunEvent, in order, before
   *  trusting the snapshot again. */
  | { kind: "gap"; state: RunSnapshotReducerState }

export function applyRunEvent(
  state: RunSnapshotReducerState,
  event: AgentRunEvent
): ApplyRunEventOutcome {
  if (event.runId !== state.snapshot.identity.runId) return { kind: "ignored", state }
  if (state.seenEventIds.has(event.eventId)) return { kind: "ignored", state }
  if (event.sequence <= state.snapshot.lastSequence) return { kind: "ignored", state }
  if (event.sequence > state.snapshot.lastSequence + 1) return { kind: "gap", state }

  const seenEventIds = new Set(state.seenEventIds)
  seenEventIds.add(event.eventId)
  const { snapshot, pendingApprovalOrdinals } = foldEvent(
    state.snapshot,
    event,
    state.pendingApprovalOrdinals
  )
  return {
    kind: "applied",
    state: {
      snapshot: { ...snapshot, lastSequence: event.sequence },
      seenEventIds,
      pendingApprovalOrdinals,
    },
  }
}

function foldEvent(
  snapshot: AgentRunSnapshot,
  event: AgentRunEvent,
  pendingApprovalOrdinals: Readonly<Record<string, number>>
): { snapshot: AgentRunSnapshot; pendingApprovalOrdinals: Readonly<Record<string, number>> } {
  switch (event.type) {
    case "run_status_changed":
      return {
        snapshot: { ...snapshot, status: event.status, recovery: event.recovery },
        pendingApprovalOrdinals,
      }

    case "tool_requested":
      return {
        snapshot: {
          ...snapshot,
          toolCalls: [
            ...snapshot.toolCalls,
            {
              ordinal: event.ordinal,
              modelStep: event.modelStep,
              toolUseId: event.toolUseId,
              safeName: event.safeName,
              fqName: event.fqName,
              status: "approved",
            },
          ],
        },
        pendingApprovalOrdinals,
      }

    case "approval_pending":
      return {
        snapshot: {
          ...snapshot,
          toolCalls: updateToolCallByOrdinal(snapshot.toolCalls, event.ordinal, (call) => ({
            ...call,
            status: "pending_approval",
          })),
          pendingApprovalIds: snapshot.pendingApprovalIds.includes(event.approvalId)
            ? snapshot.pendingApprovalIds
            : [...snapshot.pendingApprovalIds, event.approvalId],
        },
        pendingApprovalOrdinals: { ...pendingApprovalOrdinals, [event.approvalId]: event.ordinal },
      }

    case "approval_resolved": {
      const ordinal = pendingApprovalOrdinals[event.approvalId]
      const { [event.approvalId]: _removed, ...rest } = pendingApprovalOrdinals
      return {
        snapshot: {
          ...snapshot,
          toolCalls:
            ordinal === undefined
              ? snapshot.toolCalls
              : updateToolCallByOrdinal(snapshot.toolCalls, ordinal, (call) => ({
                  ...call,
                  status: event.allowed ? "approved" : "denied",
                })),
          pendingApprovalIds: snapshot.pendingApprovalIds.filter((id) => id !== event.approvalId),
        },
        pendingApprovalOrdinals: rest,
      }
    }

    case "tool_started":
      return {
        snapshot: {
          ...snapshot,
          toolCalls: updateToolCallByOrdinal(snapshot.toolCalls, event.ordinal, (call) => ({
            ...call,
            status: "running",
          })),
        },
        pendingApprovalOrdinals,
      }

    case "tool_completed":
      return {
        snapshot: {
          ...snapshot,
          toolCalls: updateToolCallByOrdinal(snapshot.toolCalls, event.ordinal, (call) => ({
            ...call,
            status: "completed",
            isError: event.isError,
          })),
        },
        pendingApprovalOrdinals,
      }

    case "model_completed":
      return {
        snapshot: {
          ...snapshot,
          messages: snapshot.messages.some((m) => m.messageId === event.assistantMessageId)
            ? snapshot.messages
            : [
                ...snapshot.messages,
                {
                  messageId: event.assistantMessageId,
                  role: "assistant",
                  ordinal: snapshot.messages.length,
                },
              ],
        },
        pendingApprovalOrdinals,
      }

    case "plan_updated":
      return { snapshot: { ...snapshot, plan: event.plan }, pendingApprovalOrdinals }

    case "artifact_created":
      return {
        snapshot: { ...snapshot, artifacts: [...snapshot.artifacts, event.artifact] },
        pendingApprovalOrdinals,
      }

    case "child_task_updated":
      return {
        snapshot: {
          ...snapshot,
          childTasks: [
            ...snapshot.childTasks.filter((c) => c.childRunId !== event.child.childRunId),
            event.child,
          ],
        },
        pendingApprovalOrdinals,
      }

    case "finalization_phase_updated":
      return { snapshot: { ...snapshot, finalizationPhase: event.phase }, pendingApprovalOrdinals }

    // Sequence-bump-only: real, but this checkpoint's snapshot has no field
    // for these. run_started fires once at creation (never mid-subscribe,
    // since a subscriber only ever attaches to a run it already has a
    // snapshot for); text_delta is never persisted to the journal at all;
    // budget_admission_updated/child_ownership_lease_updated/
    // checkpoint_committed/run_completed/run_failed are ledger/lifecycle
    // detail a status/finalizationPhase change already surfaces.
    case "run_started":
    case "text_delta":
    case "budget_admission_updated":
    case "child_ownership_lease_updated":
    case "checkpoint_committed":
    case "run_completed":
    case "run_failed":
      return { snapshot, pendingApprovalOrdinals }
  }
}

function updateToolCallByOrdinal(
  toolCalls: AgentRunSnapshot["toolCalls"],
  ordinal: number,
  update: (call: AgentRunSnapshot["toolCalls"][number]) => AgentRunSnapshot["toolCalls"][number]
): AgentRunSnapshot["toolCalls"] {
  const index = toolCalls.findIndex((call) => call.ordinal === ordinal)
  if (index === -1) return toolCalls
  const next = [...toolCalls]
  next[index] = update(next[index]!)
  return next
}
