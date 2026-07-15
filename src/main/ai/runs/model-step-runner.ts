import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { ProviderStreamDeadlines } from "../provider-stream-deadlines"
import type { ChatMessage, ChatProvider, ProviderToolSchema, TokenUsage } from "../providers/types"
import type { AgentRunStore } from "./agent-run-store"
import type { CanonicalJson } from "./canonical-json"
import type {
  AgentRunCheckpointV1,
  ModelBudgetAdmission,
  ModelRequestAttempt,
  ModelStepLedger,
} from "./checkpoint-schema"
import type { RunEventEmitter } from "./run-event-emitter"
import { randomUUID } from "node:crypto"
import { injectUntrustedContext } from "../agent-runtime"
import {
  admitModelAttempt,
  forfeitModelAttempt,
  settleModelAttempt,
} from "../budget/model-admission"
import { freeBalance, ROOT_ACCOUNT_ID } from "../budget/root-budget-ledger"
import { streamWithDeadlines } from "../provider-stream-deadlines"
import { addUsage, emptyUsage, totalTokens } from "../providers/types"
import { canonicalHash } from "./canonical-json"
import { assembleFromContextSnapshot } from "./context-snapshot"
import { toChatMessages } from "./durable-messages"

// Durable model-attempt boundaries (design §"Implement durable model-
// attempt boundaries"). advanceModelStep always reloads the latest
// checkpoint and drives exactly one model step through
// prepared -> held -> dispatched -> response_staged -> budget_settled,
// resuming correctly from any intermediate state after a crash. No
// authority-bearing progress is ever kept only in a stack local — every
// transition is a checkpoint/ledger write the caller awaits before
// proceeding to the next one.

export type ModelStepFaultPoint =
  | "after_prepare"
  | "after_hold_ledger"
  | "after_hold"
  | "after_dispatch_checkpoint"
  | "before_provider_call"
  | "after_provider_call"
  | "after_response_staged"
  | "after_settle_ledger"
  | "after_settle"
  | "after_unknown_response_checkpoint"
  | "after_forfeit_ledger"
  | "after_forfeit_checkpoint"

export interface ModelStepDeps {
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  provider: ChatProvider
  /** Live, currently-visible tool schemas — not part of the frozen
   *  checkpoint (only tool authority hashes are frozen; the actual schema
   *  bytes are supplied fresh on every call, same as today's AgentRuntime). */
  tools: () => ProviderToolSchema[]
  now: () => number
  /** Absolute headers/idle/duration deadlines for the provider call — see
   *  provider-stream-deadlines.ts. A deadline firing is just another
   *  dispatch failure to this state machine: it propagates like any other
   *  thrown error, leaving the attempt "dispatched" for the next call to
   *  forfeit and retry. */
  providerStreamDeadlines?: ProviderStreamDeadlines
  /** Caller-supplied cancellation (e.g. the user cancelling a chat turn),
   *  forwarded to the provider request alongside the deadline timers —
   *  streamWithDeadlines combines both into one signal. Dispatched state is
   *  left exactly as it is on abort; the next call's own recovery
   *  (ensureForfeitedAndPrepareNext) reconciles it like any other
   *  interrupted dispatch. */
  signal?: AbortSignal
  /** Deterministic fault injection for tests — called at named boundaries.
   *  Throwing here simulates a crash at exactly that point; unit tests use
   *  this instead of timing sleeps. */
  fault?: (point: ModelStepFaultPoint) => void | Promise<void>
  /** Forwards each incremental text delta as the provider streams it, for
   *  live UI updates. Purely observational — never persisted or awaited for
   *  correctness; the durable checkpoint only ever gets the final assembled
   *  message. Omitted by every caller that doesn't need live streaming. */
  onTextDelta?: (text: string) => void
  /** Emits budget_admission_updated/model_completed to the durable event
   *  journal at each transition — purely observational (renderer
   *  projection), never awaited for correctness. Omitted by callers that
   *  don't need durable event history (most existing tests). */
  eventEmitter?: RunEventEmitter
}

