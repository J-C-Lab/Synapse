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
import type { CanonicalJson } from "./canonical-json"
import type { FrozenContextSnapshotV1 } from "./context-snapshot"
import type { DurableChatMessage } from "./durable-messages"
import { authorityIntegrityHash } from "./authority-snapshot"
import { canonicalHash } from "./canonical-json"
import { contextSha256, contextSnapshotIntegrityMatches } from "./context-snapshot"

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
  backgroundExecution?: { maxToolCallsPerRun: number; timeoutMs: number }
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
  state:
    | "prepared"
    | "held"
    | "dispatched"
    | "unknown_response"
    | "response_staged"
    | "budget_settled"
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

  /** Monotonic, checkpointed debit ledger for the background trigger's
   * per-run tool allowance.  This is deliberately outside frozen config:
   * policy is immutable, consumption is durable state. */
  backgroundExecutionLedger?: { toolCallsConsumed: number }

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
//
// This validates the FULL nested shape (identity, the recovery closed
// union, FrozenRunConfig including authority/context, every model/tool/
// finalization ledger entry, and cross-field invariants like fraction
// ranges and non-negative token counts) — not just top-level presence —
// because a durable checkpoint is untrusted input the moment it's read back
// off disk: a corrupted or hand-edited nested field (a forged authority
// grant, a negative token count, an out-of-range fraction) must never be
// silently treated as an authoritative recovery state. Free-form fields the
// schema itself declares as `unknown` (tool call `input`) are deliberately
// left unvalidated — they're opaque payloads, not structure this module
// owns.

export type CheckpointValidationResult =
  | { ok: true; checkpoint: AgentRunCheckpointV1 }
  | { ok: false; reason: "unsupported-schema-version" | "malformed" }

/** Produces the deterministic integrity fields for a checkpoint payload.
 * Setup code already creates sealed snapshots; this small helper is also
 * useful to migration/import code that constructs a v1 checkpoint as a
 * whole. It deliberately returns a copy so a caller cannot accidentally
 * change data behind a digest it has already persisted. */
export function sealCheckpointIntegrity(checkpoint: AgentRunCheckpointV1): AgentRunCheckpointV1 {
  const context = checkpoint.config.context
  const sealedContext: FrozenContextSnapshotV1 = {
    ...context,
    baseSystemPrompt: {
      ...context.baseSystemPrompt,
      sha256: contextSha256(context.baseSystemPrompt.normalizedText),
    },
    workspaceInstructions: context.workspaceInstructions.map((instruction) => ({
      ...instruction,
      sha256: contextSha256(instruction.normalizedText),
    })),
    aggregateHash: "",
  }
  sealedContext.aggregateHash = contextSha256(
    [
      sealedContext.baseSystemPrompt.sha256,
      ...sealedContext.workspaceInstructions.map((instruction) => instruction.sha256),
    ].join("|")
  )
  const authority = checkpoint.config.authority
  const sealedAuthority: FrozenAuthoritySnapshotV1 = {
    ...authority,
    integrityHash: authorityIntegrityHash(authority),
  }
  return {
    ...checkpoint,
    config: { ...checkpoint.config, authority: sealedAuthority, context: sealedContext },
  }
}

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

