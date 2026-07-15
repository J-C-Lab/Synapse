import type {
  AgentArtifactRefSummary,
  AgentRunIdentity,
  AgentRunStatus,
  RecoveryDisposition,
  RunFinalizationPhase,
} from "@synapse/agent-protocol"
import type { ToolAnnotations } from "@synapse/plugin-manifest"
import type { PlanStep } from "../plan/plan-types"
import type { TokenUsage } from "../providers/types"
import type { RunTrace } from "../run-trace-store"
import type { FrozenAuthoritySnapshotV1 } from "./authority-snapshot"
import type { FrozenContextSnapshotV1 } from "./context-snapshot"
import type { DurableChatMessage } from "./durable-messages"

// The authoritative recovery snapshot for one durable run (design
// §"Durable checkpoint store"). Host-only — never imported by the renderer.
// `AgentRunSnapshot`/`AgentRunSummary` in @synapse/agent-protocol are the
// renderer-safe *projections* of this; checkpoint internals (ledgers,
// budget admission, config) stay here.

/**
 * Owned here (not in providers/) because FrozenRunConfigV1 needs it before
 * the provider-profile resolution work (a later task) exists. That task
 * imports this type rather than checkpoint-schema.ts depending on it.
 */
export interface ModelCapabilityProfile {
  profileId: string
  providerId: string
  modelPattern: string
  contextWindowTokens: number
  defaultMaxOutputTokens: number
  maxToolSchemaBytes?: number
  supportsPromptCaching: boolean
  supportsParallelToolCalls: boolean
  supportsReasoningStream: boolean
  tokenBudgeting: {
    upperBoundEstimatorId: string
    upperBoundEstimatorVersion: string
    providerFramingReserveTokens: number
  }
  contextPolicy: {
    summarizeAtFraction: number
    keepRecentFraction: number
    hardReserveTokens: number
  }
}

export interface FrozenRunConfigV1 {
  schemaVersion: 1
  providerId: string
  model: string
  resolvedProfile: ModelCapabilityProfile
  maxOutputTokens: number
  runBudgetTokens?: number
  deadlineAt?: number
  maxSteps: number
  contextCompression: {
    enabled: boolean
    thresholdTokens: number
    keepRecentFraction: number
    hardReserveTokens: number
  }
  workspaceBinding: {
    workspaceId?: string
    bindingRevision: number
    rootIds: string[]
    rootSetHash: string
  }
  authority: FrozenAuthoritySnapshotV1
  context: FrozenContextSnapshotV1
}

export type ToolApprovalState =
  | { status: "not_required" }
  | { status: "pending"; approvalId: string; requestedAt: number }
  | {
      status: "resolved"
      approvalId?: string
      allowed: boolean
      remember: "once" | "conversation" | "always"
      resolvedAt: number
    }

export interface PersistedToolResult {
  isError: boolean
  preview: string
  artifact?: AgentArtifactRefSummary
  complete: boolean
}

export type ToolExecutionAttemptState =
  | { status: "started"; startedAt: number }
  | {
      status: "completed"
      startedAt: number
      completedAt: number
      result: PersistedToolResult
      auditEventId?: string
    }
  | {
      status: "unknown"
      startedAt: number
      reason: "process-exit" | "adapter-disconnected" | "checkpoint-failed"
    }

export interface ToolExecutionAttempt {
  attemptId: string
  invocationId: string
  invocationFingerprint: string
  state: ToolExecutionAttemptState
}

export type ToolCallResolution =
  | { status: "unresolved" }
  | {
      status: "resolved"
      reason:
        | "executed"
        | "approval-denied"
        | "policy-denied"
        | "invalid-tool-call"
        | "user-marked-failed"
      result: PersistedToolResult
      attemptId?: string
    }

export interface ToolCallLedgerEntry {
  ordinal: number
  toolUseId: string
  safeName: string
  fqName: string
  input: unknown
  annotations: ToolAnnotations
  replayGuarantee: "none" | "dedupe-and-result-replay"
  approval: ToolApprovalState
  attempts: ToolExecutionAttempt[]
  resolution: ToolCallResolution
}

export interface ToolBatchLedger {
  modelStep: number
  assistantMessageId: string
  calls: ToolCallLedgerEntry[]
  resultCarrierMessageId: string
  /** Set in the same checkpoint revision that appends the single ordered
   *  tool-result carrier message to `messages`. */
  materializedAtRevision?: number
}

export interface ModelBudgetAdmission {
  operationId: string
  accountId: string
  estimatorId: string
  estimatorVersion: string
  inputUpperBoundTokens: number
  maxOutputTokens: number
  heldTokens: number
  state: "planned" | "held" | "settled" | "forfeited"
  ledgerRevision?: number
  actualTokens?: number
}

