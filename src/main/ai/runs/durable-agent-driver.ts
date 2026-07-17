import type { AgentArtifactStore } from "../artifacts/artifact-types"
import type { SummarizeResult } from "../context/context-compressor"
import type { ChatContentBlock, ChatMessage } from "../providers/types"
import type { AgentRunCheckpointV1, ModelBudgetAdmission } from "./checkpoint-schema"
import type { ModelStepDeps } from "./model-step-runner"
import { randomUUID } from "node:crypto"
import {
  admitModelAttempt,
  forfeitModelAttempt,
  settleModelAttempt,
} from "../budget/model-admission"
import { freeBalance, ROOT_ACCOUNT_ID } from "../budget/root-budget-ledger"
import { ContextCompressor, SummarizeInfrastructureError } from "../context/context-compressor"
import {
  buildCompactionRecord,
  captureHistorySlice,
  deriveHistoryArtifactOwner,
  durableTailAfterCompaction,
  projectCompactedMessages,
} from "../context/history-artifact"
import {
  DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
  summarizerRequestEstimateInput,
  summarizeViaProvider,
} from "../context/summarize-via-provider"
import { assembleFromContextSnapshot } from "./context-snapshot"
import { advanceModelStep, InsufficientEstimateError } from "./model-step-runner"

// Resumable outer driver (design §"Build a resumable driver that always
// reloads the latest checkpoint and chooses one legal next action"). Owns
// exactly one model step per call plus the nextStep advance — it does not
// execute tool calls itself (see the ordered tool-batch ledger); a caller
// drives the loop between model steps and tool batches, invoking this again
// after a tool batch materializes. It also owns context compression (Task
// 20) as a third legal action, evaluated before the model step on every
// call: reload the checkpoint, and if the frozen `contextCompression`
// policy is enabled and the current model-facing projection exceeds its
// threshold, perform ONLY the compression step this call (capture the
// evicted durable slice as a history artifact, then commit the compaction
// checkpoint) and return — never both a compression and a model step in the
// same call, matching every other durable side effect in this file.

export interface DurableAgentDriverDeps extends ModelStepDeps {
  maxSteps: number
  /** Wires durable history-artifact capture for context compression (Task
   *  20, design §"Context compression writes the evicted message slice to a
   *  `history` artifact"). Safe to omit while every run's
   *  `config.contextCompression.enabled` is false — compression never runs,
   *  so this is never consulted. Omitting it while compression is enabled
   *  AND an eviction actually becomes necessary is treated exactly like a
   *  failed capture (see maybeCompressHistory): there is no safe smaller
   *  inline fallback for "the conversation no longer fits", unlike a single
   *  oversized tool result, so the run fails this attempt visibly rather
   *  than silently skipping compression and dispatching an oversized
   *  request anyway. */
  artifactStore?: AgentArtifactStore
}

export interface RequestedToolCall {
  id: string
  name: string
  input: unknown
}

export type DriverStepOutcome =
  | { kind: "end_turn"; checkpoint: AgentRunCheckpointV1 }
  | {
      kind: "tool_batch_required"
      checkpoint: AgentRunCheckpointV1
      toolCalls: RequestedToolCall[]
    }
  | { kind: "max_steps"; checkpoint: AgentRunCheckpointV1 }
  | { kind: "compressed"; checkpoint: AgentRunCheckpointV1 }

/** The conservative request estimator under-reserved a settled response.
 * The response is already durably charged; continuing would make a known
 * invalid budget profile silently usable for further tool/model work. */
export class EstimatorIncompatibleError extends Error {
  constructor(readonly checkpoint: AgentRunCheckpointV1) {
    super(`model estimator exceeded its admitted upper bound for run ${checkpoint.identity.runId}`)
    this.name = "EstimatorIncompatibleError"
  }
}

/** Compression needed to evict durable content but had no way to durably
 *  capture it first (no artifact store wired). Thrown instead of silently
 *  either discarding the slice or dispatching an oversized request — design
 *  §"Offload failure does not silently discard content ... returns a
 *  visible infrastructure error before the next model step." Propagates
 *  exactly like any other durable-step failure in this file (e.g. a budget
 *  admission error): uncaught here, left for the caller to classify. */
export class HistoryCompressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HistoryCompressionError"
  }
}

/**
 * Advances a durable run by exactly one legal action — a compression step
 * or a model step, never both. Always reloads the latest checkpoint first —
 * never trusts authority-bearing progress kept only in a caller's stack
 * locals — and rejects the provider call outright (via model-step-runner)
 * if any required checkpoint/ledger write fails.
 */