export class InsufficientEstimateError extends Error {}

export interface ModelStepOutcome {
  kind: "settled"
  checkpoint: AgentRunCheckpointV1
  assistantMessage: ChatMessage
  estimatorIncompatible: boolean
}

export async function advanceModelStep(
  deps: ModelStepDeps,
  runId: string
): Promise<ModelStepOutcome> {
  const loaded = await deps.runStore.load(runId)
  if (!loaded.ok)
    throw new Error(`cannot advance model step for run ${runId}: checkpoint is ${loaded.reason}`)
  let checkpoint = loaded.checkpoint
  const step = checkpoint.nextStep
  let attempt = latestAttempt(checkpoint, step)

  if (!attempt) {
    checkpoint = await prepareAttempt(deps, checkpoint, step)
    attempt = latestAttempt(checkpoint, step)!
  }

  if (attempt.state === "dispatched" || attempt.state === "unknown_response") {
    // "dispatched" observed here is only ever a genuine resume from a prior
    // process — a fresh call never sees it (the dispatch and provider call
    // happen in the same continuation below).
    checkpoint = await ensureForfeitedAndPrepareNext(deps, checkpoint, step, attempt)
    attempt = latestAttempt(checkpoint, step)!
  }

  if (attempt.state === "prepared") {
    checkpoint = await holdAttempt(deps, checkpoint, step, attempt)
    attempt = latestAttempt(checkpoint, step)!
  }

  if (attempt.state === "held") {
    checkpoint = await markDispatched(deps, checkpoint, step, attempt)
    attempt = latestAttempt(checkpoint, step)!
    checkpoint = await callProviderAndStage(deps, checkpoint, step, attempt)
    attempt = latestAttempt(checkpoint, step)!
  }

  let estimatorIncompatible = false
  if (attempt.state === "response_staged") {
    const settled = await settleAttempt(deps, checkpoint, step, attempt)
    checkpoint = settled.checkpoint
    estimatorIncompatible = settled.estimatorIncompatible
    attempt = latestAttempt(checkpoint, step)!
  }

  if (attempt.state !== "budget_settled") {
    throw new Error(`model step did not reach budget_settled (stuck at ${attempt.state})`)
  }

  const durable = checkpoint.messages.find((m) => m.messageId === attempt!.assistantMessageId)
  if (!durable) throw new Error("assistant message missing from checkpoint after settlement")

  return { kind: "settled", checkpoint, assistantMessage: durable.message, estimatorIncompatible }
}

function latestAttempt(
  checkpoint: AgentRunCheckpointV1,
  step: number
): ModelRequestAttempt | undefined {
  return checkpoint.modelSteps.find((s) => s.step === step)?.attempts.at(-1)
}

function upsertAttempt(
  modelSteps: ModelStepLedger[],
  step: number,
  attempt: ModelRequestAttempt
): ModelStepLedger[] {
  const index = modelSteps.findIndex((s) => s.step === step)
  if (index === -1) return [...modelSteps, { step, attempts: [attempt] }]
  const existing = modelSteps[index]!
  const attemptIndex = existing.attempts.findIndex((a) => a.attemptId === attempt.attemptId)
  const attempts =
    attemptIndex === -1
      ? [...existing.attempts, attempt]
      : existing.attempts.map((a, i) => (i === attemptIndex ? attempt : a))
  const updated: ModelStepLedger = {
    ...existing,
    attempts,
    acceptedAttemptId:
      attempt.state === "budget_settled" ? attempt.attemptId : existing.acceptedAttemptId,
  }
  return modelSteps.map((s, i) => (i === index ? updated : s))
}