export interface ModelRequestAttempt {
  attemptId: string
  requestHash: string
  state: "prepared" | "dispatched" | "unknown_response" | "response_staged" | "budget_settled"
  admission: ModelBudgetAdmission
  assistantMessageId?: string
  usage?: TokenUsage
}

export interface ModelStepLedger {
  step: number
  attempts: ModelRequestAttempt[]
  acceptedAttemptId?: string
}

/** Forward-declared here for the same reason as ModelCapabilityProfile — the
 *  progressive-skills checkpoint (a later checkpoint) owns activation
 *  logic, but the field must exist on every checkpoint from v1 onward. */
export interface SkillActivationSnapshot {
  activationId: string
  skillId: string
  packageHash: string
  instructionsHash: string
  trust: "host" | "user-authored" | "third-party" | "workspace-content"
  effectiveToolNames: string[]
  packageLeaseId: string
  instructionsArtifact: AgentArtifactRefSummary
  activatedAt: number
}

export interface RunFinalizationLedger {
  finalizationId: string
  desiredStatus: "completed" | "cancelled" | "failed"
  phase: RunFinalizationPhase
  outcome: RunTrace["outcome"]
  stopReason: string
  endedAt: number
  trace: RunTrace
  traceHash: string
  resourceReleasePlan: {
    budgetOperationIds: string[]
    skillPackageLeaseIds: string[]
    releaseArtifactRunPin: boolean
    adoptionLeaseIds: string[]
  }
  conversationReceipt?:
    | { status: "committed"; contentRevision: number }
    | { status: "skipped"; reason: "no-conversation" | "conversation-tombstoned" }
  traceUpsertRevision?: number
  resourceReceipts?: {
    budgetOperationIds: string[]
    skillPackageLeaseIds: string[]
    artifactRunPinReleased: boolean
    adoptionLeaseIds: string[]
  }
  leaseReleaseRevision?: number
}

export interface AgentRunCheckpointV1 {
  schemaVersion: 1
  revision: number
  identity: AgentRunIdentity
  status: AgentRunStatus
  recovery: RecoveryDisposition
  createdAt: number
  updatedAt: number

  config: FrozenRunConfigV1
  messages: DurableChatMessage[]
  usage: TokenUsage
  nextStep: number
  plan?: PlanStep[]
  modelSteps: ModelStepLedger[]
  toolBatches: ToolBatchLedger[]
  activatedSkills: SkillActivationSnapshot[]

  activeChildTaskId?: string

  conversationCommit?: {
    baseContentRevision: number
    leaseFencingToken: number
    deletionEpoch: number
    committedContentRevision?: number
  }
  finalization?: RunFinalizationLedger
}

// ---------------------------------------------------------------------------
// Trust-boundary validation. Every checkpoint read off disk goes through
// this before anything treats it as authoritative. An unknown schema
// version or a structurally wrong required field is never coerced with a
// default — it is classified and left exactly as persisted.

export type CheckpointValidationResult =
  | { ok: true; checkpoint: AgentRunCheckpointV1 }
  | { ok: false; reason: "unsupported-schema-version" | "malformed" }

const KNOWN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
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
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateCheckpoint(raw: unknown): CheckpointValidationResult {
  if (!isRecord(raw)) return { ok: false, reason: "malformed" }
  if (raw.schemaVersion !== 1) return { ok: false, reason: "unsupported-schema-version" }
  if (!hasValidShape(raw)) return { ok: false, reason: "malformed" }
  return { ok: true, checkpoint: raw as unknown as AgentRunCheckpointV1 }
}

function hasValidShape(v: Record<string, unknown>): boolean {
  if (typeof v.revision !== "number") return false
  if (!isRecord(v.identity) || typeof v.identity.runId !== "string") return false
  if (typeof v.status !== "string" || !KNOWN_STATUSES.has(v.status as AgentRunStatus)) return false
  if (!isRecord(v.recovery) || typeof v.recovery.kind !== "string") return false
  if (typeof v.createdAt !== "number" || typeof v.updatedAt !== "number") return false
  if (!isRecord(v.config) || v.config.schemaVersion !== 1) return false
  if (!Array.isArray(v.messages)) return false
  if (!isRecord(v.usage)) return false
  if (typeof v.nextStep !== "number") return false
  if (!Array.isArray(v.modelSteps)) return false
  if (!Array.isArray(v.toolBatches)) return false
  if (!Array.isArray(v.activatedSkills)) return false
  return true
}
