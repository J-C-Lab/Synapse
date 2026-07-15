import type { AgentRunSnapshot, AgentRunSummary } from "@synapse/agent-protocol"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"

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
    // activeChildTaskId — and no artifact store (Checkpoint B). Both stay
    // empty until those checkpoints land; this function's shape is already
    // forward-compatible with them.
    childTasks: [],
    artifacts: [],
  }
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
