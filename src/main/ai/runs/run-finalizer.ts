import type { RunTrace, TraceUpsertInput, TraceUpsertReceipt } from "../run-trace-store"
import type { AgentRunStore } from "./agent-run-store"
import type { CanonicalJson } from "./canonical-json"
import type { AgentRunCheckpointV1, RunFinalizationLedger } from "./checkpoint-schema"
import type { DurableChatMessage } from "./durable-messages"
import type { RunEventEmitter } from "./run-event-emitter"
import { randomUUID } from "node:crypto"
import { ConversationLeaseConflictError } from "../conversation-store"
import { canonicalHash } from "./canonical-json"
import { isValidRunStatusTransition } from "./run-types"

// Terminal finalization across stores (design §"Terminal finalization across
// stores"). Conversation commit, run-trace publication, resource release,
// and the terminal checkpoint are four independent durable stores — there is
// no cross-store transaction, so the checkpointed RunFinalizationLedger IS
// the transaction: each external operation is idempotent per finalizationId,
// and its durable receipt is checkpointed before moving to the next phase.
// A crash at any point just means the next call to finalizeRun repeats the
// (idempotent) operation for the current phase and continues.

export type RunFinalizerFaultPoint =
  | "before_prepare"
  | "after_prepared"
  | "before_conversation_commit"
  | "after_conversation_committed"
  | "before_trace_upsert"
  | "after_trace_upserted"
  | "before_resource_release"
  | "after_resources_released"
  | "before_lease_release"
  | "after_lease_released"
  | "before_complete"
  | "after_complete"

/** The slice of ConversationStore's durable-run API the finalizer needs —
 *  kept as a structural port so tests don't need a real ConversationStore. */
export interface ConversationFinalizationPort {
  commitRun: (input: {
    conversationId: string
    runId: string
    fencingToken: number
    baseContentRevision: number
    deletionEpoch: number
    finalizationId: string
    messages: DurableChatMessage[]
  }) => Promise<{ contentRevision: number }>
  releaseRunLease: (input: {
    conversationId: string
    runId: string
    fencingToken: number
    finalizationId: string
    committedContentRevision: number
  }) => Promise<{ recordRevision: number }>
  /** Returns undefined for a deleted/tombstoned or missing conversation —
   *  the only way to tell a tombstone apart from `commitRun`'s generic
   *  `commit-preconditions-not-met`, which covers every precondition
   *  failure (tombstoned, stale revision, fencing mismatch) with one
   *  reason. */
  get: (conversationId: string) => Promise<unknown | undefined>
}

export interface RunFinalizerDeps {
  runStore: AgentRunStore
  /** Undefined for runs never bound to a conversation (e.g. background
   *  runs) — the conversation-commit/lease-release phases become no-ops. */
  conversation?: ConversationFinalizationPort
  upsertTrace: (input: TraceUpsertInput) => TraceUpsertReceipt
  /** Idempotently releases everything named in the resource-release plan
   *  (remaining budget holds, skill-package leases, the artifact run pin,
   *  adoption leases). One injected seam rather than four, since Checkpoint
   *  A doesn't yet own the skill/artifact stores — concrete wiring lands
   *  with the callers that migrate onto this driver (Tasks 13-14). */
  releaseResources: (plan: RunFinalizationLedger["resourceReleasePlan"]) => Promise<void>
  now: () => number
  newId?: () => string
  /** Named crash-recovery test seams — never set in production. */
  fault?: (point: RunFinalizerFaultPoint) => void
  /** Emits run_status_changed/finalization_phase_updated/run_completed/
   *  run_failed to the durable event journal — purely observational
   *  (renderer projection), never awaited for correctness. Omitted by
   *  callers that don't need durable event history (most existing tests). */
  eventEmitter?: RunEventEmitter
}

export interface FinalizeRunInput {
  desiredStatus: "completed" | "cancelled" | "failed"
  stopReason: string
  trace: RunTrace
  resourceReleasePlan: RunFinalizationLedger["resourceReleasePlan"]
}

/**
 * Drives one run through every finalization phase to `complete`, resuming
 * from whatever phase is already durable. Safe to call repeatedly with the
 * same logical `input` — once `checkpoint.finalization` exists, `input` is
 * ignored and the persisted ledger is authoritative, so a caller never needs
 * to remember a `finalizationId` across retries.
 */