export async function advanceDurableRun(
  deps: DurableAgentDriverDeps,
  runId: string
): Promise<DriverStepOutcome> {
  const loaded = await deps.runStore.load(runId)
  if (!loaded.ok) throw new Error(`cannot advance run ${runId}: checkpoint is ${loaded.reason}`)
  if (loaded.checkpoint.nextStep >= deps.maxSteps) {
    return { kind: "max_steps", checkpoint: loaded.checkpoint }
  }

  const compacted = await maybeCompressHistory(deps, loaded.checkpoint)
  if (compacted) return { kind: "compressed", checkpoint: compacted }

  const result = await advanceModelStep(deps, runId)
  if (result.estimatorIncompatible) throw new EstimatorIncompatibleError(result.checkpoint)
  const toolCalls = result.assistantMessage.content.filter(isToolUse)

  const advanced = await deps.runStore.mutate(runId, result.checkpoint.revision, (cp) => ({
    ...cp,
    nextStep: cp.nextStep + 1,
  }))

  if (toolCalls.length === 0) {
    return { kind: "end_turn", checkpoint: advanced }
  }
  return {
    kind: "tool_batch_required",
    checkpoint: advanced,
    toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
  }
}

function isToolUse(
  block: ChatContentBlock
): block is Extract<ChatContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use"
}

/** Performs the compression step when (and only when) it's actually needed
 *  this call, returning the committed checkpoint — or `undefined` when
 *  compression is disabled, or enabled but the current projection is
 *  already within budget. Never mutates `checkpoint.messages`: only
 *  `contextCompaction` (and, transiently, `compressionAttempt`) change, per
 *  this file's top-of-file note. */
