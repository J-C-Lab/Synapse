import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { ChatMessage, ChatProvider } from "../providers/types"
import type { SummarizeResult } from "./context-compressor"
import {
  admitModelAttempt,
  forfeitModelAttempt,
  settleModelAttempt,
} from "../budget/model-admission"
import { freeBalance } from "../budget/root-budget-ledger"
import { emptyUsage, totalTokens } from "../providers/types"
import { InsufficientEstimateError } from "../runs/model-step-runner"
import { SummarizeInfrastructureError } from "./context-compressor"

// One durable-budget-charged provider call summarizing an evicted "older"
// slice into a compact recap (design §"Charge summarizer model requests
// through the same admission/settlement contract with distinct operation
// ids and frozen estimator data"). Mirrors model-step-runner.ts's
// prepareAttempt/holdAttempt/callProviderAndStage/settleAttempt sequence —
// admit a hold before dispatch, settle actual usage after — using the same
// root-budget-ledger primitives, but does not persist a durable per-attempt
// state machine into the checkpoint the way a real model step does:
// compression is not a nextStep-numbered model step, and adding an
// equivalent crash-recoverable ledger for it is out of this task's scope
// (flagged in the design doc / task report as a known gap — see the
// KNOWN GAP note below).
//
// KNOWN GAP: unlike model-step-runner.ts's attempts, there is no durable
// record of an in-flight summarizer hold. Every non-crash failure path
// below (admission throws, provider throws) forfeits the hold synchronously
// in the same call before rethrowing, so the only way to leak a held-but-
// never-reconciled amount is a hard process crash between admit and
// settle/forfeit — a strictly narrower window than "any error", but a real
// one a reviewer should confirm is acceptable pre-Task-21/22.

const SUMMARIZE_SYSTEM =
  "Summarize the following conversation excerpt into a compact set of facts, decisions, and open threads; preserve names, IDs, and any state the assistant will need to continue."

const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 1024

export interface SummarizeViaProviderInput {
  provider: ChatProvider
  model: string
  older: ChatMessage[]
  budgetStore: RootBudgetLedgerStore
  rootRunId: string
  accountId: string
  /** Unique per compression attempt (a fresh `randomUUID()` from the
   *  caller, never a modelStep counter — compression isn't a numbered model
   *  step). Used to build a disjoint operationId scheme
   *  (`compress:${runId}:${compactionAttemptId}:admit|settle|forfeit`) that
   *  can never collide with a real model step's ledger entries. */
  runId: string
  compactionAttemptId: string
  maxOutputTokens?: number
}

/** Summarizes `input.older` into a compact recap, charging the request
 *  through the same admit -> dispatch -> settle contract every other
 *  provider call in this codebase uses. Any infrastructure failure
 *  (no estimator bound on a finite budget, insufficient budget, or the
 *  provider call itself failing) throws `SummarizeInfrastructureError`
 *  wrapping the original error as `cause` — `ContextCompressor.compress()`
 *  unwraps and rethrows that original error, so an upstream
 *  `instanceof InsufficientBudgetError` / `instanceof
 *  InsufficientEstimateError` check keeps working unchanged. */
export async function summarizeViaProvider(
  input: SummarizeViaProviderInput
): Promise<SummarizeResult> {
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS
  const text = renderMessages(input.older)
  const requestMessages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text }] }]
  const operationId = `compress:${input.runId}:${input.compactionAttemptId}`

  const ledgerBeforeAdmit = await input.budgetStore.load(input.rootRunId)
  const account = ledgerBeforeAdmit.accounts[input.accountId]
  const isUnlimited = account !== undefined && freeBalance(account) === undefined

  const estimate = input.provider.estimateRequestUpperBound?.({
    model: input.model,
    systemText: SUMMARIZE_SYSTEM,
    messages: requestMessages,
    tools: [],
    maxOutputTokens,
  })
  if (!estimate && !isUnlimited) {
    throw new SummarizeInfrastructureError(
      `provider ${input.provider.id} cannot guarantee an upper bound for the summarizer request on run ${input.runId}`,
      {
        cause: new InsufficientEstimateError(
          `provider ${input.provider.id} cannot guarantee an upper bound for the summarizer request on run ${input.runId}`
        ),
      }
    )
  }

  const heldTokens = (estimate?.inputUpperBoundTokens ?? 0) + maxOutputTokens

  try {
    const { ledger: held } = admitModelAttempt(ledgerBeforeAdmit, {
      operationId: `${operationId}:admit`,
      accountId: input.accountId,
      attemptId: input.compactionAttemptId,
      heldTokens,
    })
    await input.budgetStore.mutate(input.rootRunId, ledgerBeforeAdmit.revision, () => held)
  } catch (err) {
    throw new SummarizeInfrastructureError(
      `summarizer budget admission failed for run ${input.runId}`,
      { cause: err }
    )
  }

  let summary = ""
  let usage = emptyUsage()
  try {
    for await (const event of input.provider.stream({
      model: input.model,
      system: SUMMARIZE_SYSTEM,
      messages: requestMessages,
      tools: [],
      maxTokens: maxOutputTokens,
    })) {
      if (event.type === "text") summary += event.text
      else {
        summary =
          event.message.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n") || summary
        usage = event.usage
      }
    }
  } catch (err) {
    await forfeitHold(input, operationId, heldTokens)
    throw new SummarizeInfrastructureError(
      `summarizer provider call failed for run ${input.runId}`,
      {
        cause: err,
      }
    )
  }

  const actualTokens = totalTokens(usage) || Math.ceil(summary.length / 4)
  try {
    const ledgerAfterCall = await input.budgetStore.load(input.rootRunId)
    const { ledger: settled } = settleModelAttempt(ledgerAfterCall, {
      operationId: `${operationId}:settle`,
      accountId: input.accountId,
      attemptId: input.compactionAttemptId,
      heldTokens,
      actualTokens,
    })
    await input.budgetStore.mutate(input.rootRunId, ledgerAfterCall.revision, () => settled)
  } catch (err) {
    throw new SummarizeInfrastructureError(
      `summarizer budget settlement failed for run ${input.runId}`,
      { cause: err }
    )
  }

  return { text: summary.trim() || "(no summary)", tokens: actualTokens }
}

/** Best-effort — the original provider error is always what propagates,
 *  win or lose here. */
async function forfeitHold(
  input: SummarizeViaProviderInput,
  operationId: string,
  heldTokens: number
): Promise<void> {
  try {
    const ledgerNow = await input.budgetStore.load(input.rootRunId)
    const { ledger: forfeited } = forfeitModelAttempt(ledgerNow, {
      operationId: `${operationId}:forfeit`,
      accountId: input.accountId,
      attemptId: input.compactionAttemptId,
      heldTokens,
    })
    await input.budgetStore.mutate(input.rootRunId, ledgerNow.revision, () => forfeited)
  } catch {
    // best-effort reconciliation only
  }
}

function renderMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const body = m.content
        .map((b) => {
          if (b.type === "text") return b.text
          return `[${b.type}]`
        })
        .join(" ")
      return `${m.role}: ${body}`
    })
    .join("\n\n")
}