export async function finalizeRun(
  deps: RunFinalizerDeps,
  runId: string,
  input: FinalizeRunInput
): Promise<AgentRunCheckpointV1> {
  let checkpoint = await loadOk(deps, runId)

  if (!checkpoint.finalization) {
    deps.fault?.("before_prepare")
    checkpoint = await prepare(deps, runId, checkpoint, input)
    deps.fault?.("after_prepared")
    await emitStatusChanged(deps, checkpoint)
    await emitPhase(deps, checkpoint)
  }

  for (;;) {
    const phase = checkpoint.finalization!.phase
    if (phase === "complete") return checkpoint

    if (phase === "prepared") {
      deps.fault?.("before_conversation_commit")
      checkpoint = await commitConversationPhase(deps, runId, checkpoint)
      deps.fault?.("after_conversation_committed")
      await emitPhase(deps, checkpoint)
      continue
    }
    if (phase === "conversation_committed") {
      deps.fault?.("before_trace_upsert")
      checkpoint = await traceUpsertPhase(deps, runId, checkpoint)
      deps.fault?.("after_trace_upserted")
      await emitPhase(deps, checkpoint)
      continue
    }
    if (phase === "trace_upserted") {
      deps.fault?.("before_resource_release")
      checkpoint = await releaseResourcesPhase(deps, runId, checkpoint)
      deps.fault?.("after_resources_released")
      await emitPhase(deps, checkpoint)
      continue
    }
    if (phase === "resources_released") {
      deps.fault?.("before_lease_release")
      checkpoint = await releaseLeasePhase(deps, runId, checkpoint)
      deps.fault?.("after_lease_released")
      await emitPhase(deps, checkpoint)
      continue
    }
    // phase === "conversation_lease_released"
    deps.fault?.("before_complete")
    checkpoint = await completePhase(deps, runId)
    deps.fault?.("after_complete")
    await emitPhase(deps, checkpoint)
    await emitStatusChanged(deps, checkpoint)
    await emitTerminalOutcome(deps, checkpoint)
  }
}

async function emitStatusChanged(
  deps: RunFinalizerDeps,
  checkpoint: AgentRunCheckpointV1
): Promise<void> {
  await deps.eventEmitter?.emit({
    type: "run_status_changed",
    status: checkpoint.status,
    recovery: checkpoint.recovery,
  })
}

async function emitPhase(deps: RunFinalizerDeps, checkpoint: AgentRunCheckpointV1): Promise<void> {
  const ledger = checkpoint.finalization
  if (!ledger) return
  await deps.eventEmitter?.emit({
    type: "finalization_phase_updated",
    finalizationId: ledger.finalizationId,
    phase: ledger.phase,
  })
}

async function emitTerminalOutcome(
  deps: RunFinalizerDeps,
  checkpoint: AgentRunCheckpointV1
): Promise<void> {
  const desiredStatus = checkpoint.finalization?.desiredStatus
  if (desiredStatus === "completed") {
    await deps.eventEmitter?.emit({ type: "run_completed", outcome: "completed" })
  } else if (desiredStatus === "cancelled" || desiredStatus === "failed") {
    await deps.eventEmitter?.emit({
      type: "run_failed",
      outcome: desiredStatus,
      reason: checkpoint.finalization?.stopReason,
    })
  }
}

async function loadOk(deps: RunFinalizerDeps, runId: string): Promise<AgentRunCheckpointV1> {
  const result = await deps.runStore.load(runId)
  if (!result.ok) throw new Error(`checkpoint for run ${runId} is ${result.reason}`)
  return result.checkpoint
}