const KNOWN_ORIGINS: ReadonlySet<string> = new Set(["interactive", "background-agent", "subagent"])
const KNOWN_REVIEW_REASONS: ReadonlySet<string> = new Set([
  "unknown-tool-outcome",
  "authority-narrowed",
  "tool-removed-or-changed",
  "workspace-binding-changed",
  "conversation-conflict",
])
const KNOWN_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  "unsupported-checkpoint-version",
  "checkpoint-malformed",
  "conversation-deleted-or-missing",
  "authority-revoked",
  "authority-adapter-incompatible",
  "frozen-context-corrupt",
  "required-artifact-missing-or-corrupt",
  "deadline-expired",
])
const KNOWN_MESSAGE_ROLES: ReadonlySet<string> = new Set(["user", "assistant"])
const KNOWN_APPROVAL_REMEMBER: ReadonlySet<string> = new Set(["once", "conversation", "always"])
const KNOWN_TOOL_EXECUTION_UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  "process-exit",
  "adapter-disconnected",
  "checkpoint-failed",
])
const KNOWN_RESOLUTION_REASONS: ReadonlySet<string> = new Set([
  "executed",
  "approval-denied",
  "policy-denied",
  "invalid-tool-call",
  "user-marked-failed",
])
const KNOWN_REPLAY_GUARANTEES: ReadonlySet<string> = new Set(["none", "dedupe-and-result-replay"])
const KNOWN_MODEL_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "prepared",
  "held",
  "dispatched",
  "unknown_response",
  "response_staged",
  "budget_settled",
])
const KNOWN_ADMISSION_STATES: ReadonlySet<string> = new Set([
  "planned",
  "held",
  "settled",
  "forfeited",
])
const KNOWN_PLAN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"])
const KNOWN_FINALIZATION_PHASES: ReadonlySet<string> = new Set([
  "prepared",
  "conversation_committed",
  "trace_upserted",
  "resources_released",
  "conversation_lease_released",
  "complete",
])
const KNOWN_DESIRED_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled", "failed"])
const KNOWN_TRACE_OUTCOMES: ReadonlySet<string> = new Set([
  "end_turn",
  "max_steps",
  "aborted",
  "budget_exceeded",
  "error",
])
const KNOWN_CONVERSATION_RECEIPT_SKIPPED_REASONS: ReadonlySet<string> = new Set([
  "no-conversation",
  "conversation-tombstoned",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeNumber(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): boolean {
  return isNonNegativeNumber(value) && Number.isInteger(value)
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value)
}

function isFraction(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

export function validateCheckpoint(raw: unknown): CheckpointValidationResult {
  if (!isRecord(raw)) return { ok: false, reason: "malformed" }
  if (raw.schemaVersion !== 1) return { ok: false, reason: "unsupported-schema-version" }
  if (!hasValidShape(raw)) return { ok: false, reason: "malformed" }
  const checkpoint = raw as unknown as AgentRunCheckpointV1
  if (
    checkpoint.config.authority.integrityHash !==
      authorityIntegrityHash(checkpoint.config.authority) ||
    !contextSnapshotIntegrityMatches(checkpoint.config.context)
  ) {
    return { ok: false, reason: "malformed" }
  }
  if (!hasCrossFieldInvariants(checkpoint)) return { ok: false, reason: "malformed" }
  return { ok: true, checkpoint }
}

/** Relationships between independently valid nested records. These are
 * checked at the same disk trust boundary as shape/hash validation: no
 * reader may treat a dangling accepted attempt, forged message reference, or
 * mismatched terminalization ledger as durable authority. */
function hasCrossFieldInvariants(checkpoint: AgentRunCheckpointV1): boolean {
  const messages = new Map(checkpoint.messages.map((message) => [message.messageId, message]))
  if (messages.size !== checkpoint.messages.length) return false

  const modelSteps = new Set<number>()
  for (const step of checkpoint.modelSteps) {
    if (modelSteps.has(step.step)) return false
    modelSteps.add(step.step)
    // A just-prepared first attempt legally exists while nextStep still
    // points at that same step; nextStep advances only after settlement.
    if (step.step > checkpoint.nextStep) return false
    const attemptIds = new Set<string>()
    for (const attempt of step.attempts) {
      if (attemptIds.has(attempt.attemptId)) return false
      attemptIds.add(attempt.attemptId)
      if (!modelAttemptAdmissionIsConsistent(attempt)) return false
      if (
        (attempt.state === "response_staged" || attempt.state === "budget_settled") &&
        (!attempt.assistantMessageId ||
          messages.get(attempt.assistantMessageId)?.message.role !== "assistant")
      ) {
        return false
      }
    }
    if (step.acceptedAttemptId !== undefined) {
      const accepted = step.attempts.find((attempt) => attempt.attemptId === step.acceptedAttemptId)
      if (!accepted || accepted.state !== "budget_settled") return false
    }
  }

  const batchSteps = new Set<number>()
  const toolUseIds = new Set<string>()
  for (const batch of checkpoint.toolBatches) {
    if (batchSteps.has(batch.modelStep)) return false
    batchSteps.add(batch.modelStep)
    if (messages.get(batch.assistantMessageId)?.message.role !== "assistant") return false
    if (
      batch.materializedAtRevision !== undefined &&
      messages.get(batch.resultCarrierMessageId)?.message.role !== "user"
    ) {
      return false
    }
    for (const call of batch.calls) {
      if (toolUseIds.has(call.toolUseId)) return false
      toolUseIds.add(call.toolUseId)
      const resolution = call.resolution
      const frozen = checkpoint.config.authority.tools.find(
        (tool) => tool.fqName === call.fqName && tool.safeName === call.safeName
      )
      // A model can name a tool outside its frozen catalog. It is recorded
      // only as a terminal invalid-tool-call with no execution attempt; it
      // is never approvable/invokable authority. Every executable/retryable
      // ledger entry must bind to frozen authority below.
      const isPureInvalidModelTool =
        !frozen &&
        resolution.status === "resolved" &&
        resolution.reason === "invalid-tool-call" &&
        call.attempts.length === 0
      if (
        !isPureInvalidModelTool &&
        (!frozen ||
          canonicalHash(call.annotations as unknown as CanonicalJson) !== frozen.annotationsHash ||
          (frozen.annotations !== undefined &&
            canonicalHash(frozen.annotations as unknown as CanonicalJson) !==
              frozen.annotationsHash) ||
          call.replayGuarantee !== frozen.replayGuarantee)
      ) {
        return false
      }
      const attemptIds = new Set<string>()
      for (const attempt of call.attempts) {
        if (attemptIds.has(attempt.attemptId)) return false
        attemptIds.add(attempt.attemptId)
      }
      if (
        resolution.status === "resolved" &&
        resolution.attemptId !== undefined &&
        !call.attempts.some((attempt) => attempt.attemptId === resolution.attemptId)
      ) {
        return false
      }
      if (
        resolution.status === "resolved" &&
        resolution.reason === "executed" &&
        (resolution.attemptId === undefined ||
          !call.attempts.some((attempt) => {
            if (
              attempt.attemptId !== resolution.attemptId ||
              attempt.state.status !== "completed"
            ) {
              return false
            }
            return (
              canonicalHash(attempt.state.result as unknown as CanonicalJson) ===
              canonicalHash(resolution.result as unknown as CanonicalJson)
            )
          }))
      ) {
        return false
      }
      if (
        resolution.status === "unresolved" &&
        call.attempts.some((attempt) => attempt.state.status === "completed")
      ) {
        return false
      }
    }
  }

  if (checkpoint.conversationCommit && !checkpoint.identity.conversationId) return false
  const finalization = checkpoint.finalization
  if (finalization) {
    if (
      finalization.trace.runId !== checkpoint.identity.runId ||
      finalization.trace.origin !== checkpoint.identity.origin
    ) {
      return false
    }
    if (finalization.traceHash !== canonicalHash(finalization.trace as unknown as CanonicalJson)) {
      return false
    }
    if (
      (finalization.phase === "complete" && checkpoint.status !== finalization.desiredStatus) ||
      (finalization.phase !== "complete" && checkpoint.status !== "terminalizing")
    ) {
      return false
    }
  }
  return true
}

function modelAttemptAdmissionIsConsistent(attempt: ModelRequestAttempt): boolean {
  const admissionState = attempt.admission.state
  if (attempt.state === "prepared") return admissionState === "planned"
  if (
    attempt.state === "held" ||
    attempt.state === "dispatched" ||
    attempt.state === "response_staged"
  ) {
    return admissionState === "held"
  }
  if (attempt.state === "unknown_response")
    return admissionState === "held" || admissionState === "forfeited"
  return admissionState === "settled"
}

function hasValidShape(v: Record<string, unknown>): boolean {
  if (!isNonNegativeInteger(v.revision)) return false
  if (!isValidIdentity(v.identity)) return false
  if (typeof v.status !== "string" || !KNOWN_STATUSES.has(v.status as AgentRunStatus)) return false
  if (!isValidRecovery(v.recovery)) return false
  if (!isNonNegativeInteger(v.createdAt) || !isNonNegativeInteger(v.updatedAt)) return false
  if (!isValidConfig(v.config)) return false
  if (!Array.isArray(v.messages) || !v.messages.every(isValidDurableMessage)) return false
  if (!isValidTokenUsage(v.usage)) return false
  if (!isNonNegativeInteger(v.nextStep)) return false
  if (v.plan !== undefined && !isValidPlan(v.plan)) return false
  if (!Array.isArray(v.modelSteps) || !v.modelSteps.every(isValidModelStepLedger)) return false
  if (!Array.isArray(v.toolBatches) || !v.toolBatches.every(isValidToolBatchLedger)) return false
  if (!Array.isArray(v.activatedSkills) || !v.activatedSkills.every(isValidSkillActivation)) {
    return false
  }
  if (
    v.backgroundExecutionLedger !== undefined &&
    (!isRecord(v.backgroundExecutionLedger) ||
      !isNonNegativeInteger(v.backgroundExecutionLedger.toolCallsConsumed))
  ) {
    return false
  }
  if (!isOptionalString(v.activeChildTaskId)) return false
  if (v.conversationCommit !== undefined && !isValidConversationCommit(v.conversationCommit)) {
    return false
  }
  if (v.finalization !== undefined && !isValidFinalizationLedger(v.finalization)) return false
  return true
}

function isValidIdentity(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.runId) || !isString(v.rootRunId)) return false
  if (!isString(v.origin) || !KNOWN_ORIGINS.has(v.origin)) return false
  if (!isOptionalString(v.conversationId)) return false
  if (!isOptionalString(v.parentRunId)) return false
  if (!isOptionalString(v.workspaceId)) return false
  if (!isOptionalString(v.invocationId)) return false
  if (!isOptionalString(v.triggerInstanceId)) return false
  if (!isOptionalString(v.pluginId)) return false
  if (!isOptionalString(v.triggerId)) return false
  return true
}

