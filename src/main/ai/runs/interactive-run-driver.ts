import type { RunTrace, RunTraceErrorCategory, RunTraceToolCall } from "../run-trace-store"
import type {
  AgentRunCheckpointV1,
  RunFinalizationLedger,
  ToolCallLedgerEntry,
} from "./checkpoint-schema"
import type { DurableAgentDriverDeps } from "./durable-agent-driver"
import type { FinalizeRunInput } from "./run-finalizer"
import type { ToolBatchDeps } from "./tool-batch-runner"
import { InsufficientBudgetError } from "../budget/root-budget-ledger"
import { advanceDurableRun } from "./durable-agent-driver"
import { InsufficientEstimateError } from "./model-step-runner"
import { advanceToolBatch } from "./tool-batch-runner"

// Drives one run from its already-persisted initial checkpoint (see
// interactive-run-setup.ts / background-run-setup.ts / subagent-run-setup.ts)
// to a terminal outcome, alternating between the durable model-step driver
// and the ordered tool-batch runner exactly as the design's outer loop
// describes — never advancing more than one legal step without re-checking
// the latest checkpoint. Finalizes the run itself on every terminal outcome
// except a suspension, which requires an explicit human recovery decision
// (Task 12) before anything can finalize. Named for its first caller
// (interactive chat); despite that, everything here is driven purely by
// checkpoint/runId, so background-agent and subagent runs (Task 14) reuse it
// unchanged — only their setup and finalize wiring differ.

export type InteractiveTurnStopReason = "end_turn" | "max_steps" | "aborted" | "budget_exceeded"

export type InteractiveTurnOutcome =
  | {
      kind: "finalized"
      checkpoint: AgentRunCheckpointV1
      stopReason: InteractiveTurnStopReason
    }
  | { kind: "suspended_unknown_tool_outcome"; checkpoint: AgentRunCheckpointV1; ordinal: number }

export interface InteractiveRunDriverDeps {
  model: DurableAgentDriverDeps
  toolBatch: Omit<ToolBatchDeps, "runStore">
  signal?: AbortSignal
  finalize: (runId: string, input: FinalizeRunInput) => Promise<AgentRunCheckpointV1>
  buildResourceReleasePlan: (
    checkpoint: AgentRunCheckpointV1
  ) => RunFinalizationLedger["resourceReleasePlan"]
}

export async function runInteractiveTurn(
  deps: InteractiveRunDriverDeps,
  runId: string
): Promise<InteractiveTurnOutcome> {
  // A single top-level signal governs the between-steps loop check below,
  // cancellation of an in-flight provider call, and cancellation of an
  // in-flight tool invocation — callers set it once here rather than having
  // to keep three copies in sync.
  const toolBatchDeps: ToolBatchDeps = {
    ...deps.toolBatch,
    runStore: deps.model.runStore,
    signal: deps.signal,
  }
  const modelDeps: DurableAgentDriverDeps = { ...deps.model, signal: deps.signal }

  for (;;) {
    if (deps.signal?.aborted) {
      return finalizeTerminal(deps, runId, "aborted")
    }

    // durable-agent-driver.ts advances nextStep the moment a model step
    // settles, before its tool batch (if any) is ever materialized — so a
    // resume must finish any pending batch for the *previous* step before
    // ever calling advanceDurableRun again, or it would skip straight past
    // an interrupted batch into a brand-new model step.
    const pending = await pendingToolBatchStep(deps.model.runStore, runId)
    if (pending !== undefined) {
      const batchOutcome = await advanceToolBatch(toolBatchDeps, runId, pending)
      if (batchOutcome.kind === "suspended_unknown_tool_outcome") {
        return {
          kind: "suspended_unknown_tool_outcome",
          checkpoint: batchOutcome.checkpoint,
          ordinal: batchOutcome.ordinal,
        }
      }
      continue
    }

    let stepOutcome
    try {
      stepOutcome = await advanceDurableRun(modelDeps, runId)
    } catch (err) {
      if (err instanceof InsufficientBudgetError || err instanceof InsufficientEstimateError) {
        return finalizeTerminal(deps, runId, "budget_exceeded")
      }
      throw err
    }

    if (stepOutcome.kind === "end_turn") {
      return finalizeTerminal(deps, runId, "end_turn", stepOutcome.checkpoint)
    }
    if (stepOutcome.kind === "max_steps") {
      return finalizeTerminal(deps, runId, "max_steps", stepOutcome.checkpoint)
    }

    // tool_batch_required — the model step that just settled produced tool
    // calls; the checkpoint's nextStep already advanced past it, so the
    // batch belongs to nextStep - 1.
    const modelStep = stepOutcome.checkpoint.nextStep - 1
    const batchOutcome = await advanceToolBatch(toolBatchDeps, runId, modelStep)
    if (batchOutcome.kind === "suspended_unknown_tool_outcome") {
      return {
        kind: "suspended_unknown_tool_outcome",
        checkpoint: batchOutcome.checkpoint,
        ordinal: batchOutcome.ordinal,
      }
    }
    // materialized — loop back for the next model step.
  }
}