async function prepareAttempt(
  deps: ModelStepDeps,
  checkpoint: AgentRunCheckpointV1,
  step: number
): Promise<AgentRunCheckpointV1> {
  const { system, messages } = outgoingRequestContext(checkpoint)
  const tools = deps.tools()
  const maxOutputTokens = checkpoint.config.maxOutputTokens

  const accountId = budgetAccountIdFor(checkpoint)
  const ledgerNow = await deps.budgetStore.load(checkpoint.identity.rootRunId)
  const account = ledgerNow.accounts[accountId]
  const isUnlimited = account !== undefined && freeBalance(account) === undefined

  const estimate = deps.provider.estimateRequestUpperBound?.({
    model: checkpoint.config.model,
    systemText: system,
    messages,
    tools,
    maxOutputTokens,
  })
  if (!estimate && !isUnlimited) {
    throw new InsufficientEstimateError(
      `provider ${deps.provider.id} cannot guarantee an upper bound for finite-budget run ${checkpoint.identity.runId}`
    )
  }

  const attemptId = randomUUID()
  const admission: ModelBudgetAdmission = {
    operationId: `admit:${checkpoint.identity.runId}:${step}:${attemptId}`,
    accountId,
    estimatorId: estimate?.estimatorId ?? "none",
    estimatorVersion: estimate?.estimatorVersion ?? "0",
    inputUpperBoundTokens: estimate?.inputUpperBoundTokens ?? 0,
    maxOutputTokens,
    heldTokens: 0,
    state: "planned",
  }
  const attempt: ModelRequestAttempt = {
    attemptId,
    requestHash: requestHashFor(system, messages, tools, maxOutputTokens),
    state: "prepared",
    admission,
  }

  const next = await deps.runStore.mutate(checkpoint.identity.runId, checkpoint.revision, (cp) => ({
    ...cp,
    modelSteps: upsertAttempt(cp.modelSteps, step, attempt),
  }))
  await deps.fault?.("after_prepare")
  return next
}

async function holdAttempt(
  deps: ModelStepDeps,
  checkpoint: AgentRunCheckpointV1,
  step: number,
  attempt: ModelRequestAttempt
): Promise<AgentRunCheckpointV1> {
  const rootRunId = checkpoint.identity.rootRunId
  const heldTokens = attempt.admission.inputUpperBoundTokens + attempt.admission.maxOutputTokens

  const ledgerNow = await deps.budgetStore.load(rootRunId)
  const { ledger: heldLedger } = admitModelAttempt(ledgerNow, {
    operationId: attempt.admission.operationId,
    accountId: attempt.admission.accountId,
    attemptId: attempt.attemptId,
    heldTokens,
  })
  await deps.budgetStore.mutate(rootRunId, ledgerNow.revision, () => heldLedger)
  await deps.fault?.("after_hold_ledger")

  const heldAttempt: ModelRequestAttempt = {
    ...attempt,
    state: "held",
    admission: { ...attempt.admission, heldTokens, state: "held" },
  }
  const next = await deps.runStore.mutate(checkpoint.identity.runId, checkpoint.revision, (cp) => ({
    ...cp,
    modelSteps: upsertAttempt(cp.modelSteps, step, heldAttempt),
  }))
  await deps.fault?.("after_hold")
  await deps.eventEmitter?.emit({
    type: "budget_admission_updated",
    operationId: attempt.admission.operationId,
    state: "held",
    heldTokens,
  })
  return next
}

async function markDispatched(
  deps: ModelStepDeps,
  checkpoint: AgentRunCheckpointV1,
  step: number,
  attempt: ModelRequestAttempt
): Promise<AgentRunCheckpointV1> {
  const dispatchedAttempt: ModelRequestAttempt = { ...attempt, state: "dispatched" }
  const next = await deps.runStore.mutate(checkpoint.identity.runId, checkpoint.revision, (cp) => ({
    ...cp,
    modelSteps: upsertAttempt(cp.modelSteps, step, dispatchedAttempt),
  }))
  await deps.fault?.("after_dispatch_checkpoint")
  return next
}

