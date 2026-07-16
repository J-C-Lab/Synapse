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
  RunFinalizationPhase,
} from "./events"

/** Where one tool call currently stands — derived from its approval +
 *  resolution + latest execution attempt, never the raw ledger shape (which
 *  stays host-only). A reload rehydrates a tool card's placement/state from
 *  this without ever re-deriving it from scratch or guessing. */
export type AgentRunToolCallStatus =
  | "pending_approval"
  | "approved"
  | "denied"
  | "running"
  | "completed"
  | "unknown"

export interface AgentRunToolCallSummary {
  ordinal: number
  modelStep: number
  assistantMessageId?: string
  toolUseId: string
  safeName: string
  fqName: string
  status: AgentRunToolCallStatus
  isError?: boolean
  /** Bounded preview text — never the full tool result, matching the same
   *  never-duplicate-tool-arguments-or-results boundary run-projection.ts's
   *  header already documents. */
  resultPreview?: string
}

export type AgentRunModelAttemptState =
  | "prepared"
  | "held"
  | "dispatched"
  | "unknown_response"
  | "response_staged"
  | "budget_settled"

/** The most recent model step's latest attempt — enough for a "model is
 *  thinking / awaiting a response" indicator to survive a reload without
 *  re-deriving it from the event stream from scratch. */
export interface AgentRunModelStepSummary {
  step: number
  state: AgentRunModelAttemptState
  assistantMessageId?: string
}

/** Structural correlation plus bounded assistant text for the one period
 * before a durable result has committed to the conversation transcript. */
export interface AgentRunMessageSummary {
  messageId: string
  producedByRunId?: string
  role: "user" | "assistant"
  ordinal: number
  /** Bounded durable text for an in-flight turn that has not yet been
   * committed to the conversation transcript. */
  text?: string
}

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
  messages: AgentRunMessageSummary[]
  toolCalls: AgentRunToolCallSummary[]
  currentModelStep?: AgentRunModelStepSummary
  finalizationPhase?: RunFinalizationPhase
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