async function maybeCompressHistory(
  deps: DurableAgentDriverDeps,
  checkpointIn: AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1 | undefined> {
  const policy = checkpointIn.config.contextCompression
  if (!policy.enabled) return undefined

  // Reconcile a compression budget hold left "held" by a crashed prior
  // attempt before doing anything else this call — see
  // reconcileStuckCompressionAttempt's docstring.
  let checkpoint = await reconcileStuckCompressionAttempt(deps, checkpointIn)

  const runId = checkpoint.identity.runId
  const rootRunId = checkpoint.identity.rootRunId
  const accountId = budgetAccountIdFor(checkpoint)
  const model = checkpoint.config.model

  // Deliberately NOT model-step-runner.ts's outgoingRequestContext: that
  // also injects transient workspace-instruction text into the last user
  // message, which would replace that message with a new object and break
  // ContextCompressor's reference-identity-based eviction diffing (see
  // context-compressor.ts's computeEvicted). The compression decision only
  // needs the real durable messages/compaction state — the small
  // difference in estimated tokens from omitting the injected instruction
  // text doesn't matter for a threshold gate (the real dispatch's own
  // provider.estimateRequestUpperBound is what actually gates admission).
  const { system } = assembleFromContextSnapshot(checkpoint.config.context)
  const projected = projectCompactedMessages(checkpoint.messages, checkpoint.contextCompaction)

  // Threaded across the nested `summarize` callback below so its own
  // durable checkpoint writes (the compressionAttempt planned/held/settled/
  // forfeited transitions) are always reflected here, even though
  // ContextCompressor itself only ever sees the resulting summary text —
  // it has no idea a durable side effect happened underneath it.
  let latest = checkpoint

  const compressor = new ContextCompressor({
    thresholdTokens: Math.max(0, policy.thresholdTokens - policy.hardReserveTokens),
    keepFraction: policy.keepRecentFraction,
    summarize: async (older) => {
      try {
        const attempt = await runCompressionAttempt(deps, latest, {
          model,
          older,
          runId,
          rootRunId,
          accountId,
        })
        latest = attempt.checkpoint
        return attempt.summary
      } catch (err) {
        if (err instanceof CompressionAttemptFailure) {
          latest = err.checkpoint
          throw new SummarizeInfrastructureError("compression summarizer attempt failed", {
            cause: err.cause,
          })
        }
        // Anything else — including a `deps.fault?.()` crash-injection
        // throw from inside runCompressionAttempt, which is never wrapped
        // in CompressionAttemptFailure — must still propagate as an infra
        // failure, never be swallowed into ContextCompressor.compress()'s
        // "summarization declined, hard-trim instead" fallback (that path
        // exists for a genuine summarizer content/API error, not for our
        // own durable-step plumbing failing or a simulated crash). Wrapping
        // it here guarantees compress()'s catch always unwraps and
        // rethrows the original error rather than ever silently
        // continuing. `latest` is deliberately left as-is: whatever
        // mutation happened right before this throw is already safely on
        // disk regardless, and nothing reads `latest` again once this
        // throw propagates out of compress() uncaught.
        throw new SummarizeInfrastructureError("compression attempt failed unexpectedly", {
          cause: err,
        })
      }
    },
  })

  const result = await compressor.compress(system, projected)
  checkpoint = latest
  if (result.evicted.length === 0) return undefined

  // The active compaction's synthetic summary message (if any) is always
  // the first element of `projected` and therefore always the first element
  // of anything evicted from it — eviction only ever removes a leading
  // prefix. It carries no messageId (it's not a durable message), so it's
  // excluded before mapping the rest back to real DurableChatMessages by
  // position. When nothing beyond that synthetic element was evicted this
  // round, there is no new durable content to archive — skip rather than
  // mint an empty artifact or claim a fresh capture that captured nothing.
  const compactionActive = checkpoint.contextCompaction !== undefined
  const realEvictedCount = result.evicted.length - (compactionActive ? 1 : 0)
  if (realEvictedCount <= 0) return undefined

  const tailDurable = durableTailAfterCompaction(checkpoint.messages, checkpoint.contextCompaction)
  const evictedDurable = tailDurable.slice(0, realEvictedCount)

  if (!deps.artifactStore) {
    throw new HistoryCompressionError(
      `context compression for run ${runId} needs to evict ${evictedDurable.length} message(s) ` +
        `but no artifact store is configured to durably capture them first`
    )
  }

  // Capture BEFORE committing the checkpoint (same ordering as
  // tool-batch-runner.ts's tool-result offload): a crash between the two
  // merely orphans the artifact — harmless pre-Task-21 — rather than ever
  // letting a persisted checkpoint reference an evicted slice that was
  // never actually captured. A throw here propagates uncaught, per
  // HistoryCompressionError's docstring: never evict without a durable
  // capture succeeding first.
  const owner = deriveHistoryArtifactOwner(
    checkpoint.identity,
    checkpoint.config.authority.principal.actor
  )
  const artifactRef = await captureHistorySlice(deps.artifactStore, owner, runId, evictedDurable)
  await deps.fault?.("after_history_capture")

  const record = buildCompactionRecord({
    compactionId: randomUUID(),
    evictedThroughMessageId: evictedDurable[evictedDurable.length - 1]!.messageId,
    rawSummaryText: result.summaryText,
    summarizerTokens: result.summarizerTokens,
    artifact: artifactRef,
    archivedMessageCount: evictedDurable.length,
    now: deps.now(),
  })

  const committed = await deps.runStore.mutate(runId, checkpoint.revision, (cp) => ({
    ...cp,
    contextCompaction: record,
    updatedAt: deps.now(),
  }))
  await deps.fault?.("after_compaction_checkpoint")
  return committed
}

/** A run admits/settles against its own account: the root account for a run
 *  that is its own root (interactive/background — identity.runId ===
 *  rootRunId), or the child-task account reserved for it otherwise — same
 *  rule as model-step-runner.ts's identically-named (unexported) helper,
 *  duplicated here rather than imported to avoid depending on that file's
 *  internals for a three-line derivation. */
function budgetAccountIdFor(checkpoint: AgentRunCheckpointV1): string {
  return checkpoint.identity.runId === checkpoint.identity.rootRunId
    ? ROOT_ACCOUNT_ID
    : checkpoint.identity.runId
}

// ---------------------------------------------------------------------------
// Compression's own durable budget-attempt state machine (Issue 2 follow-up
// review fix). Mirrors model-step-runner.ts's prepareAttempt/holdAttempt/
// callProviderAndStage/settleAttempt/ensureForfeitedAndPrepareNext sequence,
// scaled down for compression's simpler needs: a single mutable
// `checkpoint.compressionAttempt` slot (never a per-step array — compression
// isn't nextStep-numbered) and a two-state "held or not" resume model
// instead of model-step-runner's finer prepared/held/dispatched/
// unknown_response/response_staged distinctions, since a summarizer request
// has no exactly-once side effect to protect (unlike a tool call) — the only
// thing that must never happen is a silently leaked or double-charged hold.

/** Internal-only signal from runCompressionAttempt's failure paths back to
 *  maybeCompressHistory's `summarize` callback: carries the checkpoint
 *  exactly as already reconciled (forfeited, where applicable) at the point
 *  of failure, so the outer `latest` tracker never falls behind on a thrown
 *  path. Never crosses this module's boundary — always caught and re-thrown
 *  as `SummarizeInfrastructureError` before `ContextCompressor` ever sees
 *  it, so its own `instanceof` unwrapping (`err.cause`) still surfaces the
 *  real underlying error to callers. */
class CompressionAttemptFailure extends Error {
  constructor(
    readonly checkpoint: AgentRunCheckpointV1,
    readonly cause: unknown
  ) {
    super("compression attempt failed")
  }
}

interface CompressionAttemptInput {
  model: string
  older: ChatMessage[]
  runId: string
  rootRunId: string
  accountId: string
}

/** Detects a compression budget hold left "held" by a crashed prior attempt
 *  and conservatively forfeits it before anything else this call does —
 *  mirrors model-step-runner.ts's ensureForfeitedAndPrepareNext treatment of
 *  a "dispatched"/"unknown_response" model attempt: once a hold reaches
 *  "held", a provider dispatch may or may not have been attempted before
 *  the crash, so charging the whole hold as consumed (never silently
 *  releasing it, never blindly retrying into a possible double charge) is
 *  the only safe assumption. A "planned" record is deliberately left
 *  untouched here — `runCompressionAttempt` resumes it in place instead,
 *  which is always safe (see that function's docstring): the ledger was
 *  either never touched, or admitted under the exact same operationId
 *  either way, so a retry is a harmless idempotent replay, never a second
 *  charge. */
async function reconcileStuckCompressionAttempt(
  deps: DurableAgentDriverDeps,
  checkpoint: AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1> {
  const attempt = checkpoint.compressionAttempt
  if (!attempt || attempt.admission.state !== "held") return checkpoint
  return forfeitCompressionAttempt(deps, checkpoint, attempt.attemptId, attempt.admission)
}

/** Drives one compression-summarizer attempt through the same
 *  planned -> held -> (dispatch) -> settled sequence a real model step
 *  uses, resuming a durably "planned" attempt in place when one already
 *  exists (idempotent-safe — see reconcileStuckCompressionAttempt) or
 *  starting a fresh one otherwise. Every ledger/checkpoint transition is
 *  awaited before the next begins, exactly like model-step-runner.ts's
 *  advanceModelStep. Throws `CompressionAttemptFailure` — never a bare
 *  error — on any failure, always carrying the checkpoint already left in a
 *  consistent (forfeited, where applicable) state. */
async function runCompressionAttempt(
  deps: DurableAgentDriverDeps,
  checkpoint: AgentRunCheckpointV1,
  input: CompressionAttemptInput
): Promise<{ checkpoint: AgentRunCheckpointV1; summary: SummarizeResult }> {
  let cp = checkpoint
  let attemptId: string
  let admission: ModelBudgetAdmission

  const existing = cp.compressionAttempt
  if (existing && existing.admission.state === "planned") {
    // Resume the SAME attempt in place — safe because admitModelAttempt is
    // idempotent per operationId, and every value the admit call needs
    // (operationId/accountId/attemptId/inputUpperBoundTokens/
    // maxOutputTokens) is already durably frozen on this record, so a retry
    // reproduces byte-identical admit parameters regardless of whether the
    // crashed attempt's own ledger write actually landed.
    attemptId = existing.attemptId
    admission = existing.admission
  } else {
    attemptId = randomUUID()
    const operationId = `compress:${input.runId}:${attemptId}`

    const ledgerNow = await deps.budgetStore.load(input.rootRunId)
    const account = ledgerNow.accounts[input.accountId]
    const isUnlimited = account !== undefined && freeBalance(account) === undefined

    const estimate = deps.provider.estimateRequestUpperBound?.(
      summarizerRequestEstimateInput(input.model, input.older)
    )
    if (!estimate && !isUnlimited) {
      throw new CompressionAttemptFailure(
        cp,
        new InsufficientEstimateError(
          `provider ${deps.provider.id} cannot guarantee an upper bound for the summarizer request on run ${input.runId}`
        )
      )
    }

    admission = {
      operationId,
      accountId: input.accountId,
      estimatorId: estimate?.estimatorId ?? "none",
      estimatorVersion: estimate?.estimatorVersion ?? "0",
      inputUpperBoundTokens: estimate?.inputUpperBoundTokens ?? 0,
      maxOutputTokens: DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
      heldTokens: 0,
      state: "planned",
    }
    // Durable "planned" write — BEFORE the ledger is ever touched — so a
    // crash before the ledger admit leaves nothing to reconcile (retrying
    // from "planned" is always a safe idempotent replay; see above).
    cp = await deps.runStore.mutate(cp.identity.runId, cp.revision, (c) => ({
      ...c,
      compressionAttempt: { attemptId, admission },
    }))
    await deps.fault?.("after_compression_prepared")
  }

  if (admission.state === "planned") {
    const heldTokens = admission.inputUpperBoundTokens + admission.maxOutputTokens
    try {
      const ledgerNow = await deps.budgetStore.load(input.rootRunId)
      const { ledger: heldLedger } = admitModelAttempt(ledgerNow, {
        operationId: admission.operationId,
        accountId: admission.accountId,
        attemptId,
        heldTokens,
      })
      await deps.budgetStore.mutate(input.rootRunId, ledgerNow.revision, () => heldLedger)
    } catch (err) {
      throw new CompressionAttemptFailure(cp, err)
    }
    await deps.fault?.("after_compression_hold_ledger")

    admission = { ...admission, heldTokens, state: "held" }
    // Durable "held" write — confirms the ledger admission succeeded. A
    // crash between here and settle/forfeit is exactly what the next
    // call's reconcileStuckCompressionAttempt detects and forfeits.
    cp = await deps.runStore.mutate(cp.identity.runId, cp.revision, (c) => ({
      ...c,
      compressionAttempt: { attemptId, admission },
    }))
    await deps.fault?.("after_compression_hold")
  }

  // admission.state === "held" now, either just transitioned above or
  // resumed directly from a durable "held" record — the latter never
  // actually happens today, since reconcileStuckCompressionAttempt always
  // forfeits a "held" record before this function is ever called again
  // (kept as a defensive fallback, not a reachable path in the current
  // caller).

  let summary: SummarizeResult
  try {
    summary = await summarizeViaProvider(
      deps.provider,
      input.model,
      input.older,
      admission.maxOutputTokens
    )
  } catch (err) {
    const forfeited = await forfeitCompressionAttempt(deps, cp, attemptId, admission)
    throw new CompressionAttemptFailure(forfeited, err)
  }
  await deps.fault?.("after_compression_provider_call")

  const actualTokens = summary.tokens
  try {
    const ledgerNow = await deps.budgetStore.load(input.rootRunId)
    const { ledger: settledLedger } = settleModelAttempt(ledgerNow, {
      operationId: `settle:${admission.operationId}`,
      accountId: admission.accountId,
      attemptId,
      heldTokens: admission.heldTokens,
      actualTokens,
    })
    await deps.budgetStore.mutate(input.rootRunId, ledgerNow.revision, () => settledLedger)
  } catch (err) {
    throw new CompressionAttemptFailure(cp, err)
  }
  await deps.fault?.("after_compression_settle_ledger")

  admission = { ...admission, state: "settled", actualTokens }
  cp = await deps.runStore.mutate(cp.identity.runId, cp.revision, (c) => ({
    ...c,
    compressionAttempt: { attemptId, admission },
  }))
  await deps.fault?.("after_compression_settle")

  return { checkpoint: cp, summary }
}

/** Ledger forfeit + durable checkpoint write, in that order — mirrors
 *  model-step-runner.ts's ensureForfeitedAndPrepareNext. Used both by
 *  reconcileStuckCompressionAttempt (a stuck "held" record from a prior
 *  call) and by runCompressionAttempt's own dispatch-failure path (the
 *  provider call itself threw). */
async function forfeitCompressionAttempt(
  deps: DurableAgentDriverDeps,
  checkpoint: AgentRunCheckpointV1,
  attemptId: string,
  admission: ModelBudgetAdmission
): Promise<AgentRunCheckpointV1> {
  const rootRunId = checkpoint.identity.rootRunId
  const ledgerNow = await deps.budgetStore.load(rootRunId)
  const { ledger: forfeitedLedger } = forfeitModelAttempt(ledgerNow, {
    operationId: `forfeit:${admission.operationId}`,
    accountId: admission.accountId,
    attemptId,
    heldTokens: admission.heldTokens,
  })
  await deps.budgetStore.mutate(rootRunId, ledgerNow.revision, () => forfeitedLedger)
  await deps.fault?.("after_compression_forfeit_ledger")

  const forfeitedAdmission: ModelBudgetAdmission = { ...admission, state: "forfeited" }
  const next = await deps.runStore.mutate(checkpoint.identity.runId, checkpoint.revision, (c) => ({
    ...c,
    compressionAttempt: { attemptId, admission: forfeitedAdmission },
  }))
  await deps.fault?.("after_compression_forfeit_checkpoint")
  return next
}
