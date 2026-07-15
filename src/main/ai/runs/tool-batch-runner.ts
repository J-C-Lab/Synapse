import type { ToolCaller, ToolResult } from "@synapse/plugin-sdk"
import type { AiToolRegistry } from "../tool-registry"
import type { AgentRunStore } from "./agent-run-store"
import type { CanonicalJson } from "./canonical-json"
import type {
  AgentRunCheckpointV1,
  PersistedToolResult,
  ToolBatchLedger,
  ToolCallLedgerEntry,
  ToolCallResolution,
  ToolExecutionAttempt,
} from "./checkpoint-schema"
import type {
  DurableApprovalPolicyInput,
  DurableApprovalResolver,
  RememberScope,
} from "./durable-approval"
import { randomUUID } from "node:crypto"
import { renderLabeledToolResult } from "../agent-runtime"
import { invocationAdapterFor } from "../tool-registry"
import { canonicalHash } from "./canonical-json"
import { decideDurableApproval } from "./durable-approval"
import { isValidRunStatusTransition } from "./run-types"

// Ordered multi-tool execution ledger (design §"Ordered `ToolBatchLedger`
// with per-ordinal approval/execution/result state and atomic result-carrier
// materialization"). Calls from one assistant message are processed strictly
// in order, one at a time — approval and execution for ordinal N+1 never
// starts before ordinal N is terminal — so recovery only ever has to resume
// exactly one in-flight call, never reconcile two concurrent ones.

export type ToolBatchFaultPoint =
  | "after_batch_created"
  | "after_approval_pending"
  | "after_approval_resolved"
  | "after_attempt_started"
  | "after_attempt_completed"
  | "after_materialized"

export interface ToolBatchDeps {
  runStore: AgentRunStore
  tools: AiToolRegistry
  caller: ToolCaller
  /** Hard policy resolver layered ahead of the annotation heuristic — see
   *  durable-approval.ts. Omit to rely on the heuristic alone. */
  resolver?: DurableApprovalResolver
  requestApproval: (
    approvalId: string,
    input: DurableApprovalPolicyInput
  ) => Promise<{ allowed: boolean; remember: RememberScope }>
  now: () => number
  newId?: () => string
  /** Named crash-recovery test seams — never set in production. */
  fault?: (point: ToolBatchFaultPoint) => void
  maxToolResultChars?: number
}

export type ToolBatchOutcome =
  | { kind: "materialized"; checkpoint: AgentRunCheckpointV1 }
  | { kind: "suspended_unknown_tool_outcome"; checkpoint: AgentRunCheckpointV1; ordinal: number }

/** Advances (creating if necessary) the tool batch for `modelStep` until
 *  every call is terminal and the ordered result carrier is materialized, or
 *  until a call's execution outcome can't be recovered and the run must
 *  suspend for an explicit human decision. */
export async function advanceToolBatch(
  deps: ToolBatchDeps,
  runId: string,
  modelStep: number
): Promise<ToolBatchOutcome> {
  let checkpoint = await loadOk(deps, runId)

  if (!findBatch(checkpoint, modelStep)) {
    checkpoint = await createBatch(deps, runId, checkpoint, modelStep)
    deps.fault?.("after_batch_created")
  }

  const callCount = requireBatch(checkpoint, modelStep).calls.length
  for (let ordinal = 0; ordinal < callCount; ordinal++) {
    const call = requireBatch(checkpoint, modelStep).calls[ordinal]!
    if (call.resolution.status === "resolved") continue

    const outcome = await advanceCall(deps, runId, modelStep, ordinal)
    if (outcome.kind === "suspended") {
      return { kind: "suspended_unknown_tool_outcome", checkpoint: outcome.checkpoint, ordinal }
    }
    checkpoint = outcome.checkpoint
  }

  const batch = requireBatch(checkpoint, modelStep)
  if (batch.materializedAtRevision === undefined) {
    checkpoint = await materializeBatch(deps, runId, checkpoint, modelStep)
    deps.fault?.("after_materialized")
  }

  return { kind: "materialized", checkpoint }
}

