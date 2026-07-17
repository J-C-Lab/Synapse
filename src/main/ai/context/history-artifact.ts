import type { AgentArtifactRefSummary } from "@synapse/agent-protocol"
import type {
  AgentArtifactRef,
  AgentArtifactStore,
  ArtifactOwnerContext,
} from "../artifacts/artifact-types"
import type { ChatMessage } from "../providers/types"
import type { DurableChatMessage } from "../runs/durable-messages"
import { toArtifactSummary } from "../artifacts/tool-result-capture"
import { toChatMessages } from "../runs/durable-messages"
import { SUMMARY_PREFIX } from "./context-compressor"

// Durable recoverability for compressed-away conversation history (design
// §"Context compression writes the evicted message slice to a `history`
// artifact and includes that URI in the summary message"). Mirrors
// tool-result-capture.ts's shape: pure decision/composition logic plus one
// `store.capture()` call — no checkpoint mutation, no admission/settlement.
// The caller (durable-agent-driver.ts) is responsible for persisting the
// returned ContextCompactionRecord and for the capture-before-checkpoint-
// commit ordering that keeps a crash between the two merely orphaning the
// artifact (harmless — see tool-batch-runner.ts's identical precedent).
//
// Full V2 conversation history (`AgentRunCheckpointV1.messages`) is never
// mutated by anything in this module — it only ever grows, exactly as
// before. Compaction is a separate, mutable top-level checkpoint field (see
// ContextCompactionRecord) that changes the *model request projection*
// (`projectCompactedMessages`), never the stored conversation.

/** The durably-persisted record of the currently-active compaction, if any.
 *  Always supersedes in full: a later compaction's `evictedThroughMessageId`
 *  always points further into `checkpoint.messages` than the one it
 *  replaces, because eviction always starts from the front of the
 *  projection — which always includes any still-active prior summary at
 *  position 0 (see durable-agent-driver.ts's compression step). There is
 *  therefore only ever one active record, not a list. */
export interface ContextCompactionRecord {
  compactionId: string
  /** The last durable messageId (inclusive) elided from the model-facing
   *  projection. Every message at or before this id in
   *  `checkpoint.messages` is replaced by `summaryText` in
   *  `projectCompactedMessages`; every message after it is still sent
   *  verbatim. Must always resolve to a real id in `checkpoint.messages` —
   *  checkpoint-schema.ts's cross-field invariants enforce this on every
   *  load. */
  evictedThroughMessageId: string
  /** The full model-facing summary text, including the `SUMMARY_PREFIX`
   *  envelope and the trailing artifact guidance footer — ready to use
   *  as-is in `projectCompactedMessages`, never recomputed per request. */
  summaryText: string
  summarizerTokens: number
  artifact: AgentArtifactRefSummary
  /** The full host-only ref backing `artifact`, for read_artifact-style
   *  resolution — mirrors PersistedToolResult/ToolCallResolution's identical
   *  split (Task 19). */
  fullArtifact?: AgentArtifactRef
  createdAt: number
}

export class ContextCompactionCorruptionError extends Error {
  constructor(messageId: string) {
    super(`context compaction references unknown durable message id ${messageId}`)
    this.name = "ContextCompactionCorruptionError"
  }
}

/** The durable message tail still subject to compression this round: every
 *  message after the active compaction's cutoff (or the whole list, when
 *  nothing has been compacted yet). Exported so durable-agent-driver.ts's
 *  compression step can map a freshly-evicted `ChatMessage[]` prefix back to
 *  real `DurableChatMessage`s (with stable messageIds) by position, using
 *  exactly the same slice `projectCompactedMessages` itself projects from —
 *  the two must never disagree about where "the tail" begins. */
export function durableTailAfterCompaction(
  messages: readonly DurableChatMessage[],
  compaction: ContextCompactionRecord | undefined
): DurableChatMessage[] {
  if (!compaction) return [...messages]
  const cutoff = messages.findIndex((m) => m.messageId === compaction.evictedThroughMessageId)
  if (cutoff === -1) throw new ContextCompactionCorruptionError(compaction.evictedThroughMessageId)
  return messages.slice(cutoff + 1)
}

/** Builds the exact messages a model request is assembled from, applying
 *  the active compaction (if any) as a pure projection over the full,
 *  untouched durable message list. Every model-step caller
 *  (model-step-runner.ts's outgoingRequestContext) and the compression
 *  decision step (durable-agent-driver.ts) both go through this so they
 *  never disagree about what "the current conversation" looks like. */
export function projectCompactedMessages(
  messages: readonly DurableChatMessage[],
  compaction: ContextCompactionRecord | undefined
): ChatMessage[] {
  if (!compaction) return toChatMessages(messages)
  const tail = toChatMessages(durableTailAfterCompaction(messages, compaction))
  return [{ role: "user", content: [{ type: "text", text: compaction.summaryText }] }, ...tail]
}