function isValidRecovery(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.kind === "automatic") return true
  if (v.kind === "requires_review") return isString(v.reason) && KNOWN_REVIEW_REASONS.has(v.reason)
  if (v.kind === "blocked") return isString(v.reason) && KNOWN_BLOCKED_REASONS.has(v.reason)
  return false
}

function isValidModelCapabilityProfile(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.profileId) || !isString(v.providerId) || !isString(v.modelPattern)) return false
  if (!isNonNegativeInteger(v.contextWindowTokens)) return false
  if (!isNonNegativeInteger(v.defaultMaxOutputTokens)) return false
  if (v.maxToolSchemaBytes !== undefined && !isNonNegativeInteger(v.maxToolSchemaBytes))
    return false
  if (!isBoolean(v.supportsPromptCaching)) return false
  if (!isBoolean(v.supportsParallelToolCalls)) return false
  if (!isBoolean(v.supportsReasoningStream)) return false
  if (!isRecord(v.tokenBudgeting)) return false
  if (!isString(v.tokenBudgeting.upperBoundEstimatorId)) return false
  if (!isString(v.tokenBudgeting.upperBoundEstimatorVersion)) return false
  if (!isNonNegativeInteger(v.tokenBudgeting.providerFramingReserveTokens)) return false
  if (!isRecord(v.contextPolicy)) return false
  if (!isFraction(v.contextPolicy.summarizeAtFraction)) return false
  if (!isFraction(v.contextPolicy.keepRecentFraction)) return false
  if (!isNonNegativeInteger(v.contextPolicy.hardReserveTokens)) return false
  return true
}

