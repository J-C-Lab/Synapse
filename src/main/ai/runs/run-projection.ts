import type {
  AgentArtifactRefSummary,
  AgentRunMessageSummary,
  AgentRunModelStepSummary,
  AgentRunSnapshot,
  AgentRunSummary,
  AgentRunToolCallSummary,
} from "@synapse/agent-protocol"
import type { AgentRunCheckpointV1, ToolCallLedgerEntry } from "./checkpoint-schema"

// Pure projections from the host-only AgentRunCheckpointV1 into the
// renderer-safe shapes defined in @synapse/agent-protocol. Never exposes
// tool arguments/results, ledger internals, or frozen authority/context —
// only what a run picker, the observatory, or a recovery UI needs.

export function toAgentRunSummary(checkpoint: AgentRunCheckpointV1): AgentRunSummary {
  return {
    runId: checkpoint.identity.runId,
    conversationId: checkpoint.identity.conversationId,
    rootRunId: checkpoint.identity.rootRunId,
    origin: checkpoint.identity.origin,
    status: checkpoint.status,
    recovery: checkpoint.recovery,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
  }
}

/** `lastSequence` comes from the caller (the durable event journal's current
 *  last sequence for this run) rather than being read here, so this stays a
 *  pure function of the checkpoint alone and doesn't need a store dependency
 *  to unit test. */
export function toAgentRunSnapshot(
  checkpoint: AgentRunCheckpointV1,
  lastSequence: number
): AgentRunSnapshot {
  return {
    identity: checkpoint.identity,
    status: checkpoint.status,
    recovery: checkpoint.recovery,
    lastSequence,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    plan: checkpoint.plan,
    pendingApprovalIds: pendingApprovalIds(checkpoint),
    // Checkpoint A has no rich child-task ledger — only a single optional
    // activeChildTaskId. Stays empty until a later checkpoint adds one;
    // this function's shape is already forward-compatible with it.
    childTasks: [],
    artifacts: artifactSummaries(checkpoint),
    messages: messageSummaries(checkpoint),
    toolCalls: toolCallSummaries(checkpoint),
    currentModelStep: currentModelStepSummary(checkpoint),
    finalizationPhase: checkpoint.finalization?.phase,
  }
}

/** Every distinct artifact this run's checkpoint currently references,
 *  deduped by uri (Task 21) — completed tool-result offloads, activated
 *  skill instruction bundles, and the currently-active context-compaction
 *  history artifact. Deliberately does NOT include
 *  `supersededCompactionArtifactUris` (checkpoint-schema.ts): those are
 *  bare uri strings with no captured `AgentArtifactRefSummary` locally
 *  available, and this is a pure projection with no store access to look
 *  one up — a caller that needs a superseded artifact's status can query it
 *  individually via the runs:getArtifactStatus IPC channel by uri. */
function artifactSummaries(checkpoint: AgentRunCheckpointV1): AgentArtifactRefSummary[] {
  const byUri = new Map<string, AgentArtifactRefSummary>()
  for (const batch of checkpoint.toolBatches) {
    for (const call of batch.calls) {
      if (call.resolution.status === "resolved" && call.resolution.result.artifact) {
        byUri.set(call.resolution.result.artifact.uri, call.resolution.result.artifact)
      }
    }
  }
  for (const skill of checkpoint.activatedSkills) {
    byUri.set(skill.instructionsArtifact.uri, skill.instructionsArtifact)
  }
  if (checkpoint.contextCompaction) {
    byUri.set(checkpoint.contextCompaction.artifact.uri, checkpoint.contextCompaction.artifact)
  }
  return [...byUri.values()]
}

function pendingApprovalIds(checkpoint: AgentRunCheckpointV1): string[] {
  const ids: string[] = []
  for (const batch of checkpoint.toolBatches) {
    for (const call of batch.calls) {
      if (call.approval.status === "pending") ids.push(call.approval.approvalId)
    }
  }
  return ids
}

function messageSummaries(checkpoint: AgentRunCheckpointV1): AgentRunMessageSummary[] {
  return checkpoint.messages.map((entry, ordinal) => {
    const text =
      entry.message.role === "assistant"
        ? entry.message.content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("")
            .slice(0, 16_000)
        : ""
    return {
      messageId: entry.messageId,
      ...(entry.producedByRunId ? { producedByRunId: entry.producedByRunId } : {}),
      role: entry.message.role,
      ordinal,
      ...(text ? { text } : {}),
    }
  })
}

function toolCallSummaries(checkpoint: AgentRunCheckpointV1): AgentRunToolCallSummary[] {
  const summaries: AgentRunToolCallSummary[] = []
  for (const batch of checkpoint.toolBatches) {
    for (const call of batch.calls) {
      summaries.push({
        ordinal: call.ordinal,
        modelStep: batch.modelStep,
        assistantMessageId: batch.assistantMessageId,
        toolUseId: call.toolUseId,
        safeName: call.safeName,
        fqName: call.fqName,
        status: toolCallStatus(call),
        ...(call.resolution.status === "resolved"
          ? {
              isError: call.resolution.result.isError,
              resultPreview: call.resolution.result.preview,
            }
          : {}),
      })
    }
  }
  return summaries
}

function toolCallStatus(call: ToolCallLedgerEntry): AgentRunToolCallSummary["status"] {
  if (call.resolution.status === "resolved") {
    if (
      call.resolution.reason === "approval-denied" ||
      call.resolution.reason === "policy-denied"
    ) {
      return "denied"
    }
    return "completed"
  }
  if (call.approval.status === "pending") return "pending_approval"
  const latest = call.attempts[call.attempts.length - 1]
  if (!latest) return "approved"
  if (latest.state.status === "started") return "running"
  if (latest.state.status === "unknown") return "unknown"
  return "approved"
}

function currentModelStepSummary(
  checkpoint: AgentRunCheckpointV1
): AgentRunModelStepSummary | undefined {
  const step = checkpoint.modelSteps[checkpoint.modelSteps.length - 1]
  if (!step) return undefined
  const attempt = step.attempts[step.attempts.length - 1]
  if (!attempt) return undefined
  return {
    step: step.step,
    state: attempt.state,
    assistantMessageId: attempt.assistantMessageId,
  }
}
