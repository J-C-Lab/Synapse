// Renderer-facing projections of durable run state. These are the shapes a
// snapshot/subscribe consumer receives — never the host-only checkpoint
// internals (frozen config, ledgers, budget ledger, ...), which stay in
// src/main/ai/runs and are never imported here.

import type {
  AgentArtifactRefSummary,
  AgentChildTaskSummary,
  AgentRunIdentity,
  AgentRunPlanStep,
  AgentRunStatus,
  RecoveryDisposition,
} from "./events"

/** Point-in-time view of one run, returned by getRunSnapshot and rebuilt by
 *  the renderer reducer from persisted events after the snapshot's sequence. */
export interface AgentRunSnapshot {
  identity: AgentRunIdentity
  status: AgentRunStatus
  recovery: RecoveryDisposition
  /** Sequence of the last event folded into this snapshot; subscribe from here. */
  lastSequence: number
  createdAt: number
  updatedAt: number
  plan?: AgentRunPlanStep[]
  pendingApprovalIds: string[]
  childTasks: AgentChildTaskSummary[]
  artifacts: AgentArtifactRefSummary[]
}

/** Lightweight row for run pickers/lists — one per run, no ledger detail. */
export interface AgentRunSummary {
  runId: string
  conversationId?: string
  rootRunId: string
  origin: AgentRunIdentity["origin"]
  status: AgentRunStatus
  recovery: RecoveryDisposition
  createdAt: number
  updatedAt: number
}