async function loadOk(deps: ToolBatchDeps, runId: string): Promise<AgentRunCheckpointV1> {
  const result = await deps.runStore.load(runId)
  if (!result.ok) throw new Error(`checkpoint for run ${runId} is ${result.reason}`)
  return result.checkpoint
}

function findBatch(
  checkpoint: AgentRunCheckpointV1,
  modelStep: number
): ToolBatchLedger | undefined {
  return checkpoint.toolBatches.find((batch) => batch.modelStep === modelStep)
}

function requireBatch(checkpoint: AgentRunCheckpointV1, modelStep: number): ToolBatchLedger {
  const batch = findBatch(checkpoint, modelStep)
  if (!batch) throw new Error(`no tool batch for model step ${modelStep}`)
  return batch
}

function newId(deps: ToolBatchDeps): string {
  return deps.newId?.() ?? randomUUID()
}

async function mutateCheckpoint(
  deps: ToolBatchDeps,
  runId: string,
  mutator: (checkpoint: AgentRunCheckpointV1) => AgentRunCheckpointV1
): Promise<AgentRunCheckpointV1> {
  const current = await loadOk(deps, runId)
  return deps.runStore.mutate(runId, current.revision, mutator)
}

function updateCall(
  checkpoint: AgentRunCheckpointV1,
  modelStep: number,
  ordinal: number,
  update: (call: ToolCallLedgerEntry) => ToolCallLedgerEntry
): AgentRunCheckpointV1 {
  return {
    ...checkpoint,
    toolBatches: checkpoint.toolBatches.map((batch) =>
      batch.modelStep !== modelStep
        ? batch
        : { ...batch, calls: batch.calls.map((call, i) => (i === ordinal ? update(call) : call)) }
    ),
  }
}

// ---------------------------------------------------------------------------
// Ledger creation

async function createBatch(
  deps: ToolBatchDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1,
  modelStep: number
): Promise<AgentRunCheckpointV1> {
  const step = checkpoint.modelSteps.find((s) => s.step === modelStep)
  if (!step?.acceptedAttemptId) {
    throw new Error(`model step ${modelStep} has no accepted attempt to build a tool batch from`)
  }
  const attempt = step.attempts.find((a) => a.attemptId === step.acceptedAttemptId)
  if (!attempt?.assistantMessageId) {
    throw new Error(`model step ${modelStep}'s accepted attempt has no assistant message`)
  }
  const assistantMessage = checkpoint.messages.find(
    (m) => m.messageId === attempt.assistantMessageId
  )
  if (!assistantMessage) {
    throw new Error(`assistant message ${attempt.assistantMessageId} not found`)
  }

  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is { type: "tool_use"; id: string; name: string; input: unknown } =>
      block.type === "tool_use"
  )

  const calls: ToolCallLedgerEntry[] = toolUseBlocks.map((block, ordinal) => {
    const descriptor = deps.tools.describe(block.name)
    return {
      ordinal,
      toolUseId: block.id,
      safeName: block.name,
      fqName: descriptor?.fqName ?? block.name,
      input: block.input,
      annotations: descriptor?.manifestTool.annotations ?? {},
      replayGuarantee: descriptor ? invocationAdapterFor(descriptor).replayGuarantee : "none",
      approval: { status: "not_required" },
      attempts: [],
      resolution: { status: "unresolved" },
    }
  })

  const batch: ToolBatchLedger = {
    modelStep,
    assistantMessageId: assistantMessage.messageId,
    calls,
    resultCarrierMessageId: newId(deps),
  }

  return mutateCheckpoint(deps, runId, (cp) => ({
    ...cp,
    toolBatches: [...cp.toolBatches, batch],
    updatedAt: deps.now(),
  }))
}

// ---------------------------------------------------------------------------
// Per-call advancement

interface CallAdvanceResult {
  kind: "resolved"
  checkpoint: AgentRunCheckpointV1
}
interface CallSuspendResult {
  kind: "suspended"
  checkpoint: AgentRunCheckpointV1
}