async function callProviderAndStage(
  deps: ModelStepDeps,
  checkpoint: AgentRunCheckpointV1,
  step: number,
  attempt: ModelRequestAttempt
): Promise<AgentRunCheckpointV1> {
  await deps.fault?.("before_provider_call")

  const { system, messages } = outgoingRequestContext(checkpoint)
  const tools = deps.tools()

  let assistantMessage: ChatMessage | undefined
  let usage: TokenUsage = emptyUsage()
  for await (const event of streamWithDeadlines(
    deps.provider,
    {
      model: checkpoint.config.model,
      system,
      messages,
      tools,
      maxTokens: checkpoint.config.maxOutputTokens,
      signal: deps.signal,
    },
    deps.providerStreamDeadlines
  )) {
    if (event.type === "text") {
      deps.onTextDelta?.(event.text)
    } else if (event.type === "message") {
      assistantMessage = event.message
      usage = event.usage
    }
  }
  await deps.fault?.("after_provider_call")
  if (!assistantMessage) throw new Error("provider stream ended without a final message")

  const messageId = randomUUID()
  const stagedAttempt: ModelRequestAttempt = {
    ...attempt,
    state: "response_staged",
    assistantMessageId: messageId,
    usage,
  }
  const next = await deps.runStore.mutate(checkpoint.identity.runId, checkpoint.revision, (cp) => ({
    ...cp,
    modelSteps: upsertAttempt(cp.modelSteps, step, stagedAttempt),
    messages: [
      ...cp.messages,
      { messageId, producedByRunId: cp.identity.runId, message: assistantMessage! },
    ],
  }))
  await deps.fault?.("after_response_staged")
  return next
}

