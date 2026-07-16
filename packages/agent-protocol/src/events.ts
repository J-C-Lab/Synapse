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
  /** Durable source identity for a background trigger; absent for interactive/subagent runs. */
  pluginId?: string
  triggerId?: string
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
  assistantMessageId: string
  toolUseId: string
  safeName: string
  fqName: string
}

export interface ApprovalPendingEvent extends AgentRunEventBase {
  type: "approval_pending"
  approvalId: string
  modelStep: number
  ordinal: number
  toolUseId: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
}

function isRecoveryDisposition(value: unknown): value is RecoveryDisposition {
  if (!isRecord(value) || !isString(value.kind)) return false
  if (value.kind === "automatic") return true
  return (value.kind === "requires_review" || value.kind === "blocked") && isString(value.reason)
}

function isArtifactSummary(value: unknown): value is AgentArtifactRefSummary {
  return (
    isRecord(value) &&
    isString(value.uri) &&
    isString(value.kind) &&
    isString(value.mediaType) &&
    isNonNegativeInteger(value.capturedBytes) &&
    typeof value.complete === "boolean" &&
    (value.truncationReason === undefined || isString(value.truncationReason))
  )
}

/** Runtime validation for the JSONL boundary. The event journal is an
 * untrusted diagnostic projection after a crash, so parsing it must never
 * turn arbitrary JSON into the protocol's discriminated union by assertion. */
export function isAgentRunEvent(value: unknown): value is AgentRunEvent {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isString(value.eventId) ||
    !isString(value.runId) ||
    !isString(value.rootRunId) ||
    !isNonNegativeInteger(value.sequence) ||
    value.sequence < 1 ||
    !isFiniteNumber(value.timestamp) ||
    typeof value.persisted !== "boolean" ||
    (value.parentRunId !== undefined && !isString(value.parentRunId)) ||
    (value.conversationId !== undefined && !isString(value.conversationId)) ||
    !isString(value.type)
  ) {
    return false
  }

  switch (value.type) {
    case "run_started":
      return (
        (value.origin === "interactive" ||
          value.origin === "background-agent" ||
          value.origin === "subagent") &&
        (value.workspaceId === undefined || isString(value.workspaceId))
      )
    case "run_status_changed":
      return (
        [
          "created",
          "running",
          "waiting_approval",
          "waiting_child",
          "suspended_unknown_tool_outcome",
          "suspended_conversation_conflict",
          "terminalizing",
          "completed",
          "cancelled",
          "failed",
        ].includes(value.status as string) && isRecoveryDisposition(value.recovery)
      )
    case "text_delta":
      return isString(value.text)
    case "budget_admission_updated":
      return (
        isString(value.operationId) &&
        ["planned", "held", "settled", "forfeited"].includes(value.state as string) &&
        (value.heldTokens === undefined || isNonNegativeInteger(value.heldTokens)) &&
        (value.consumedTokens === undefined || isNonNegativeInteger(value.consumedTokens))
      )
    case "model_completed":
      return (
        isNonNegativeInteger(value.step) &&
        isString(value.assistantMessageId) &&
        isNonNegativeInteger(value.inputTokens) &&
        isNonNegativeInteger(value.outputTokens)
      )
    case "tool_requested":
      return (
        isNonNegativeInteger(value.modelStep) &&
        isNonNegativeInteger(value.ordinal) &&
        isString(value.assistantMessageId) &&
        isString(value.toolUseId) &&
        isString(value.safeName) &&
        isString(value.fqName)
      )
    case "approval_pending":
      return (
        isString(value.approvalId) &&
        isNonNegativeInteger(value.modelStep) &&
        isNonNegativeInteger(value.ordinal) &&
        isString(value.toolUseId) &&
        isString(value.safeName)
      )
    case "approval_resolved":
      return (
        isString(value.approvalId) &&
        typeof value.allowed === "boolean" &&
        ["once", "conversation", "always"].includes(value.remember as string)
      )
    case "tool_started":
      return (
        isNonNegativeInteger(value.ordinal) &&
        isString(value.toolUseId) &&
        isString(value.attemptId)
      )
    case "tool_completed":
      return (
        isNonNegativeInteger(value.ordinal) &&
        isString(value.toolUseId) &&
        isString(value.attemptId) &&
        typeof value.isError === "boolean" &&
        typeof value.complete === "boolean" &&
        (value.artifact === undefined || isArtifactSummary(value.artifact))
      )
    case "artifact_created":
      return isArtifactSummary(value.artifact)
    case "plan_updated":
      return (
        Array.isArray(value.plan) &&
        value.plan.every(
          (step) =>
            isRecord(step) &&
            isString(step.title) &&
            ["pending", "in_progress", "completed"].includes(step.status as string)
        )
      )
    case "child_task_updated":
      return (
        isRecord(value.child) &&
        isString(value.child.childRunId) &&
        [
          "created",
          "running",
          "waiting_approval",
          "waiting_child",
          "suspended_unknown_tool_outcome",
          "suspended_conversation_conflict",
          "terminalizing",
          "completed",
          "cancelled",
          "failed",
        ].includes(value.child.status as string) &&
        (value.child.label === undefined || isString(value.child.label))
      )
    case "child_ownership_lease_updated":
      return (
        isString(value.childRunId) &&
        isFiniteNumber(value.leaseExpiresAt) &&
        isNonNegativeInteger(value.fencingToken)
      )
    case "finalization_phase_updated":
      return (
        isString(value.finalizationId) &&
        [
          "prepared",
          "conversation_committed",
          "trace_upserted",
          "resources_released",
          "conversation_lease_released",
          "complete",
        ].includes(value.phase as string)
      )
    case "checkpoint_committed":
      return isNonNegativeInteger(value.revision)
    case "run_completed":
      return value.outcome === "completed"
    case "run_failed":
      return (
        (value.outcome === "failed" || value.outcome === "cancelled") &&
        (value.reason === undefined || isString(value.reason))
      )
    default:
      return false
  }
}

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