function isValidFrozenPrincipal(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.kind)) return false
  if (v.actor !== "user" && v.actor !== "background") return false
  if (!isOptionalString(v.subjectId)) return false
  if (!isOptionalString(v.pluginId)) return false
  if (!isOptionalString(v.invocationId)) return false
  return true
}

function isValidCapabilityGrant(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.id)) return false
  if (!isString(v.scopeAdapterId) || !isString(v.scopeAdapterVersion)) return false
  return true
}

function isValidFrozenToolAuthority(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.fqName) || !isString(v.safeName)) return false
  if (v.provenance !== "host" && v.provenance !== "plugin" && v.provenance !== "mcp") return false
  if (!isString(v.ownerId) || !isString(v.ownerVersion)) return false
  if (!isString(v.modelSchemaHash) || !isString(v.annotationsHash)) return false
  if (v.annotations !== undefined) {
    if (!isRecord(v.annotations)) return false
    if (canonicalHash(v.annotations as CanonicalJson) !== v.annotationsHash) return false
  }
  if (
    v.requiredCapabilities !== undefined &&
    (!Array.isArray(v.requiredCapabilities) ||
      !v.requiredCapabilities.every(isValidCapabilityGrant))
  ) {
    return false
  }
  if (!isString(v.invocationAdapterId) || !isString(v.invocationAdapterVersion)) return false
  if (!isString(v.replayGuarantee) || !KNOWN_REPLAY_GUARANTEES.has(v.replayGuarantee)) return false
  return true
}

