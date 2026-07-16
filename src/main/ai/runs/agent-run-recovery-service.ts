import type {
  AgentRunSummary,
  RecoveryBlockedReason,
  RecoveryDisposition,
  RecoveryReviewReason,
} from "@synapse/agent-protocol"
import type { RunTrace } from "../run-trace-store"
import type { AgentRunStore } from "./agent-run-store"
import type {
  AgentRunCheckpointV1,
  PersistedToolResult,
  RunFinalizationLedger,
} from "./checkpoint-schema"
import type { RecoveryClassifierInput } from "./recovery-classifier"
import type { FinalizeRunInput } from "./run-finalizer"
import { isTerminalRunStatus } from "@synapse/agent-protocol"
import { classifyRunRecovery } from "./recovery-classifier"
import { isValidRunStatusTransition } from "./run-types"

// Startup recovery classification, resume, and abandon (design §"Run
// recovery service and startup UX"). listRecoverable() is the startup scan:
// every non-terminal or incomplete-finalization checkpoint gets a freshly
// computed, persisted RecoveryDisposition. resume() only ever unblocks the
// run's *status* back to "running" — actually driving the agent loop
// forward is the caller's job (the durable driver, wired in Tasks 13-14).
// abandon() reuses the exact same finalization protocol as a normal
// completion, with desired status "cancelled".

export type RecoveryDecision = { kind: "retry" } | { kind: "mark_failed" }

export class RecoveryBlockedError extends Error {
  constructor(public readonly reason: RecoveryBlockedReason) {
    super(`run recovery blocked: ${reason}`)
    this.name = "RecoveryBlockedError"
  }
}

export class RecoveryDecisionRequiredError extends Error {
  constructor(public readonly reason: RecoveryReviewReason) {
    super(`run requires an explicit recovery decision (${reason})`)
    this.name = "RecoveryDecisionRequiredError"
  }
}

export class ConversationConflictUnresumableError extends Error {
  constructor(runId: string) {
    super(`run ${runId} has a conversation conflict and can only be abandoned, not resumed`)
    this.name = "ConversationConflictUnresumableError"
  }
}

export interface AgentRunRecoveryServiceDeps {
  runStore: AgentRunStore
  /** Builds the live comparison inputs for one checkpoint. Called fresh for
   *  every classification so a listRecoverable() scan and a later resume()
   *  both see current state, not a stale snapshot. */
  buildClassifierInput: (checkpoint: AgentRunCheckpointV1) => Promise<RecoveryClassifierInput>
  finalize: (runId: string, input: FinalizeRunInput) => Promise<AgentRunCheckpointV1>
  buildAbandonTrace: (checkpoint: AgentRunCheckpointV1) => RunTrace
  buildAbandonResourcePlan: (
    checkpoint: AgentRunCheckpointV1
  ) => RunFinalizationLedger["resourceReleasePlan"]
  /** Corrupt checkpoints cannot safely supply their normal release plan.
   * Callers use this idempotent run-id reconciliation hook for resources
   * stored outside checkpoint.json before its evidence is isolated. */
  reconcileCorruptRun?: (runId: string) => Promise<void>
  now: () => number
}

export class AgentRunRecoveryService {
  constructor(private readonly deps: AgentRunRecoveryServiceDeps) {}

  /** Scans every non-terminal or incomplete-finalization checkpoint,
   * reclassifies it, persists the disposition, and returns a summary row per
   * run. Even an unreadable checkpoint gets a blocked row keyed by its safe
   * directory runId, so it can be diagnosed and explicitly abandoned. */
  async listRecoverable(): Promise<AgentRunSummary[]> {
    const entries = await this.deps.runStore.scan()
    const summaries: AgentRunSummary[] = []

    for (const entry of entries) {
      if (!entry.result.ok) {
        summaries.push({
          runId: entry.runId,
          rootRunId: entry.runId,
          origin: "interactive",
          status: "failed",
          recovery: {
            kind: "blocked",
            reason:
              entry.result.reason === "unsupported-schema-version"
                ? "unsupported-checkpoint-version"
                : "checkpoint-malformed",
          },
          createdAt: 0,
          updatedAt: 0,
        })
        continue
      }
      const checkpoint = entry.result.checkpoint
      if (isTerminalRunStatus(checkpoint.status) && checkpoint.finalization?.phase === "complete") {
        continue
      }

      const { checkpoint: reclassified } = await this.reclassify(checkpoint)
      summaries.push({
        runId: reclassified.identity.runId,
        conversationId: reclassified.identity.conversationId,
        rootRunId: reclassified.identity.rootRunId,
        origin: reclassified.identity.origin,
        status: reclassified.status,
        recovery: reclassified.recovery,
        createdAt: reclassified.createdAt,
        updatedAt: reclassified.updatedAt,
      })
    }
    return summaries
  }