async function advanceCall(
  deps: ToolBatchDeps,
  runId: string,
  modelStep: number,
  ordinal: number
): Promise<CallAdvanceResult | CallSuspendResult> {
  const checkpoint = await approvalPhase(deps, runId, modelStep, ordinal)
  if (checkpoint === "resolved") {
    return { kind: "resolved", checkpoint: await loadOk(deps, runId) }
  }

  return executionPhase(deps, runId, modelStep, ordinal, checkpoint)
}

/** Drives the approval decision to a terminal state (resolved-denied handled
 *  inline; resolved-allowed or not-required returns the checkpoint for
 *  execution to continue). Returns the literal `"resolved"` when the call
 *  was fully resolved without ever needing execution (a denial). */
async function approvalPhase(
  deps: ToolBatchDeps,
  runId: string,
  modelStep: number,
  ordinal: number
): Promise<AgentRunCheckpointV1 | "resolved"> {
  let checkpoint = await loadOk(deps, runId)
  const call = requireBatch(checkpoint, modelStep).calls[ordinal]!
  if (call.resolution.status === "resolved") return "resolved"

  const policyInput = (c: ToolCallLedgerEntry): DurableApprovalPolicyInput => ({
    fqName: c.fqName,
    safeName: c.safeName,
    input: c.input,
    annotations: c.annotations,
  })

  if (call.approval.status === "not_required" && call.attempts.length === 0) {
    const descriptor = deps.tools.describe(call.safeName)
    if (!descriptor) {
      await resolveWithoutExecution(deps, runId, modelStep, ordinal, "invalid-tool-call")
      return "resolved"
    }

    const decision = await decideDurableApproval(policyInput(call), deps.resolver)
    if (decision === "deny") {
      await resolveWithoutExecution(deps, runId, modelStep, ordinal, "policy-denied")
      return "resolved"
    }
    if (decision === "allow") {
      // Already "not_required" — nothing to persist before execution.
      return loadOk(deps, runId)
    }

    const approvalId = newId(deps)
    checkpoint = await mutateCheckpoint(deps, runId, (cp) =>
      updateCall(cp, modelStep, ordinal, (c) => ({
        ...c,
        approval: { status: "pending", approvalId, requestedAt: deps.now() },
      }))
    )
    deps.fault?.("after_approval_pending")

    const decided = await deps.requestApproval(approvalId, policyInput(call))
    checkpoint = await mutateCheckpoint(deps, runId, (cp) =>
      updateCall(cp, modelStep, ordinal, (c) => ({
        ...c,
        approval: {
          status: "resolved",
          approvalId,
          allowed: decided.allowed,
          remember: decided.remember,
          resolvedAt: deps.now(),
        },
      }))
    )
    deps.fault?.("after_approval_resolved")

    if (!decided.allowed) {
      await resolveWithoutExecution(deps, runId, modelStep, ordinal, "approval-denied")
      return "resolved"
    }
    return loadOk(deps, runId)
  }

  if (call.approval.status === "pending") {
    const approvalId = call.approval.approvalId
    const decided = await deps.requestApproval(approvalId, policyInput(call))
    checkpoint = await mutateCheckpoint(deps, runId, (cp) =>
      updateCall(cp, modelStep, ordinal, (c) => ({
        ...c,
        approval: {
          status: "resolved",
          approvalId,
          allowed: decided.allowed,
          remember: decided.remember,
          resolvedAt: deps.now(),
        },
      }))
    )
    deps.fault?.("after_approval_resolved")

    if (!decided.allowed) {
      await resolveWithoutExecution(deps, runId, modelStep, ordinal, "approval-denied")
      return "resolved"
    }
    return loadOk(deps, runId)
  }

  if (call.approval.status === "resolved" && !call.approval.allowed) {
    await resolveWithoutExecution(deps, runId, modelStep, ordinal, "approval-denied")
    return "resolved"
  }

  // approval already resolved+allowed, or not_required with an attempt
  // already under way — nothing left to decide, proceed to execution.
  return checkpoint
}