function isValidAuthority(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.schemaVersion !== 1) return false
  if (!isValidFrozenPrincipal(v.principal)) return false
  if (!Array.isArray(v.capabilities) || !v.capabilities.every(isValidCapabilityGrant)) return false
  if (!Array.isArray(v.tools) || !v.tools.every(isValidFrozenToolAuthority)) return false
  if (!isString(v.integrityHash)) return false
  return true
}

function isValidWorkspaceInstruction(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.rootId) || !isString(v.sourcePath)) return false
  if (v.sourceKind !== "workspace-instruction") return false
  if (v.trust !== "untrusted-workspace-instruction") return false
  if (!isString(v.normalizedText) || !isString(v.sha256)) return false
  return true
}

function isValidContext(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.schemaVersion !== 1) return false
  if (!isRecord(v.baseSystemPrompt)) return false
  if (!isString(v.baseSystemPrompt.normalizedText) || !isString(v.baseSystemPrompt.sha256)) {
    return false
  }
  if (
    !Array.isArray(v.workspaceInstructions) ||
    !v.workspaceInstructions.every(isValidWorkspaceInstruction)
  ) {
    return false
  }
  if (!isString(v.aggregateHash)) return false
  return true
}

function isValidConfig(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.schemaVersion !== 1) return false
  if (!isString(v.providerId) || !isString(v.model)) return false
  if (!isValidModelCapabilityProfile(v.resolvedProfile)) return false
  if (!isNonNegativeInteger(v.maxOutputTokens)) return false
  if (!isOptionalNonNegativeNumber(v.runBudgetTokens)) return false
  if (v.deadlineAt !== undefined && !isNonNegativeInteger(v.deadlineAt)) return false
  if (!isNonNegativeInteger(v.maxSteps)) return false
  if (!isRecord(v.contextCompression)) return false
  if (!isBoolean(v.contextCompression.enabled)) return false
  if (!isNonNegativeInteger(v.contextCompression.thresholdTokens)) return false
  if (!isFraction(v.contextCompression.keepRecentFraction)) return false
  if (!isNonNegativeInteger(v.contextCompression.hardReserveTokens)) return false
  if (!isRecord(v.workspaceBinding)) return false
  if (!isOptionalString(v.workspaceBinding.workspaceId)) return false
  if (!isNonNegativeInteger(v.workspaceBinding.bindingRevision)) return false
  if (!isStringArray(v.workspaceBinding.rootIds)) return false
  if (!isString(v.workspaceBinding.rootSetHash)) return false
  if (!isValidAuthority(v.authority)) return false
  if (!isValidContext(v.context)) return false
  if (v.backgroundExecution !== undefined) {
    if (!isRecord(v.backgroundExecution)) return false
    if (!isNonNegativeInteger(v.backgroundExecution.maxToolCallsPerRun)) return false
    if (!isNonNegativeInteger(v.backgroundExecution.timeoutMs)) return false
  }
  return true
}

function isValidChatContentBlock(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.type === "text") return isString(v.text)
  if (v.type === "tool_use") return isString(v.id) && isString(v.name) && "input" in v
  if (v.type === "tool_result") {
    return (
      isString(v.toolUseId) &&
      isString(v.content) &&
      (v.isError === undefined || isBoolean(v.isError))
    )
  }
  return false
}

function isValidDurableMessage(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.messageId)) return false
  if (!isOptionalString(v.producedByRunId)) return false
  if (!isRecord(v.message)) return false
  if (!isString(v.message.role) || !KNOWN_MESSAGE_ROLES.has(v.message.role)) return false
  if (!Array.isArray(v.message.content) || !v.message.content.every(isValidChatContentBlock)) {
    return false
  }
  return true
}

function isValidTokenUsage(v: unknown): boolean {
  if (!isRecord(v)) return false
  return (
    isNonNegativeInteger(v.inputTokens) &&
    isNonNegativeInteger(v.outputTokens) &&
    isNonNegativeInteger(v.cacheCreationInputTokens) &&
    isNonNegativeInteger(v.cacheReadInputTokens)
  )
}

function isValidPlan(v: unknown): boolean {
  if (!Array.isArray(v)) return false
  return v.every(
    (step) =>
      isRecord(step) &&
      isString(step.title) &&
      isString(step.status) &&
      KNOWN_PLAN_STATUSES.has(step.status)
  )
}

