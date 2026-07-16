import { describe, expect, it } from "vitest"
import {
  admitModelAttempt,
  forfeitModelAttempt,
  releaseModelAttempt,
  settleModelAttempt,
} from "./model-admission"
import {
  BudgetOperationCorruptionError,
  BudgetOverReleaseError,
  createRootBudgetLedger,
  freeBalance,
  InsufficientBudgetError,
  reserveChildAccount,
  ROOT_ACCOUNT_ID,
} from "./root-budget-ledger"

describe("admitModelAttempt", () => {
  it("holds tokens against the root account and reduces its free balance", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const { ledger: next, receipt } = admitModelAttempt(ledger, {
      operationId: "op-admit-1",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 3000,
    })
    expect(receipt.kind).toBe("admit")
    expect(next.accounts[ROOT_ACCOUNT_ID]?.heldTokens).toBe(3000)
    expect(freeBalance(next.accounts[ROOT_ACCOUNT_ID]!)).toBe(7000)
  })

  it("fails closed rather than partially holding when the request exceeds free balance", () => {
    const ledger = createRootBudgetLedger("root-1", 1000)
    expect(() =>
      admitModelAttempt(ledger, {
        operationId: "op-1",
        accountId: ROOT_ACCOUNT_ID,
        attemptId: "attempt-1",
        heldTokens: 1001,
      })
    ).toThrow(InsufficientBudgetError)
  })

  it("checks the child account's own reserved cap, independent of the root's aggregate", () => {
    const ledger = createRootBudgetLedger("root-1", undefined) // unlimited root
    const { ledger: withChild } = reserveChildAccount(ledger, {
      operationId: "op-reserve",
      accountId: "child-1",
      taskId: "task-1",
      totalTokens: 500,
    })
    expect(() =>
      admitModelAttempt(withChild, {
        operationId: "op-admit-1",
        accountId: "child-1",
        attemptId: "attempt-1",
        heldTokens: 600, // exceeds the child's own 500 cap even though root is unlimited
      })
    ).toThrow(InsufficientBudgetError)

    const { ledger: admitted } = admitModelAttempt(withChild, {
      operationId: "op-admit-2",
      accountId: "child-1",
      attemptId: "attempt-1",
      heldTokens: 500,
    })
    expect(admitted.accounts["child-1"]?.heldTokens).toBe(500)
  })

  it("is idempotent for a retry with the same operationId and payload", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const first = admitModelAttempt(ledger, {
      operationId: "op-1",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 100,
    })
    const retry = admitModelAttempt(first.ledger, {
      operationId: "op-1",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 100,
    })
    expect(retry.ledger).toBe(first.ledger)
  })

  it("treats a retry under the same operationId with a different payload as corruption", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const first = admitModelAttempt(ledger, {
      operationId: "op-1",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 100,
    })
    expect(() =>
      admitModelAttempt(first.ledger, {
        operationId: "op-1",
        accountId: ROOT_ACCOUNT_ID,
        attemptId: "attempt-1",
        heldTokens: 999,
      })
    ).toThrow(BudgetOperationCorruptionError)
  })
})

describe("settleModelAttempt", () => {
  it("moves the held amount to consumed when actual usage is within the hold", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const { ledger: held } = admitModelAttempt(ledger, {
      operationId: "op-admit",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 3000,
    })
    const { ledger: settled, estimatorIncompatible } = settleModelAttempt(held, {
      operationId: "op-settle",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 3000,
      actualTokens: 2500,
    })
    expect(settled.accounts[ROOT_ACCOUNT_ID]?.heldTokens).toBe(0)
    expect(settled.accounts[ROOT_ACCOUNT_ID]?.consumedTokens).toBe(2500)
    expect(freeBalance(settled.accounts[ROOT_ACCOUNT_ID]!)).toBe(7500) // unused hold fully released
    expect(estimatorIncompatible).toBe(false)
  })

  it("fully charges actual usage and flags the estimator incompatible when it exceeds the hold", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const { ledger: held } = admitModelAttempt(ledger, {
      operationId: "op-admit",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 1000,
    })
    const { ledger: settled, estimatorIncompatible } = settleModelAttempt(held, {
      operationId: "op-settle",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 1000,
      actualTokens: 1500, // estimator under-reported
    })
    expect(settled.accounts[ROOT_ACCOUNT_ID]?.heldTokens).toBe(0)
    expect(settled.accounts[ROOT_ACCOUNT_ID]?.consumedTokens).toBe(1500) // fully charged, not capped at the hold
    expect(estimatorIncompatible).toBe(true)
  })

  it("throws BudgetOverReleaseError rather than going negative when releasing more than is held", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const { ledger: held } = admitModelAttempt(ledger, {
      operationId: "op-admit",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 100,
    })
    expect(() =>
      settleModelAttempt(held, {
        operationId: "op-settle",
        accountId: ROOT_ACCOUNT_ID,
        attemptId: "attempt-1",
        heldTokens: 200, // more than was ever held
        actualTokens: 50,
      })
    ).toThrow(BudgetOverReleaseError)
  })
})

describe("forfeitModelAttempt", () => {
  it("charges the entire hold as consumed (unknown_response reconciliation)", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const { ledger: held } = admitModelAttempt(ledger, {
      operationId: "op-admit",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 2000,
    })
    const { ledger: forfeited } = forfeitModelAttempt(held, {
      operationId: "op-forfeit",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 2000,
    })
    expect(forfeited.accounts[ROOT_ACCOUNT_ID]?.heldTokens).toBe(0)
    expect(forfeited.accounts[ROOT_ACCOUNT_ID]?.consumedTokens).toBe(2000)
  })
})

describe("releaseModelAttempt", () => {
  it("clears the hold without charging anything (held-undispatched reconciliation)", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const { ledger: held } = admitModelAttempt(ledger, {
      operationId: "op-admit",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 2000,
    })
    const { ledger: released } = releaseModelAttempt(held, {
      operationId: "op-release",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 2000,
    })
    expect(released.accounts[ROOT_ACCOUNT_ID]?.heldTokens).toBe(0)
    expect(released.accounts[ROOT_ACCOUNT_ID]?.consumedTokens).toBe(0)
    expect(freeBalance(released.accounts[ROOT_ACCOUNT_ID]!)).toBe(10_000)
  })

  it("is idempotent for a retry with the same operationId and payload", () => {
    const ledger = createRootBudgetLedger("root-1", 10_000)
    const { ledger: held } = admitModelAttempt(ledger, {
      operationId: "op-admit",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 2000,
    })
    const first = releaseModelAttempt(held, {
      operationId: "op-release",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 2000,
    })
    const retry = releaseModelAttempt(first.ledger, {
      operationId: "op-release",
      accountId: ROOT_ACCOUNT_ID,
      attemptId: "attempt-1",
      heldTokens: 2000,
    })
    expect(retry.ledger).toBe(first.ledger)
  })
})