async function resolveWithoutExecution(
  deps: ToolBatchDeps,
  runId: string,
  modelStep: number,
  ordinal: number,
  reason: "invalid-tool-call" | "policy-denied" | "approval-denied"
): Promise<void> {
  const result: PersistedToolResult = {
    isError: true,
    preview: syntheticDenialText(reason),
    complete: true,
  }
  const resolution: ToolCallResolution = { status: "resolved", reason, result }
  await mutateCheckpoint(deps, runId, (cp) =>
    updateCall(cp, modelStep, ordinal, (c) => ({ ...c, resolution }))
  )
}

function syntheticDenialText(
  reason: "invalid-tool-call" | "policy-denied" | "approval-denied"
): string {
  switch (reason) {
    case "invalid-tool-call":
      return "This tool call could not be resolved to a known tool."
    case "policy-denied":
      return "This tool call was denied by policy before execution."
    case "approval-denied":
      return "This tool call was denied approval by the user."
  }
}

// ---------------------------------------------------------------------------
// Execution

async function executionPhase(
  deps: ToolBatchDeps,
  runId: string,
  modelStep: number,
  ordinal: number,
  checkpoint: AgentRunCheckpointV1
): Promise<CallAdvanceResult | CallSuspendResult> {
  let call = requireBatch(checkpoint, modelStep).calls[ordinal]!
  const latest = call.attempts[call.attempts.length - 1]

  if (latest && latest.state.status === "started") {
    const recovered = await recoverInterruptedAttempt(deps, runId, modelStep, ordinal, call, latest)
    if (recovered.kind === "suspended") return recovered
    checkpoint = recovered.checkpoint
    call = requireBatch(checkpoint, modelStep).calls[ordinal]!
    if (call.resolution.status === "resolved") return { kind: "resolved", checkpoint }
    // "not-found" recovery: fall through to start a brand-new attempt below.
  }

  const descriptor = deps.tools.describe(call.safeName)
  if (!descriptor) {
    await resolveWithoutExecution(deps, runId, modelStep, ordinal, "invalid-tool-call")
    return { kind: "resolved", checkpoint: await loadOk(deps, runId) }
  }

  const attemptId = newId(deps)
  const invocationId = newId(deps)
  const invocationFingerprint = canonicalHash({
    fqName: call.fqName,
    input: (call.input ?? null) as CanonicalJson,
  })
  const newAttempt: ToolExecutionAttempt = {
    attemptId,
    invocationId,
    invocationFingerprint,
    state: { status: "started", startedAt: deps.now() },
  }

  checkpoint = await mutateCheckpoint(deps, runId, (cp) =>
    updateCall(cp, modelStep, ordinal, (c) => ({ ...c, attempts: [...c.attempts, newAttempt] }))
  )
  deps.fault?.("after_attempt_started")

  let toolResult: ToolResult | undefined
  let executionError: unknown
  try {
    toolResult = await deps.tools.invoke(call.safeName, call.input, { caller: deps.caller })
  } catch (err) {
    executionError = err
  }

  const rendered = executionError
    ? {
        text: executionError instanceof Error ? executionError.message : String(executionError),
        isError: true,
      }
    : renderLabeledToolResult(toolResult!, call.fqName, {
        maxToolResultChars: deps.maxToolResultChars,
      })

  const persistedResult: PersistedToolResult = {
    isError: rendered.isError,
    preview: rendered.text,
    complete: true,
  }
  const completedAt = deps.now()

  checkpoint = await mutateCheckpoint(deps, runId, (cp) =>
    updateCall(cp, modelStep, ordinal, (c) => ({
      ...c,
      attempts: c.attempts.map((a) =>
        a.attemptId === attemptId
          ? {
              ...a,
              state: {
                status: "completed",
                startedAt: a.state.startedAt,
                completedAt,
                result: persistedResult,
              },
            }
          : a
      ),
      resolution: { status: "resolved", reason: "executed", result: persistedResult, attemptId },
    }))
  )
  deps.fault?.("after_attempt_completed")

  return { kind: "resolved", checkpoint }
}