async function settleAttempt(
  deps: ModelStepDeps,
  checkpoint: AgentRunCheckpointV1,
  step: number,
  attempt: ModelRequestAttempt
): Promise<{ checkpoint: AgentRunCheckpointV1; estimatorIncompatible: boolean }> {
  const rootRunId = checkpoint.identity.rootRunId
  const actualTokens = totalTokens(attempt.usage ?? emptyUsage())

  const ledgerNow = await deps.budgetStore.load(rootRunId)
  const { ledger: settledLedger, estimatorIncompatible } = settleModelAttempt(ledgerNow, {
    operationId: `settle:${attempt.admission.operationId}`,
    accountId: attempt.admission.accountId,
    attemptId: attempt.attemptId,
    heldTokens: attempt.admission.heldTokens,
    actualTokens,
  })
  await deps.budgetStore.mutate(rootRunId, ledgerNow.revision, () => settledLedger)
  await deps.fault?.("after_settle_ledger")

  const settledAttempt: ModelRequestAttempt = {
    ...attempt,
    state: "budget_settled",
    admission: { ...attempt.admission, state: "settled", actualTokens },
  }
  const next = await deps.runStore.mutate(checkpoint.identity.runId, checkpoint.revision, (cp) => ({
    ...cp,
    modelSteps: upsertAttempt(cp.modelSteps, step, settledAttempt),
    usage: addUsage(cp.usage, attempt.usage ?? emptyUsage()),
  }))
  await deps.fault?.("after_settle")
  await deps.eventEmitter?.emit({
    type: "budget_admission_updated",
    operationId: attempt.admission.operationId,
    state: "settled",
    consumedTokens: actualTokens,
  })
  if (attempt.assistantMessageId) {
    const usage = attempt.usage ?? emptyUsage()
    await deps.eventEmitter?.emit({
      type: "model_completed",
      step,
      assistantMessageId: attempt.assistantMessageId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
  }
  return { checkpoint: next, estimatorIncompatible }
}

/** Dispatched-unknown reconciliation: forfeit the whole hold under the same
 *  operation id, then prepare a fresh attempt. Safe to call repeatedly —
 *  every sub-step checks current state or is itself idempotent. */
async function ensureForfeitedAndPrepareNext(
  deps: ModelStepDeps,
  checkpoint: AgentRunCheckpointV1,
  step: number,
  attempt: ModelRequestAttempt
): Promise<AgentRunCheckpointV1> {
  let cp = checkpoint
  let current = attempt

  if (current.state !== "unknown_response") {
    const unknownAttempt: ModelRequestAttempt = { ...current, state: "unknown_response" }
    cp = await deps.runStore.mutate(cp.identity.runId, cp.revision, (c) => ({
      ...c,
      modelSteps: upsertAttempt(c.modelSteps, step, unknownAttempt),
    }))
    await deps.fault?.("after_unknown_response_checkpoint")
    current = latestAttempt(cp, step)!
  }

  if (current.admission.state !== "forfeited") {
    const rootRunId = cp.identity.rootRunId
    const ledgerNow = await deps.budgetStore.load(rootRunId)
    const { ledger: forfeitedLedger } = forfeitModelAttempt(ledgerNow, {
      operationId: `forfeit:${current.admission.operationId}`,
      accountId: current.admission.accountId,
      attemptId: current.attemptId,
      heldTokens: current.admission.heldTokens,
    })
    await deps.budgetStore.mutate(rootRunId, ledgerNow.revision, () => forfeitedLedger)
    await deps.fault?.("after_forfeit_ledger")

    const forfeitedAttempt: ModelRequestAttempt = {
      ...current,
      admission: { ...current.admission, state: "forfeited" },
    }
    cp = await deps.runStore.mutate(cp.identity.runId, cp.revision, (c) => ({
      ...c,
      modelSteps: upsertAttempt(c.modelSteps, step, forfeitedAttempt),
    }))
    await deps.fault?.("after_forfeit_checkpoint")
    await deps.eventEmitter?.emit({
      type: "budget_admission_updated",
      operationId: current.admission.operationId,
      state: "forfeited",
      consumedTokens: current.admission.heldTokens,
    })
  }

  return prepareAttempt(deps, cp, step)
}

/** A run admits/settles against its own account: the root account for a run
 *  that is its own root (interactive/background — identity.runId ===
 *  rootRunId), or the child-task account reserved for it under the shared
 *  root ledger otherwise (a subagent — see runs/subagent-run-setup.ts's
 *  reserveChildAccount call). A child-task account's totalTokens is always
 *  finite (reserveChildAccount requires a concrete number), so a subagent
 *  step can never be treated as unlimited even when its root run is. */
function budgetAccountIdFor(checkpoint: AgentRunCheckpointV1): string {
  return checkpoint.identity.runId === checkpoint.identity.rootRunId
    ? ROOT_ACCOUNT_ID
    : checkpoint.identity.runId
}

/** The exact system text and wire messages one provider request is built
 *  from: durable messages plus the frozen workspace-instruction text
 *  transiently injected onto the latest user text message — never persisted
 *  back into the checkpoint, matching AgentRuntime's existing in-memory
 *  behavior (see agent-runtime.ts's injectUntrustedContext). Used for both
 *  the upper-bound estimate/request hash and the actual dispatched request,
 *  so admission is never computed against a smaller payload than what's
 *  actually sent. */
function outgoingRequestContext(checkpoint: AgentRunCheckpointV1): {
  system: string
  messages: ChatMessage[]
} {
  const { system, instructionContextText } = assembleFromContextSnapshot(checkpoint.config.context)
  const durableMessages = toChatMessages(checkpoint.messages)
  const messages = instructionContextText
    ? injectUntrustedContext(durableMessages, instructionContextText)
    : durableMessages
  return { system, messages }
}

function requestHashFor(
  system: string,
  messages: ChatMessage[],
  tools: ProviderToolSchema[],
  maxOutputTokens: number
): string {
  // Diagnostics/dedup fingerprint only — never used for an authority
  // decision, so this doesn't need canonical-json's finite-number/undefined
  // handling guarantees, just determinism for identical requests.
  return canonicalHash({
    system,
    messages: messages as unknown as CanonicalJson,
    tools: tools as unknown as CanonicalJson,
    maxOutputTokens,
  })
}