function isValidToolApproval(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.status === "not_required") return true
  if (v.status === "pending") return isString(v.approvalId) && isFiniteNumber(v.requestedAt)
  if (v.status === "resolved") {
    return (
      isOptionalString(v.approvalId) &&
      isBoolean(v.allowed) &&
      isString(v.remember) &&
      KNOWN_APPROVAL_REMEMBER.has(v.remember) &&
      isFiniteNumber(v.resolvedAt)
    )
  }
  return false
}

function isValidPersistedToolResult(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isBoolean(v.isError) || !isString(v.preview) || !isBoolean(v.complete)) return false
  // artifact is a forward-declared AgentArtifactRefSummary (Checkpoint B) —
  // presence-only checked here; its own store validates deeper.
  if (v.artifact !== undefined && !isRecord(v.artifact)) return false
  return true
}

function isValidToolExecutionAttemptState(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.status === "started") return isFiniteNumber(v.startedAt)
  if (v.status === "completed") {
    return (
      isFiniteNumber(v.startedAt) &&
      isFiniteNumber(v.completedAt) &&
      isValidPersistedToolResult(v.result) &&
      isOptionalString(v.auditEventId)
    )
  }
  if (v.status === "unknown") {
    return (
      isFiniteNumber(v.startedAt) &&
      isString(v.reason) &&
      KNOWN_TOOL_EXECUTION_UNKNOWN_REASONS.has(v.reason)
    )
  }
  return false
}

function isValidToolExecutionAttempt(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.attemptId) || !isString(v.invocationId) || !isString(v.invocationFingerprint)) {
    return false
  }
  return isValidToolExecutionAttemptState(v.state)
}

function isValidToolCallResolution(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.status === "unresolved") return true
  if (v.status === "resolved") {
    return (
      isString(v.reason) &&
      KNOWN_RESOLUTION_REASONS.has(v.reason) &&
      isValidPersistedToolResult(v.result) &&
      isOptionalString(v.attemptId)
    )
  }
  return false
}

function isValidToolCallLedgerEntry(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isNonNegativeInteger(v.ordinal)) return false
  if (!isString(v.toolUseId) || !isString(v.safeName) || !isString(v.fqName)) return false
  if (!("input" in v)) return false
  if (!isRecord(v.annotations)) return false
  if (!isString(v.replayGuarantee) || !KNOWN_REPLAY_GUARANTEES.has(v.replayGuarantee)) return false
  if (!isValidToolApproval(v.approval)) return false
  if (!Array.isArray(v.attempts) || !v.attempts.every(isValidToolExecutionAttempt)) return false
  if (!isValidToolCallResolution(v.resolution)) return false
  return true
}

function isValidToolBatchLedger(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isNonNegativeInteger(v.modelStep)) return false
  if (!isString(v.assistantMessageId)) return false
  if (!Array.isArray(v.calls) || !v.calls.every(isValidToolCallLedgerEntry)) return false
  // Ordinals must be exactly 0..n-1 in order — the ordered-execution
  // invariant every tool-batch consumer (approval, execution, recovery)
  // relies on to address a call unambiguously.
  if (!(v.calls as { ordinal: number }[]).every((call, index) => call.ordinal === index)) {
    return false
  }
  if (!isString(v.resultCarrierMessageId)) return false
  if (v.materializedAtRevision !== undefined && !isNonNegativeInteger(v.materializedAtRevision))
    return false
  return true
}

function isValidModelBudgetAdmission(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.operationId) || !isString(v.accountId)) return false
  if (!isString(v.estimatorId) || !isString(v.estimatorVersion)) return false
  if (!isNonNegativeInteger(v.inputUpperBoundTokens)) return false
  if (!isNonNegativeInteger(v.maxOutputTokens)) return false
  if (!isNonNegativeInteger(v.heldTokens)) return false
  if (!isString(v.state) || !KNOWN_ADMISSION_STATES.has(v.state)) return false
  if (v.ledgerRevision !== undefined && !isNonNegativeInteger(v.ledgerRevision)) return false
  if (v.actualTokens !== undefined && !isNonNegativeInteger(v.actualTokens)) return false
  return true
}

function isValidModelRequestAttempt(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.attemptId) || !isString(v.requestHash)) return false
  if (!isString(v.state) || !KNOWN_MODEL_ATTEMPT_STATES.has(v.state)) return false
  if (!isValidModelBudgetAdmission(v.admission)) return false
  if (!isOptionalString(v.assistantMessageId)) return false
  if (v.usage !== undefined && !isValidTokenUsage(v.usage)) return false
  return true
}

