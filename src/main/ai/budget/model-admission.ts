import type { BudgetOperationReceipt, RootBudgetLedgerV1 } from "./root-budget-ledger"
import {
  BudgetOverReleaseError,
  checkOperationIdempotency,
  freeBalance,
  getAccountOrThrow,
  InsufficientBudgetError,
} from "./root-budget-ledger"

// Model-attempt-specific operations over the durable root budget ledger
// (design §"Provider budget admission"): admit places a hold before
// dispatch, settle charges actual usage, forfeit is the crash/unknown-
// response reconciliation, and release is the held-but-never-dispatched
// reconciliation. Every operation is idempotent per operationId and checks
// the target account's own free balance before committing — a child
// account's cap was already carved out of the root at reservation time, so
// admission here never needs a second root-aggregate check.

export interface ModelAdmissionOperationInput {
  operationId: string
  accountId: string
  attemptId: string
  heldTokens: number
}

export function admitModelAttempt(
  ledger: RootBudgetLedgerV1,
  input: ModelAdmissionOperationInput
): { ledger: RootBudgetLedgerV1; receipt: BudgetOperationReceipt } {
  const idempotency = checkOperationIdempotency(ledger, input.operationId, input)
  if (idempotency.replay) return { ledger, receipt: idempotency.receipt }

  const account = getAccountOrThrow(ledger, input.accountId)
  const free = freeBalance(account)
  if (free !== undefined && input.heldTokens > free) {
    throw new InsufficientBudgetError(
      `cannot admit ${input.heldTokens} tokens on account ${input.accountId}: only ${free} free`
    )
  }

  const receipt: BudgetOperationReceipt = {
    operationId: input.operationId,
    kind: "admit",
    accountId: input.accountId,
    attemptId: input.attemptId,
    payloadHash: idempotency.payloadHash,
    heldTokens: input.heldTokens,
    appliedAtRevision: ledger.revision + 1,
  }
  const nextLedger: RootBudgetLedgerV1 = {
    ...ledger,
    accounts: {
      ...ledger.accounts,
      [input.accountId]: { ...account, heldTokens: account.heldTokens + input.heldTokens },
    },
    operations: { ...ledger.operations, [input.operationId]: receipt },
  }
  return { ledger: nextLedger, receipt }
}

export interface SettleModelAttemptInput extends ModelAdmissionOperationInput {
  actualTokens: number
}

/**
 * Releases the hold and charges `actualTokens` as consumed. When
 * `actualTokens` exceeds what was held, the excess is still fully charged
 * (never silently capped) and `estimatorIncompatible` comes back true so
 * the caller can fail the run and mark that estimator/profile unusable for
 * finite-budget work.
 */
export function settleModelAttempt(
  ledger: RootBudgetLedgerV1,
  input: SettleModelAttemptInput
): { ledger: RootBudgetLedgerV1; receipt: BudgetOperationReceipt; estimatorIncompatible: boolean } {
  const idempotency = checkOperationIdempotency(ledger, input.operationId, input)
  if (idempotency.replay) {
    return {
      ledger,
      receipt: idempotency.receipt,
      estimatorIncompatible: input.actualTokens > input.heldTokens,
    }
  }

  const account = getAccountOrThrow(ledger, input.accountId)
  if (input.heldTokens > account.heldTokens) {
    throw new BudgetOverReleaseError(
      `cannot settle ${input.heldTokens} held tokens on account ${input.accountId}: only ${account.heldTokens} are held`
    )
  }

  const estimatorIncompatible = input.actualTokens > input.heldTokens
  const receipt: BudgetOperationReceipt = {
    operationId: input.operationId,
    kind: "settle",
    accountId: input.accountId,
    attemptId: input.attemptId,
    payloadHash: idempotency.payloadHash,
    consumedTokens: input.actualTokens,
    releasedTokens: input.heldTokens,
    appliedAtRevision: ledger.revision + 1,
  }
  const nextLedger: RootBudgetLedgerV1 = {
    ...ledger,
    accounts: {
      ...ledger.accounts,
      [input.accountId]: {
        ...account,
        heldTokens: account.heldTokens - input.heldTokens,
        consumedTokens: account.consumedTokens + input.actualTokens,
      },
    },
    operations: { ...ledger.operations, [input.operationId]: receipt },
  }
  return { ledger: nextLedger, receipt, estimatorIncompatible }
}

/** Dispatched-unknown reconciliation: the entire hold becomes consumed,
 *  deliberately overcounting an ambiguous request rather than leaving it
 *  unaccounted. */
export function forfeitModelAttempt(
  ledger: RootBudgetLedgerV1,
  input: ModelAdmissionOperationInput
): { ledger: RootBudgetLedgerV1; receipt: BudgetOperationReceipt } {
  const idempotency = checkOperationIdempotency(ledger, input.operationId, input)
  if (idempotency.replay) return { ledger, receipt: idempotency.receipt }

  const account = getAccountOrThrow(ledger, input.accountId)
  if (input.heldTokens > account.heldTokens) {
    throw new BudgetOverReleaseError(
      `cannot forfeit ${input.heldTokens} held tokens on account ${input.accountId}: only ${account.heldTokens} are held`
    )
  }

  const receipt: BudgetOperationReceipt = {
    operationId: input.operationId,
    kind: "forfeit",
    accountId: input.accountId,
    attemptId: input.attemptId,
    payloadHash: idempotency.payloadHash,
    consumedTokens: input.heldTokens,
    appliedAtRevision: ledger.revision + 1,
  }
  const nextLedger: RootBudgetLedgerV1 = {
    ...ledger,
    accounts: {
      ...ledger.accounts,
      [input.accountId]: {
        ...account,
        heldTokens: account.heldTokens - input.heldTokens,
        consumedTokens: account.consumedTokens + input.heldTokens,
      },
    },
    operations: { ...ledger.operations, [input.operationId]: receipt },
  }
  return { ledger: nextLedger, receipt }
}

/** Held-undispatched reconciliation: clears the hold, charges nothing. */
export function releaseModelAttempt(
  ledger: RootBudgetLedgerV1,
  input: ModelAdmissionOperationInput
): { ledger: RootBudgetLedgerV1; receipt: BudgetOperationReceipt } {
  const idempotency = checkOperationIdempotency(ledger, input.operationId, input)
  if (idempotency.replay) return { ledger, receipt: idempotency.receipt }

  const account = getAccountOrThrow(ledger, input.accountId)
  if (input.heldTokens > account.heldTokens) {
    throw new BudgetOverReleaseError(
      `cannot release ${input.heldTokens} held tokens on account ${input.accountId}: only ${account.heldTokens} are held`
    )
  }

  const receipt: BudgetOperationReceipt = {
    operationId: input.operationId,
    kind: "release",
    accountId: input.accountId,
    attemptId: input.attemptId,
    payloadHash: idempotency.payloadHash,
    releasedTokens: input.heldTokens,
    appliedAtRevision: ledger.revision + 1,
  }
  const nextLedger: RootBudgetLedgerV1 = {
    ...ledger,
    accounts: {
      ...ledger.accounts,
      [input.accountId]: { ...account, heldTokens: account.heldTokens - input.heldTokens },
    },
    operations: { ...ledger.operations, [input.operationId]: receipt },
  }
  return { ledger: nextLedger, receipt }
}