/** Derives the ArtifactOwnerContext a history artifact is captured under
 *  from a run's frozen identity — mirrors tool-batch-runner.ts's
 *  artifactOwnerFromCaller derivation, adapted for a host-internal capture
 *  (compression is never triggered by a ToolCaller) rather than a tool
 *  invocation. `actor` comes from the frozen authority principal
 *  (`checkpoint.config.authority.principal.actor`), the only signal this
 *  run's identity carries about who it runs on behalf of. */
export function deriveHistoryArtifactOwner(
  identity: {
    runId: string
    rootRunId: string
    parentRunId?: string
    conversationId?: string
    workspaceId?: string
  },
  actor: "user" | "background"
): ArtifactOwnerContext {
  return {
    runId: identity.runId,
    rootRunId: identity.rootRunId,
    parentRunId: identity.parentRunId,
    conversationId: identity.conversationId,
    workspaceId: identity.workspaceId,
    principal: actor === "background" ? { kind: "internal-agent" } : { kind: "local-user" },
  }
}

/** Captures the exact evicted durable-message slice as full-fidelity JSON
 *  (never a lossy text rendering — the whole point of this artifact is
 *  exact recoverability) so `read_artifact` can recover it byte-for-byte,
 *  including any Unicode content. Throws whatever `store.capture()` itself
 *  throws (e.g. a hard quota exhaustion) — never caught here. The caller
 *  must treat any throw as "nothing was evicted, this compression attempt
 *  failed" (design §"Offload failure does not silently discard content"),
 *  not attempt a smaller inline fallback: unlike a single oversized tool
 *  result, there is no safe smaller representation of "the conversation no
 *  longer fits" that helps. */
export async function captureHistorySlice(
  store: AgentArtifactStore,
  owner: ArtifactOwnerContext,
  runId: string,
  evicted: readonly DurableChatMessage[]
): Promise<AgentArtifactRef> {
  const bytes = new TextEncoder().encode(JSON.stringify(evicted))
  return store.capture(
    bytes,
    {
      runId,
      owner,
      kind: "history",
      mediaType: "application/json; charset=utf-8",
      sourceBytes: bytes.byteLength,
    },
    // A plain in-memory Uint8Array capture has nothing live to cancel — same
    // rationale as tool-result-capture.ts's identical no-op abort.
    { abort: () => {} }
  )
}

/** Builds the final, guidance-augmented summary text embedded into the
 *  synthetic summary message `projectCompactedMessages` prepends —
 *  design §"Include URI/hash/range guidance in the summary message". Always
 *  starts with `SUMMARY_PREFIX` (so `isSummaryMessage()` still recognizes
 *  it) and always names the artifact, even when the LLM summarizer itself
 *  failed for this round (`rawSummaryText` undefined) — the archived slice
 *  is always fully recoverable via the artifact regardless of whether a
 *  readable recap was produced, so the guidance footer is never
 *  conditional on summarization having succeeded. */
export function buildCompactionSummaryText(
  rawSummaryText: string | undefined,
  ref: AgentArtifactRef,
  archivedMessageCount: number
): string {
  const body =
    rawSummaryText && rawSummaryText.trim().length > 0
      ? rawSummaryText.trim()
      : "(automatic summarization was unavailable for this archived slice; the exact original " +
        "messages are still fully recoverable from the artifact below)"
  return `${SUMMARY_PREFIX}\n${body}${buildArtifactGuidance(ref, archivedMessageCount)}`
}

function buildArtifactGuidance(ref: AgentArtifactRef, archivedMessageCount: number): string {
  const status = ref.complete
    ? "complete"
    : `incomplete (truncationReason=${ref.truncationReason ?? "unknown"})`
  return (
    `\n\n[Synapse history artifact: ${ref.uri} | kind=${ref.kind} | mediaType=${ref.mediaType} | ` +
    `archivedMessages=${archivedMessageCount} | capturedBytes=${ref.capturedBytes} | ` +
    `sha256=${ref.sha256} | ${status} — use read_artifact with this uri to recover the exact ` +
    `archived conversation slice as JSON]`
  )
}

export interface BuildCompactionRecordInput {
  compactionId: string
  evictedThroughMessageId: string
  rawSummaryText?: string
  summarizerTokens: number
  artifact: AgentArtifactRef
  archivedMessageCount: number
  now: number
}

/** Composes everything above into the one record durable-agent-driver.ts
 *  persists onto the checkpoint. */
export function buildCompactionRecord(input: BuildCompactionRecordInput): ContextCompactionRecord {
  return {
    compactionId: input.compactionId,
    evictedThroughMessageId: input.evictedThroughMessageId,
    summaryText: buildCompactionSummaryText(
      input.rawSummaryText,
      input.artifact,
      input.archivedMessageCount
    ),
    summarizerTokens: input.summarizerTokens,
    artifact: toArtifactSummary(input.artifact),
    fullArtifact: input.artifact,
    createdAt: input.now,
  }
}