async function recoverInterruptedAttempt(
  deps: ToolBatchDeps,
  runId: string,
  modelStep: number,
  ordinal: number,
  call: ToolCallLedgerEntry,
  latest: ToolExecutionAttempt
): Promise<CallAdvanceResult | CallSuspendResult> {
  const descriptor = deps.tools.describe(call.safeName)
  const adapter = descriptor
    ? invocationAdapterFor(descriptor)
    : {
        provenance: "host" as const,
        replayGuarantee: "none" as const,
        recoverInvocation: async () => ({ status: "unknown" as const }),
      }

  const recovery = await adapter.recoverInvocation(
    latest.invocationId,
    latest.invocationFingerprint
  )

  // Trust the frozen guarantee recorded on the call at ledger-creation time,
  // not whatever the live adapter reports now — recovery decisions about a
  // specific past invocation must be judged by the contract that was in
  // force when it started, matching the frozen-authority-snapshot approach
  // used elsewhere (see authority-snapshot.ts).
  const conforms = call.replayGuarantee === "dedupe-and-result-replay"

  if (recovery.status === "prior-result" && conforms) {
    const result = recovery.result as PersistedToolResult
    const completedAt = deps.now()
    const checkpoint = await mutateCheckpoint(deps, runId, (cp) =>
      updateCall(cp, modelStep, ordinal, (c) => ({
        ...c,
        attempts: c.attempts.map((a) =>
          a.attemptId === latest.attemptId
            ? {
                ...a,
                state: { status: "completed", startedAt: a.state.startedAt, completedAt, result },
              }
            : a
        ),
        resolution: { status: "resolved", reason: "executed", result, attemptId: latest.attemptId },
      }))
    )
    return { kind: "resolved", checkpoint }
  }

  if (recovery.status === "not-found" && conforms) {
    // Authoritatively never ran — safe to execute fresh with a new attempt.
    // The interrupted attempt itself is left as "started"; a fresh attempt
    // is appended and executed by the caller (executionPhase's fall-through).
    return { kind: "resolved", checkpoint: await loadOk(deps, runId) }
  }

  const checkpoint = await mutateCheckpoint(deps, runId, (cp) => {
    const withUnknownAttempt = updateCall(cp, modelStep, ordinal, (c) => ({
      ...c,
      attempts: c.attempts.map((a) =>
        a.attemptId === latest.attemptId
          ? {
              ...a,
              state: { status: "unknown", startedAt: a.state.startedAt, reason: "process-exit" },
            }
          : a
      ),
    }))
    if (!isValidRunStatusTransition(cp.status, "suspended_unknown_tool_outcome"))
      return withUnknownAttempt
    return {
      ...withUnknownAttempt,
      status: "suspended_unknown_tool_outcome",
      updatedAt: deps.now(),
    }
  })
  return { kind: "suspended", checkpoint }
}

// ---------------------------------------------------------------------------
// Materialization

async function materializeBatch(
  deps: ToolBatchDeps,
  runId: string,
  checkpoint: AgentRunCheckpointV1,
  modelStep: number
): Promise<AgentRunCheckpointV1> {
  return mutateCheckpoint(deps, runId, (cp) => {
    const batch = requireBatch(cp, modelStep)
    const content = batch.calls.map((call) => {
      if (call.resolution.status !== "resolved") {
        throw new Error(`materializeBatch: call ${call.ordinal} is not resolved`)
      }
      return {
        type: "tool_result" as const,
        toolUseId: call.toolUseId,
        content: call.resolution.result.preview,
        isError: call.resolution.result.isError,
      }
    })

    return {
      ...cp,
      toolBatches: cp.toolBatches.map((b) =>
        b.modelStep === modelStep ? { ...b, materializedAtRevision: cp.revision + 1 } : b
      ),
      messages: [
        ...cp.messages,
        { messageId: batch.resultCarrierMessageId, message: { role: "user" as const, content } },
      ],
      updatedAt: deps.now(),
    }
  })
}
