import type { AgentArtifactStore } from "../artifacts/artifact-types"
import type { ChatContentBlock } from "../providers/types"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { ModelStepDeps } from "./model-step-runner"
import { randomUUID } from "node:crypto"
import { ROOT_ACCOUNT_ID } from "../budget/root-budget-ledger"
import { ContextCompressor } from "../context/context-compressor"
import {
  buildCompactionRecord,
  captureHistorySlice,
  deriveHistoryArtifactOwner,
  durableTailAfterCompaction,
  projectCompactedMessages,
} from "../context/history-artifact"
import { summarizeViaProvider } from "../context/summarize-via-provider"
import { assembleFromContextSnapshot } from "./context-snapshot"
import { advanceModelStep } from "./model-step-runner"

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
 *  `contextCompaction` changes, per this file's top-of-file note. */
async function maybeCompressHistory(
  deps: DurableAgentDriverDeps,
  checkpoint: AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1 | undefined> {
  const policy = checkpoint.config.contextCompression
  if (!policy.enabled) return undefined

  const runId = checkpoint.identity.runId
  const rootRunId = checkpoint.identity.rootRunId
  const accountId = budgetAccountIdFor(checkpoint)

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

  const compressor = new ContextCompressor({
    thresholdTokens: Math.max(0, policy.thresholdTokens - policy.hardReserveTokens),
    keepFraction: policy.keepRecentFraction,
    summarize: (older) =>
      summarizeViaProvider({
        provider: deps.provider,
        model: checkpoint.config.model,
        older,
        budgetStore: deps.budgetStore,
        rootRunId,
        accountId,
        runId,
        compactionAttemptId: randomUUID(),
      }),
  })

  const result = await compressor.compress(system, projected)
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