async function mutateCheckpoint(
  deps: RunFinalizerDeps,
  runId: string,
  mutator: (checkpoint: AgentRunCheckpointV1) => AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1> {
  const current = await loadOk(deps, runId)
  return deps.runStore.mutate(runId, current.revision, mutator)
}

function newId(deps: RunFinalizerDeps): string {
  return deps.newId?.() ?? randomUUID()
}

// ---------------------------------------------------------------------------
// Phase 1: prepare

async function prepare(
  deps: RunFinalizerDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1,
  input: FinalizeRunInput
): Promise<AgentRunCheckpointV1> {
  // Child ownership resolution (waiting_child -> terminalizing) is owned by
  // the recovery/abandon services landing in Task 12; Checkpoint A's
  // finalizer assumes any caller has already resolved it before invoking
  // finalizeRun.
  if (
    !isValidRunStatusTransition(checkpoint.status, "terminalizing", {
      childOwnershipResolved: true,
    })
  ) {
    throw new Error(
      `cannot finalize run ${runId}: invalid transition ${checkpoint.status} -> terminalizing`
    )
  }

  const finalizationId = newId(deps)
  const traceHash = canonicalHash(input.trace as unknown as CanonicalJson)
  const ledger: RunFinalizationLedger = {
    finalizationId,
    desiredStatus: input.desiredStatus,
    phase: "prepared",
    outcome: input.trace.outcome,
    stopReason: input.stopReason,
    endedAt: input.trace.endedAt,
    trace: input.trace,
    traceHash,
    resourceReleasePlan: input.resourceReleasePlan,
  }

  return mutateCheckpoint(deps, runId, (cp) => ({
    ...cp,
    status: "terminalizing",
    finalization: ledger,
    updatedAt: deps.now(),
  }))
}

// ---------------------------------------------------------------------------
// Phase 2: commit conversation

async function commitConversationPhase(
  deps: RunFinalizerDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1> {
  const ledger = checkpoint.finalization!
  const receipt = await resolveConversationCommit(deps, runId, checkpoint, ledger.finalizationId)

  return mutateCheckpoint(deps, runId, (cp) => ({
    ...cp,
    finalization: {
      ...cp.finalization!,
      phase: "conversation_committed",
      conversationReceipt: receipt,
    },
    conversationCommit:
      receipt.status === "committed" && cp.conversationCommit
        ? { ...cp.conversationCommit, committedContentRevision: receipt.contentRevision }
        : cp.conversationCommit,
    updatedAt: deps.now(),
  }))
}

async function resolveConversationCommit(
  deps: RunFinalizerDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1,
  finalizationId: string
): Promise<NonNullable<RunFinalizationLedger["conversationReceipt"]>> {
  if (!checkpoint.identity.conversationId || !checkpoint.conversationCommit || !deps.conversation) {
    return { status: "skipped", reason: "no-conversation" }
  }
  try {
    const { contentRevision } = await deps.conversation.commitRun({
      conversationId: checkpoint.identity.conversationId,
      runId,
      fencingToken: checkpoint.conversationCommit.leaseFencingToken,
      baseContentRevision: checkpoint.conversationCommit.baseContentRevision,
      deletionEpoch: checkpoint.conversationCommit.deletionEpoch,
      finalizationId,
      messages: checkpoint.messages,
    })
    return { status: "committed", contentRevision }
  } catch (err) {
    if (err instanceof ConversationLeaseConflictError) {
      // `conversation-tombstoned` (thrown by acquireRunLease) and
      // `commit-preconditions-not-met` (thrown by commitRun, which folds
      // every precondition failure — tombstoned, stale revision, fencing
      // mismatch — into one reason) both land here. Only a confirmed
      // tombstone/missing record is safe to treat as an explicit skip; any
      // other conflict is a genuine `suspended_conversation_conflict` case
      // (Task 12) and must not be silently swallowed.
      const stillThere = await deps.conversation.get(checkpoint.identity.conversationId)
      if (stillThere === undefined) {
        return { status: "skipped", reason: "conversation-tombstoned" }
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Phase 3: upsert trace

async function traceUpsertPhase(
  deps: RunFinalizerDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1> {
  const ledger = checkpoint.finalization!
  const receipt = deps.upsertTrace({
    runId,
    finalizationId: ledger.finalizationId,
    traceHash: ledger.traceHash,
    trace: ledger.trace,
  })

  return mutateCheckpoint(deps, runId, (cp) => ({
    ...cp,
    finalization: {
      ...cp.finalization!,
      phase: "trace_upserted",
      traceUpsertRevision: receipt.revision,
    },
    updatedAt: deps.now(),
  }))
}

// ---------------------------------------------------------------------------
// Phase 4: release resources

async function releaseResourcesPhase(
  deps: RunFinalizerDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1> {
  const plan = checkpoint.finalization!.resourceReleasePlan
  await deps.releaseResources(plan)

  return mutateCheckpoint(deps, runId, (cp) => ({
    ...cp,
    finalization: {
      ...cp.finalization!,
      phase: "resources_released",
      resourceReceipts: {
        budgetOperationIds: plan.budgetOperationIds,
        skillPackageLeaseIds: plan.skillPackageLeaseIds,
        artifactRunPinReleased: plan.releaseArtifactRunPin,
        adoptionLeaseIds: plan.adoptionLeaseIds,
      },
    },
    updatedAt: deps.now(),
  }))
}

// ---------------------------------------------------------------------------
// Phase 5: release conversation lease

async function releaseLeasePhase(
  deps: RunFinalizerDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1> {
  const ledger = checkpoint.finalization!
  const leaseReleaseRevision = await resolveLeaseRelease(deps, runId, checkpoint, ledger)

  return mutateCheckpoint(deps, runId, (cp) => ({
    ...cp,
    finalization: {
      ...cp.finalization!,
      phase: "conversation_lease_released",
      leaseReleaseRevision,
    },
    updatedAt: deps.now(),
  }))
}

async function resolveLeaseRelease(
  deps: RunFinalizerDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1,
  ledger: RunFinalizationLedger
): Promise<number | undefined> {
  if (
    ledger.conversationReceipt?.status !== "committed" ||
    !checkpoint.identity.conversationId ||
    !checkpoint.conversationCommit ||
    !deps.conversation
  ) {
    return undefined
  }
  const { recordRevision } = await deps.conversation.releaseRunLease({
    conversationId: checkpoint.identity.conversationId,
    runId,
    fencingToken: checkpoint.conversationCommit.leaseFencingToken,
    finalizationId: ledger.finalizationId,
    committedContentRevision: ledger.conversationReceipt.contentRevision,
  })
  return recordRevision
}

// ---------------------------------------------------------------------------
// Phase 6: complete

async function completePhase(deps: RunFinalizerDeps, runId: string): Promise<AgentRunCheckpointV1> {
  return mutateCheckpoint(deps, runId, (cp) => {
    const desiredStatus = cp.finalization!.desiredStatus
    if (!isValidRunStatusTransition(cp.status, desiredStatus, { finalizationPhase: "complete" })) {
      throw new Error(
        `cannot complete run ${runId}: invalid transition ${cp.status} -> ${desiredStatus}`
      )
    }
    return {
      ...cp,
      status: desiredStatus,
      finalization: { ...cp.finalization!, phase: "complete" },
      updatedAt: deps.now(),
    }
  })
}
