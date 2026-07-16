import type { RecoveryDisposition } from "@synapse/agent-protocol"
import type { FrozenAuthoritySnapshotV1 } from "./authority-snapshot"
import type { CanonicalJson } from "./canonical-json"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { FrozenContextSnapshotV1 } from "./context-snapshot"
import { createHash } from "node:crypto"
import {
  compareCapabilityGrant,
  compareToolAuthority,
  principalMatches,
} from "./authority-snapshot"
import { canonicalHash } from "./canonical-json"

// Pure recovery classification (design §"Run recovery service and startup
// UX"): given one checkpoint and the live state it must be reconciled
// against, decides the single RecoveryDisposition the run gets — never a
// branch on an exception string. All comparison is delegated to the
// structural comparators from authority-snapshot.ts; this module owns only
// the priority ordering (blocked always wins over requires_review) and the
// checks authority-snapshot.ts doesn't already do: context integrity,
// workspace binding drift, deadlines, and unknown tool outcomes.
//
// Deliberately out of scope for Checkpoint A: "required-artifact-missing-
// or-corrupt" (the artifact store lands in Checkpoint B) and proactive
// conversation-content-revision drift detection (ConversationStore doesn't
// expose contentRevision through its public surface yet). A run already
// sitting in `suspended_conversation_conflict` is still classified —
// that status is handled first, below, since RUN_STATUS_TRANSITIONS only
// lets it reach `terminalizing`, never `running` again.

export interface RecoveryClassifierInput {
  /** The live authority a fresh run would freeze today, in the same shape
   *  as `checkpoint.config.authority`. */
  currentAuthority: FrozenAuthoritySnapshotV1
  /** Undefined when the checkpoint has no bound conversation (skips the
   *  check entirely); otherwise whether that conversation id still exists
   *  (active or tombstoned both count as "exists" here — a live
   *  ConversationStore.get() already treats tombstoned as "not found",
   *  which is exactly the distinction this check needs). */
  conversationExists?: boolean
  /** Undefined skips the check. */
  currentWorkspaceRootSetHash?: string
  now: number
}

export function classifyRunRecovery(
  checkpoint: AgentRunCheckpointV1,
  input: RecoveryClassifierInput
): RecoveryDisposition {
  if (checkpoint.status === "suspended_conversation_conflict") {
    return { kind: "requires_review", reason: "conversation-conflict" }
  }

  // --- blocked checks: fail closed, checked unconditionally first -------

  if (checkpoint.identity.conversationId !== undefined && input.conversationExists === false) {
    return { kind: "blocked", reason: "conversation-deleted-or-missing" }
  }

  // The earliest v1 background checkpoints predate persisted execution
  // policy altogether. Unlike the later v1 form, there is no safe way to
  // infer either a tool-call cap or a timeout from their durable bytes, so
  // fail closed before resume() can move them to running.
  if (
    checkpoint.identity.origin === "background-agent" &&
    checkpoint.config.backgroundExecution === undefined
  ) {
    return { kind: "blocked", reason: "background-execution-policy-missing" }
  }

  if (!principalMatches(checkpoint.config.authority.principal, input.currentAuthority.principal)) {
    return { kind: "blocked", reason: "authority-revoked" }
  }

  const currentCapabilities = new Map(input.currentAuthority.capabilities.map((c) => [c.id, c]))
  let anyCapabilityNarrowed = false
  for (const grant of checkpoint.config.authority.capabilities) {
    const outcome = compareCapabilityGrant(grant, currentCapabilities.get(grant.id))
    if (outcome === "adapter-missing" || outcome === "adapter-version-mismatch") {
      return { kind: "blocked", reason: "authority-adapter-incompatible" }
    }
    if (outcome === "revoked") return { kind: "blocked", reason: "authority-revoked" }
    if (outcome === "narrowed") anyCapabilityNarrowed = true
  }

  const currentTools = new Map(input.currentAuthority.tools.map((t) => [t.fqName, t]))
  let anyToolChangedOrRemoved = false
  let anyToolNarrowed = false
  for (const tool of checkpoint.config.authority.tools) {
    const outcome = compareToolAuthority(tool, currentTools.get(tool.fqName), currentCapabilities)
    if (outcome.kind === "blocked")
      return { kind: "blocked", reason: "authority-adapter-incompatible" }
    if (outcome.kind === "removed" || outcome.kind === "changed") anyToolChangedOrRemoved = true
    if (outcome.kind === "narrowed") anyToolNarrowed = true
  }

  if (!contextSnapshotIsIntact(checkpoint.config.context)) {
    return { kind: "blocked", reason: "frozen-context-corrupt" }
  }

  if (checkpoint.config.deadlineAt !== undefined && input.now >= checkpoint.config.deadlineAt) {
    return { kind: "blocked", reason: "deadline-expired" }
  }

  // --- requires_review checks --------------------------------------------

  if (anyToolChangedOrRemoved) {
    return { kind: "requires_review", reason: "tool-removed-or-changed" }
  }
  if (
    input.currentWorkspaceRootSetHash !== undefined &&
    input.currentWorkspaceRootSetHash !== checkpoint.config.workspaceBinding.rootSetHash
  ) {
    return { kind: "requires_review", reason: "workspace-binding-changed" }
  }
  if (anyCapabilityNarrowed || anyToolNarrowed) {
    return { kind: "requires_review", reason: "authority-narrowed" }
  }
  if (hasUnknownToolOutcome(checkpoint)) {
    return { kind: "requires_review", reason: "unknown-tool-outcome" }
  }

  return { kind: "automatic" }
}

