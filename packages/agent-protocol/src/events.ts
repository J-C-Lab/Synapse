// Renderer-safe durable-run lifecycle vocabulary shared by main, preload, and
// renderer. Types and pure functions only — no Node or Electron runtime
// dependency, so this module is safe to import from every process. Host-only
// checkpoint internals (frozen config, ledgers, budget accounting, ...) live
// in src/main/ai/runs instead of here.

/** Who started a run. Kept in sync with AgentRunIdentity.origin below. */
export type AgentRunOrigin = "interactive" | "background-agent" | "subagent"

export type AgentRunStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "waiting_child"
  | "suspended_unknown_tool_outcome"
  | "suspended_conversation_conflict"
  | "terminalizing"
  | "completed"
  | "cancelled"
  | "failed"

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "completed",
  "cancelled",
  "failed",
])

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export type RecoveryReviewReason =
  | "unknown-tool-outcome"
  | "authority-narrowed"
  | "tool-removed-or-changed"
  | "workspace-binding-changed"
  | "conversation-conflict"

export type RecoveryBlockedReason =
  | "unsupported-checkpoint-version"
  | "conversation-deleted-or-missing"
  | "authority-revoked"
  | "authority-adapter-incompatible"
  | "frozen-context-corrupt"
  | "required-artifact-missing-or-corrupt"
  | "deadline-expired"

export type RecoveryDisposition =
  | { kind: "automatic" }
  | { kind: "requires_review"; reason: RecoveryReviewReason }
  | { kind: "blocked"; reason: RecoveryBlockedReason }

export interface AgentRunIdentity {
  runId: string
  conversationId?: string
  parentRunId?: string
  rootRunId: string
  origin: AgentRunOrigin
  workspaceId?: string
  invocationId?: string
  triggerInstanceId?: string
}

/** The six finalization phases a run passes through on its way to a terminal status. */
export type RunFinalizationPhase =
  | "prepared"
  | "conversation_committed"
  | "trace_upserted"
  | "resources_released"
  | "conversation_lease_released"
  | "complete"

/** Bounded, renderer-facing view of an artifact reference. The full
 *  host-owned AgentArtifactRef (allocation/retention internals) is defined
 *  alongside the artifact store in Checkpoint B and layered onto this shape. */
export interface AgentArtifactRefSummary {
  uri: `artifact://run/${string}/${string}`
  kind: string
  mediaType: string
  capturedBytes: number
  complete: boolean
  truncationReason?: string
}

export interface AgentChildTaskSummary {
  childRunId: string
  status: AgentRunStatus
  label?: string
}

export interface AgentRunEventBase {
  schemaVersion: 1
  eventId: string
  runId: string
  rootRunId: string
  parentRunId?: string
  conversationId?: string
  sequence: number
  timestamp: number
  /** false for renderer-optimization deltas (e.g. text streaming) that are
   *  never written to the durable event journal. */
  persisted: boolean
}

export interface RunStartedEvent extends AgentRunEventBase {
  type: "run_started"
  origin: AgentRunOrigin
  workspaceId?: string
}

export interface RunStatusChangedEvent extends AgentRunEventBase {
  type: "run_status_changed"
  status: AgentRunStatus
  recovery: RecoveryDisposition
}

export interface TextDeltaEvent extends AgentRunEventBase {
  type: "text_delta"
  text: string
}

export interface BudgetAdmissionUpdatedEvent extends AgentRunEventBase {
  type: "budget_admission_updated"
  operationId: string
  state: "planned" | "held" | "settled" | "forfeited"
  heldTokens?: number
  consumedTokens?: number
}

export interface ModelCompletedEvent extends AgentRunEventBase {
  type: "model_completed"
  step: number
  assistantMessageId: string
  inputTokens: number
  outputTokens: number
}

export interface ToolRequestedEvent extends AgentRunEventBase {
  type: "tool_requested"
  modelStep: number
  ordinal: number
  toolUseId: string
  safeName: string
  fqName: string
}