  /** Idempotent for a still-automatic running run. Every non-terminal run
   * is reclassified first, including an already-running legacy checkpoint:
   * otherwise a newly introduced recovery block could be bypassed forever
   * by a prior process having set its status to running. */
  async resume(runId: string, decision?: RecoveryDecision): Promise<void> {
    let checkpoint = await this.loadOk(runId)
    if (isTerminalRunStatus(checkpoint.status)) return

    const reclassified = await this.reclassify(checkpoint)
    checkpoint = reclassified.checkpoint
    const disposition = reclassified.disposition

    if (disposition.kind === "blocked") {
      throw new RecoveryBlockedError(disposition.reason)
    }

    if (checkpoint.status === "running") {
      if (disposition.kind === "automatic") return
      if (disposition.reason === "conversation-conflict") {
        throw new ConversationConflictUnresumableError(runId)
      }
      throw new RecoveryDecisionRequiredError(disposition.reason)
    }

    if (disposition.kind === "requires_review") {
      if (disposition.reason === "conversation-conflict") {
        throw new ConversationConflictUnresumableError(runId)
      }
      if (!decision) {
        throw new RecoveryDecisionRequiredError(disposition.reason)
      }
      if (
        checkpoint.status === "suspended_unknown_tool_outcome" &&
        decision.kind === "mark_failed"
      ) {
        checkpoint = await this.markStuckCallsFailed(runId, checkpoint)
      }
      // decision.kind === "retry" needs no ledger mutation: the tool-batch
      // runner already treats a latest attempt in "unknown" state (with an
      // unresolved call) as eligible for a fresh attempt — the only thing
      // that was ever stopping it was the run sitting in
      // suspended_unknown_tool_outcome, cleared by the status mutation below.
    }

    await this.transitionToRunning(runId, checkpoint, { hasRecoveryDecision: true })
  }

  /** Runs the same six-phase finalization protocol as a normal completion,
   *  with desired status "cancelled". Reusing finalizeRun (Task 11) means
   *  abandon gets the exact same idempotent/resumable guarantees for free. */
  async abandon(runId: string): Promise<void> {
    const raw = await this.deps.runStore.load(runId)
    if (!raw.ok) {
      await this.deps.reconcileCorruptRun?.(runId)
      await this.deps.runStore.discard(runId)
      return
    }
    const checkpoint = raw.checkpoint
    if (isTerminalRunStatus(checkpoint.status)) return

    if (checkpoint.finalization) {
      // A finalization is already in flight (this abandon call itself is a
      // retry, or a prior completion attempt started one) — never invent a
      // second desiredStatus. finalizeRun ignores `input` once the ledger
      // exists, so any placeholder trace/plan here is inert.
      await this.deps.finalize(runId, {
        desiredStatus: checkpoint.finalization.desiredStatus,
        stopReason: checkpoint.finalization.stopReason,
        trace: checkpoint.finalization.trace,
        resourceReleasePlan: checkpoint.finalization.resourceReleasePlan,
      })
      return
    }

    await this.deps.finalize(runId, {
      desiredStatus: "cancelled",
      stopReason: "abandoned",
      trace: this.deps.buildAbandonTrace(checkpoint),
      resourceReleasePlan: this.deps.buildAbandonResourcePlan(checkpoint),
    })
  }

  // -------------------------------------------------------------------

  private async loadOk(runId: string): Promise<AgentRunCheckpointV1> {
    const result = await this.deps.runStore.load(runId)
    if (!result.ok) throw new Error(`checkpoint for run ${runId} is ${result.reason}`)
    return result.checkpoint
  }

  private async reclassify(
    checkpoint: AgentRunCheckpointV1
  ): Promise<{ checkpoint: AgentRunCheckpointV1; disposition: RecoveryDisposition }> {
    const input = await this.deps.buildClassifierInput(checkpoint)
    const disposition = classifyRunRecovery(checkpoint, input)
    if (sameDisposition(disposition, checkpoint.recovery)) {
      return { checkpoint, disposition }
    }
    const next = await this.deps.runStore.mutate(
      checkpoint.identity.runId,
      checkpoint.revision,
      (cp) => ({
        ...cp,
        recovery: disposition,
        updatedAt: this.deps.now(),
      })
    )
    return { checkpoint: next, disposition }
  }

  private async transitionToRunning(
    runId: string,
    checkpoint: AgentRunCheckpointV1,
    ctx: { hasRecoveryDecision: boolean }
  ): Promise<AgentRunCheckpointV1> {
    return this.deps.runStore.mutate(runId, checkpoint.revision, (cp) => {
      if (!isValidRunStatusTransition(cp.status, "running", ctx)) {
        throw new Error(`cannot resume run ${runId}: invalid transition ${cp.status} -> running`)
      }
      return {
        ...cp,
        status: "running",
        recovery: { kind: "automatic" },
        updatedAt: this.deps.now(),
      }
    })
  }

  private async markStuckCallsFailed(
    runId: string,
    checkpoint: AgentRunCheckpointV1
  ): Promise<AgentRunCheckpointV1> {
    return this.deps.runStore.mutate(runId, checkpoint.revision, (cp) => ({
      ...cp,
      toolBatches: cp.toolBatches.map((batch) => ({
        ...batch,
        calls: batch.calls.map((call) => {
          if (call.resolution.status === "resolved") return call
          const latest = call.attempts[call.attempts.length - 1]
          if (!latest || (latest.state.status !== "started" && latest.state.status !== "unknown")) {
            return call
          }
          const result: PersistedToolResult = {
            isError: true,
            preview:
              "Marked failed during recovery: this tool call's outcome could not be determined after an interrupted run.",
            complete: true,
          }
          return {
            ...call,
            resolution: {
              status: "resolved" as const,
              reason: "user-marked-failed" as const,
              result,
              attemptId: latest.attemptId,
            },
          }
        }),
      })),
      updatedAt: this.deps.now(),
    }))
  }
}

function sameDisposition(a: RecoveryDisposition, b: RecoveryDisposition): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "automatic") return true
  return "reason" in a && "reason" in b && a.reason === b.reason
}