/** Stable comparison basis for an explicit recovery decision. Deliberately
 * excludes `now` and checkpoint revision: neither changes the live drift a
 * user reviewed. A changed authority/workspace or tool-attempt state does. */
export function recoveryReviewBasisHash(
  checkpoint: AgentRunCheckpointV1,
  input: RecoveryClassifierInput,
  reason: Exclude<RecoveryDisposition, { kind: "automatic" } | { kind: "blocked" }>["reason"]
): string {
  return canonicalHash({
    reason,
    currentAuthority: input.currentAuthority as unknown as CanonicalJson,
    conversationExists: input.conversationExists ?? null,
    currentWorkspaceRootSetHash: input.currentWorkspaceRootSetHash ?? null,
    unresolvedAttempts: checkpoint.toolBatches.flatMap((batch) =>
      batch.calls.flatMap((call) => {
        if (call.resolution.status === "resolved") return []
        const latest = call.attempts[call.attempts.length - 1]
        if (!latest) return []
        return [
          {
            modelStep: batch.modelStep,
            ordinal: call.ordinal,
            toolUseId: call.toolUseId,
            attemptId: latest.attemptId,
            state: latest.state.status,
          },
        ]
      })
    ),
  })
}

/** A pending tool call whose latest attempt never reached a durable
 *  "completed"/"unknown" resolution — either genuinely interrupted
 *  ("started") or already classified unrecoverable by a prior pass
 *  ("unknown") — must never auto-resume without a human decision. */
function hasUnknownToolOutcome(checkpoint: AgentRunCheckpointV1): boolean {
  return checkpoint.toolBatches.some((batch) =>
    batch.calls.some((call) => {
      if (call.resolution.status === "resolved") return false
      const latest = call.attempts[call.attempts.length - 1]
      return (
        latest !== undefined &&
        (latest.state.status === "started" || latest.state.status === "unknown")
      )
    })
  )
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Re-derives every hash the context snapshot carries and checks it against
 *  what's stored — the same construction context-snapshot.ts's
 *  buildContextSnapshot uses, so a genuinely untouched checkpoint always
 *  passes and any bit-level corruption always fails. */
function contextSnapshotIsIntact(context: FrozenContextSnapshotV1): boolean {
  if (sha256(context.baseSystemPrompt.normalizedText) !== context.baseSystemPrompt.sha256) {
    return false
  }
  for (const instruction of context.workspaceInstructions) {
    if (sha256(instruction.normalizedText) !== instruction.sha256) return false
  }
  const aggregateHash = sha256(
    [context.baseSystemPrompt.sha256, ...context.workspaceInstructions.map((i) => i.sha256)].join(
      "|"
    )
  )
  return aggregateHash === context.aggregateHash
}