export interface ApprovalPendingEvent extends AgentRunEventBase {
  type: "approval_pending"
  approvalId: string
  ordinal: number
  safeName: string
}

export type ApprovalRememberScope = "once" | "conversation" | "always"

export interface ApprovalResolvedEvent extends AgentRunEventBase {
  type: "approval_resolved"
  approvalId: string
  allowed: boolean
  remember: ApprovalRememberScope
}

export interface ToolStartedEvent extends AgentRunEventBase {
  type: "tool_started"
  ordinal: number
  toolUseId: string
  attemptId: string
}

export interface ToolCompletedEvent extends AgentRunEventBase {
  type: "tool_completed"
  ordinal: number
  toolUseId: string
  attemptId: string
  isError: boolean
  complete: boolean
  artifact?: AgentArtifactRefSummary
}

export interface ArtifactCreatedEvent extends AgentRunEventBase {
  type: "artifact_created"
  artifact: AgentArtifactRefSummary
}

export type AgentRunPlanStepStatus = "pending" | "in_progress" | "completed"

export interface AgentRunPlanStep {
  title: string
  status: AgentRunPlanStepStatus
}

export interface PlanUpdatedEvent extends AgentRunEventBase {
  type: "plan_updated"
  plan: AgentRunPlanStep[]
}

export interface ChildTaskUpdatedEvent extends AgentRunEventBase {
  type: "child_task_updated"
  child: AgentChildTaskSummary
}

export interface ChildOwnershipLeaseUpdatedEvent extends AgentRunEventBase {
  type: "child_ownership_lease_updated"
  childRunId: string
  leaseExpiresAt: number
  fencingToken: number
}

export interface FinalizationPhaseUpdatedEvent extends AgentRunEventBase {
  type: "finalization_phase_updated"
  finalizationId: string
  phase: RunFinalizationPhase
}

export interface CheckpointCommittedEvent extends AgentRunEventBase {
  type: "checkpoint_committed"
  revision: number
}

export interface RunCompletedEvent extends AgentRunEventBase {
  type: "run_completed"
  outcome: "completed"
}

export interface RunFailedEvent extends AgentRunEventBase {
  type: "run_failed"
  outcome: "failed" | "cancelled"
  reason?: string
}

export type AgentRunEvent =
  | RunStartedEvent
  | RunStatusChangedEvent
  | TextDeltaEvent
  | BudgetAdmissionUpdatedEvent
  | ModelCompletedEvent
  | ToolRequestedEvent
  | ApprovalPendingEvent
  | ApprovalResolvedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ArtifactCreatedEvent
  | PlanUpdatedEvent
  | ChildTaskUpdatedEvent
  | ChildOwnershipLeaseUpdatedEvent
  | FinalizationPhaseUpdatedEvent
  | CheckpointCommittedEvent
  | RunCompletedEvent
  | RunFailedEvent

/** Exhaustiveness guard: a compile error here means a new AgentRunEvent
 *  variant was added without a matching case in describeRunEvent. */
function assertUnreachable(x: never): never {
  throw new Error(`Unreachable AgentRunEvent variant: ${JSON.stringify(x)}`)
}

/** Pure, renderer-safe label for one event — used by diagnostics/logging
 *  projections that don't want to duplicate the discriminated union. */
export function describeRunEvent(event: AgentRunEvent): string {
  switch (event.type) {
    case "run_started":
    case "run_status_changed":
    case "text_delta":
    case "budget_admission_updated":
    case "model_completed":
    case "tool_requested":
    case "approval_pending":
    case "approval_resolved":
    case "tool_started":
    case "tool_completed":
    case "artifact_created":
    case "plan_updated":
    case "child_task_updated":
    case "child_ownership_lease_updated":
    case "finalization_phase_updated":
    case "checkpoint_committed":
    case "run_completed":
    case "run_failed":
      return `${event.type}#${event.sequence}`
    default:
      return assertUnreachable(event)
  }
}