/** Returns the model step of a tool batch that exists but never reached
 *  `materializedAtRevision`, if any — the only state a resume needs to
 *  check for, since batches for every earlier step are always already
 *  materialized (the driver never advances past one that isn't). */
async function pendingToolBatchStep(
  runStore: InteractiveRunDriverDeps["model"]["runStore"],
  runId: string
): Promise<number | undefined> {
  const result = await runStore.load(runId)
  if (!result.ok) throw new Error(`cannot advance run ${runId}: checkpoint is ${result.reason}`)
  const unmaterialized = result.checkpoint.toolBatches.find(
    (batch) => batch.materializedAtRevision === undefined
  )
  return unmaterialized?.modelStep
}

async function finalizeTerminal(
  deps: InteractiveRunDriverDeps,
  runId: string,
  stopReason: InteractiveTurnStopReason,
  checkpointHint?: AgentRunCheckpointV1
): Promise<InteractiveTurnOutcome> {
  const result = await deps.model.runStore.load(runId)
  if (!result.ok) throw new Error(`cannot finalize run ${runId}: checkpoint is ${result.reason}`)
  const checkpoint = checkpointHint ?? result.checkpoint

  const trace = buildTraceFromCheckpoint(checkpoint, stopReason)
  const finalized = await deps.finalize(runId, {
    desiredStatus: "completed",
    stopReason,
    trace,
    resourceReleasePlan: deps.buildResourceReleasePlan(checkpoint),
  })
  return { kind: "finalized", checkpoint: finalized, stopReason }
}

/** Best-effort observability summary derived entirely from durable ledger
 *  state — never a stack-local accumulator, so it reconstructs identically
 *  whether this is the first pass or a resume after a crash. RunTrace is a
 *  diagnostics index (design §"RunTrace... does NOT duplicate tool
 *  arguments/results"), not a source of truth, so approximate timing for
 *  calls that never executed (denied/invalid) is an acceptable trade-off.
 *  Exported for reuse by AgentRunRecoveryService's buildAbandonTrace
 *  (index.ts), which needs the identical checkpoint-derived trace shape. */
export function buildTraceFromCheckpoint(
  checkpoint: AgentRunCheckpointV1,
  outcome: InteractiveTurnStopReason
): RunTrace {
  const toolCalls: RunTraceToolCall[] = checkpoint.toolBatches.flatMap((batch) =>
    batch.calls.map((call) => toRunTraceToolCall(call))
  )

  return {
    runId: checkpoint.identity.runId,
    conversationId: checkpoint.identity.conversationId,
    invocationId: checkpoint.identity.invocationId,
    parentRunId: checkpoint.identity.parentRunId,
    origin: checkpoint.identity.origin,
    workspaceId: checkpoint.identity.workspaceId,
    startedAt: checkpoint.createdAt,
    endedAt: checkpoint.updatedAt,
    outcome,
    toolCalls,
  }
}

function toRunTraceToolCall(call: ToolCallLedgerEntry): RunTraceToolCall {
  const firstAttempt = call.attempts[0]
  const lastAttempt = call.attempts[call.attempts.length - 1]
  const startedAt = firstAttempt?.state.startedAt ?? 0
  const completedAt =
    lastAttempt?.state.status === "completed" ? lastAttempt.state.completedAt : startedAt

  if (call.resolution.status !== "resolved") {
    return { name: call.fqName, startedAt, ms: 0, ok: false, error: "exception" }
  }
  const ok = !call.resolution.result.isError
  return {
    name: call.fqName,
    startedAt,
    ms: Math.max(0, completedAt - startedAt),
    ok,
    ...(ok ? {} : { error: errorCategoryFor(call.resolution.reason) }),
  }
}

function errorCategoryFor(
  reason:
    | "executed"
    | "approval-denied"
    | "policy-denied"
    | "invalid-tool-call"
    | "user-marked-failed"
): RunTraceErrorCategory {
  switch (reason) {
    case "approval-denied":
    case "policy-denied":
      return "denied"
    case "invalid-tool-call":
    case "user-marked-failed":
      return "exception"
    case "executed":
      return "tool-error"
  }
}