function isValidModelStepLedger(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isNonNegativeInteger(v.step)) return false
  if (!Array.isArray(v.attempts) || !v.attempts.every(isValidModelRequestAttempt)) return false
  if (!isOptionalString(v.acceptedAttemptId)) return false
  return true
}

function isValidSkillActivation(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.activationId) || !isString(v.skillId)) return false
  if (!isString(v.packageHash) || !isString(v.instructionsHash)) return false
  const knownTrust = new Set(["host", "user-authored", "third-party", "workspace-content"])
  if (!isString(v.trust) || !knownTrust.has(v.trust)) return false
  if (!isStringArray(v.effectiveToolNames)) return false
  if (!isString(v.packageLeaseId)) return false
  // instructionsArtifact is a forward-declared AgentArtifactRefSummary
  // (Checkpoint B) — presence-only checked here.
  if (!isRecord(v.instructionsArtifact)) return false
  if (!isFiniteNumber(v.activatedAt)) return false
  return true
}

function isValidConversationCommit(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isNonNegativeNumber(v.baseContentRevision)) return false
  if (!isNonNegativeNumber(v.leaseFencingToken)) return false
  if (!isNonNegativeNumber(v.deletionEpoch)) return false
  if (!isOptionalNonNegativeNumber(v.committedContentRevision)) return false
  return true
}

function isValidRunTraceToolCall(v: unknown): boolean {
  if (!isRecord(v)) return false
  return isString(v.name) && isFiniteNumber(v.startedAt) && isFiniteNumber(v.ms) && isBoolean(v.ok)
}

function isValidRunTrace(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.runId)) return false
  const knownOrigins = new Set(["interactive", "background-agent", "subagent", "mcp"])
  if (!isString(v.origin) || !knownOrigins.has(v.origin)) return false
  if (!isFiniteNumber(v.startedAt) || !isFiniteNumber(v.endedAt)) return false
  if (!isString(v.outcome) || !KNOWN_TRACE_OUTCOMES.has(v.outcome)) return false
  if (!Array.isArray(v.toolCalls) || !v.toolCalls.every(isValidRunTraceToolCall)) return false
  if (v.plan !== undefined && !isValidPlan(v.plan)) return false
  return true
}

function isValidResourceReleasePlan(v: unknown): boolean {
  if (!isRecord(v)) return false
  return (
    isStringArray(v.budgetOperationIds) &&
    isStringArray(v.skillPackageLeaseIds) &&
    isBoolean(v.releaseArtifactRunPin) &&
    isStringArray(v.adoptionLeaseIds)
  )
}

function isValidConversationReceipt(v: unknown): boolean {
  if (v === undefined) return true
  if (!isRecord(v)) return false
  if (v.status === "committed") return isNonNegativeNumber(v.contentRevision)
  if (v.status === "skipped") {
    return isString(v.reason) && KNOWN_CONVERSATION_RECEIPT_SKIPPED_REASONS.has(v.reason)
  }
  return false
}

function isValidResourceReceipts(v: unknown): boolean {
  if (v === undefined) return true
  if (!isRecord(v)) return false
  return (
    isStringArray(v.budgetOperationIds) &&
    isStringArray(v.skillPackageLeaseIds) &&
    isBoolean(v.artifactRunPinReleased) &&
    isStringArray(v.adoptionLeaseIds)
  )
}

function isValidFinalizationLedger(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!isString(v.finalizationId)) return false
  if (!isString(v.desiredStatus) || !KNOWN_DESIRED_STATUSES.has(v.desiredStatus)) return false
  if (!isString(v.phase) || !KNOWN_FINALIZATION_PHASES.has(v.phase)) return false
  if (!isString(v.outcome) || !KNOWN_TRACE_OUTCOMES.has(v.outcome)) return false
  if (!isString(v.stopReason)) return false
  if (!isFiniteNumber(v.endedAt)) return false
  if (!isValidRunTrace(v.trace)) return false
  if (!isString(v.traceHash)) return false
  if (!isValidResourceReleasePlan(v.resourceReleasePlan)) return false
  if (!isValidConversationReceipt(v.conversationReceipt)) return false
  if (!isOptionalNonNegativeNumber(v.traceUpsertRevision)) return false
  if (!isValidResourceReceipts(v.resourceReceipts)) return false
  if (!isOptionalNonNegativeNumber(v.leaseReleaseRevision)) return false
  return true
}
