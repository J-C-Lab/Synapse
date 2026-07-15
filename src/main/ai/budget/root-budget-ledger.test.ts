import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  BudgetAccountNotFoundError,
  BudgetOperationCorruptionError,
  createRootBudgetLedger,
  freeBalance,
  InsufficientBudgetError,
  InvalidRootRunIdError,
  reserveChildAccount,
  ROOT_ACCOUNT_ID,
  RootBudgetLedgerNotFoundError,
  RootBudgetLedgerStore,
  StaleLedgerRevisionError,
} from "./root-budget-ledger"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-root-budget-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("createRootBudgetLedger / freeBalance", () => {
  it("starts with a single unlimited root account when totalTokens is omitted", () => {
    const ledger = createRootBudgetLedger("root-run-1", undefined)
    expect(ledger.accounts[ROOT_ACCOUNT_ID]).toMatchObject({
      kind: "root",
      totalTokens: undefined,
      heldTokens: 0,
      consumedTokens: 0,
      reservedTokens: 0,
    })
    expect(freeBalance(ledger.accounts[ROOT_ACCOUNT_ID]!)).toBeUndefined()
  })

  it("computes a finite free balance for a bounded account", () => {
    const ledger = createRootBudgetLedger("root-run-1", 10_000)
    expect(freeBalance(ledger.accounts[ROOT_ACCOUNT_ID]!)).toBe(10_000)
  })
})

describe("reserveChildAccount", () => {
  it("carves a finite child reservation out of an unlimited root without blocking", () => {
    const ledger = createRootBudgetLedger("root-run-1", undefined)
    const { ledger: next } = reserveChildAccount(ledger, {
      operationId: "op-reserve-1",
      accountId: "child-1",
      taskId: "task-1",
      totalTokens: 5000,
    })
    expect(next.accounts["child-1"]).toMatchObject({
      kind: "child-task",
      taskId: "task-1",
      totalTokens: 5000,
      heldTokens: 0,
      consumedTokens: 0,
    })
    // Root stays unlimited but tracks the reservation for bookkeeping.
    expect(next.accounts[ROOT_ACCOUNT_ID]?.reservedTokens).toBe(5000)
    expect(freeBalance(next.accounts[ROOT_ACCOUNT_ID]!)).toBeUndefined()
  })

  it("rejects a reservation that would exceed a finite root's free balance", () => {
    const ledger = createRootBudgetLedger("root-run-1", 1000)
    expect(() =>
      reserveChildAccount(ledger, {
        operationId: "op-1",
        accountId: "child-1",
        taskId: "task-1",
        totalTokens: 2000,
      })
    ).toThrow(InsufficientBudgetError)
  })

  it("reduces a finite root's free balance by the reserved amount", () => {
    const ledger = createRootBudgetLedger("root-run-1", 1000)
    const { ledger: next } = reserveChildAccount(ledger, {
      operationId: "op-1",
      accountId: "child-1",
      taskId: "task-1",
      totalTokens: 400,
    })
    expect(freeBalance(next.accounts[ROOT_ACCOUNT_ID]!)).toBe(600)
  })

  it("is idempotent for a retry with the same operationId and payload", () => {
    const ledger = createRootBudgetLedger("root-run-1", 1000)
    const first = reserveChildAccount(ledger, {
      operationId: "op-1",
      accountId: "child-1",
      taskId: "task-1",
      totalTokens: 400,
    })
    const retry = reserveChildAccount(first.ledger, {
      operationId: "op-1",
      accountId: "child-1",
      taskId: "task-1",
      totalTokens: 400,
    })
    expect(retry.ledger).toBe(first.ledger) // unchanged — pure no-op
    expect(retry.receipt).toEqual(first.receipt)
  })

  it("treats a retry under the same operationId with a different payload as corruption", () => {
    const ledger = createRootBudgetLedger("root-run-1", 1000)
    const first = reserveChildAccount(ledger, {
      operationId: "op-1",
      accountId: "child-1",
      taskId: "task-1",
      totalTokens: 400,
    })
    expect(() =>
      reserveChildAccount(first.ledger, {
        operationId: "op-1",
        accountId: "child-1",
        taskId: "task-1",
        totalTokens: 999,
      })
    ).toThrow(BudgetOperationCorruptionError)
  })

  it("throws BudgetAccountNotFoundError if the root account is missing", () => {
    const ledger = { ...createRootBudgetLedger("root-run-1", 1000), accounts: {} }
    expect(() =>
      reserveChildAccount(ledger, {
        operationId: "op-1",
        accountId: "child-1",
        taskId: "task-1",
        totalTokens: 100,
      })
    ).toThrow(BudgetAccountNotFoundError)
  })
})

describe("rootBudgetLedgerStore — durable CAS", () => {
  it("creates and loads a ledger", async () => {
    const store = new RootBudgetLedgerStore(dir)
    await store.create(createRootBudgetLedger("root-run-1", 1000))
    const loaded = await store.load("root-run-1")
    expect(loaded.rootRunId).toBe("root-run-1")
    expect(loaded.revision).toBe(0)
  })

  it("throws RootBudgetLedgerNotFoundError for a missing ledger", async () => {
    const store = new RootBudgetLedgerStore(dir)
    await expect(store.load("nope")).rejects.toThrow(RootBudgetLedgerNotFoundError)
  })

  it("rejects traversal-shaped root run ids", async () => {
    const store = new RootBudgetLedgerStore(dir)
    await expect(store.load("../escape")).rejects.toThrow(InvalidRootRunIdError)
  })

  it("mutates under expectedRevision and bumps the revision by one", async () => {
    const store = new RootBudgetLedgerStore(dir)
    await store.create(createRootBudgetLedger("root-run-1", 1000))
    const mutated = await store.mutate("root-run-1", 0, (ledger) => {
      const { ledger: next } = reserveChildAccount(ledger, {
        operationId: "op-1",
        accountId: "child-1",
        taskId: "task-1",
        totalTokens: 400,
      })
      return next
    })
    expect(mutated.revision).toBe(1)
    expect(mutated.accounts["child-1"]).toBeDefined()
  })

  it("rejects a stale writer and leaves the persisted ledger unchanged", async () => {
    const store = new RootBudgetLedgerStore(dir)
    await store.create(createRootBudgetLedger("root-run-1", 1000))
    await store.mutate("root-run-1", 0, (ledger) => ledger)

    await expect(store.mutate("root-run-1", 0, (ledger) => ledger)).rejects.toThrow(
      StaleLedgerRevisionError
    )
    expect((await store.load("root-run-1")).revision).toBe(1)
  })

  it("does not write a partial ledger when the mutator throws mid-computation", async () => {
    const store = new RootBudgetLedgerStore(dir)
    await store.create(createRootBudgetLedger("root-run-1", 1000))
    await expect(
      store.mutate("root-run-1", 0, () => {
        throw new Error("boom mid-mutation")
      })
    ).rejects.toThrow(/boom mid-mutation/)

    const after = await store.load("root-run-1")
    expect(after.revision).toBe(0) // unchanged
    expect(after.accounts[ROOT_ACCOUNT_ID]?.heldTokens).toBe(0)
  })

  it("serializes two concurrent mutate calls so exactly one succeeds per revision", async () => {
    const store = new RootBudgetLedgerStore(dir)
    await store.create(createRootBudgetLedger("root-run-1", 1000))
    const results = await Promise.allSettled([
      store.mutate("root-run-1", 0, (ledger) => ledger),
      store.mutate("root-run-1", 0, (ledger) => ledger),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleLedgerRevisionError)
  })
})
