import type { CanonicalJson } from "../runs/canonical-json"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { writeJsonFile } from "../../lan/atomic-json-store"
import { canonicalHash } from "../runs/canonical-json"

// Durable per-root-run budget ledger (design §"Durable async child tasks" /
// root budget ledger). Every admit/settle/forfeit/release is a checkpointed,
// idempotent operation against a revisioned ledger, not a number held only
// in main-process memory.

export const ROOT_ACCOUNT_ID = "root"

export interface RootBudgetAccount {
  kind: "root" | "child-task"
  taskId?: string
  /** undefined = unlimited. */
  totalTokens?: number
  heldTokens: number
  consumedTokens: number
  /** Root-only: tokens carved out for child-task accounts (already excluded
   *  from the root's own free balance). Always 0 on a child account. */
  reservedTokens: number
}

export interface BudgetOperationReceipt {
  operationId: string
  kind: "reserve" | "admit" | "settle" | "forfeit" | "release"
  accountId: string
  attemptId?: string
  payloadHash: string
  heldTokens?: number
  consumedTokens?: number
  releasedTokens?: number
  appliedAtRevision: number
}

export interface RootBudgetLedgerV1 {
  schemaVersion: 1
  rootRunId: string
  revision: number
  accounts: Record<string, RootBudgetAccount>
  operations: Record<string, BudgetOperationReceipt>
}

export class InsufficientBudgetError extends Error {}
export class BudgetOperationCorruptionError extends Error {}
export class BudgetAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`budget account not found: ${accountId}`)
    this.name = "BudgetAccountNotFoundError"
  }
}
export class BudgetOverReleaseError extends Error {}

export function createRootBudgetLedger(
  rootRunId: string,
  totalTokens: number | undefined
): RootBudgetLedgerV1 {
  return {
    schemaVersion: 1,
    rootRunId,
    revision: 0,
    accounts: {
      [ROOT_ACCOUNT_ID]: {
        kind: "root",
        totalTokens,
        heldTokens: 0,
        consumedTokens: 0,
        reservedTokens: 0,
      },
    },
    operations: {},
  }
}

/** undefined = unlimited. Never negative in a correctly-used ledger. */
export function freeBalance(account: RootBudgetAccount): number | undefined {
  if (account.totalTokens === undefined) return undefined
  return account.totalTokens - account.heldTokens - account.consumedTokens - account.reservedTokens
}

export function getAccountOrThrow(
  ledger: RootBudgetLedgerV1,
  accountId: string
): RootBudgetAccount {
  const account = ledger.accounts[accountId]
  if (!account) throw new BudgetAccountNotFoundError(accountId)
  return account
}

/**
 * Shared idempotency gate every ledger-mutating operation goes through:
 * a replay under the same operationId with an identical payload is a
 * harmless no-op; a replay with a different payload is corruption.
 */
export function checkOperationIdempotency(
  ledger: RootBudgetLedgerV1,
  operationId: string,
  payload: unknown
): { replay: true; receipt: BudgetOperationReceipt } | { replay: false; payloadHash: string } {
  const payloadHash = canonicalHash(payload as unknown as CanonicalJson)
  const existing = ledger.operations[operationId]
  if (!existing) return { replay: false, payloadHash }
  if (existing.payloadHash !== payloadHash) {
    throw new BudgetOperationCorruptionError(
      `budget operation ${operationId} replayed with a different payload`
    )
  }
  return { replay: true, receipt: existing }
}

export interface ReserveChildAccountInput {
  operationId: string
  accountId: string
  taskId: string
  totalTokens: number
}

/**
 * Carves a finite child-task account out of the root. If the root is
 * finite, the reservation is checked against (and deducted from) its free
 * balance immediately; if the root is unlimited, the reservation is pure
 * bookkeeping and can never be blocked.
 */
export function reserveChildAccount(
  ledger: RootBudgetLedgerV1,
  input: ReserveChildAccountInput
): { ledger: RootBudgetLedgerV1; receipt: BudgetOperationReceipt } {
  const idempotency = checkOperationIdempotency(ledger, input.operationId, input)
  if (idempotency.replay) return { ledger, receipt: idempotency.receipt }

  if (ledger.accounts[input.accountId]) {
    throw new Error(`budget account already exists: ${input.accountId}`)
  }
  const root = getAccountOrThrow(ledger, ROOT_ACCOUNT_ID)
  const rootFree = freeBalance(root)
  if (rootFree !== undefined && input.totalTokens > rootFree) {
    throw new InsufficientBudgetError(
      `cannot reserve ${input.totalTokens} tokens for ${input.accountId}: only ${rootFree} free on root`
    )
  }

  const receipt: BudgetOperationReceipt = {
    operationId: input.operationId,
    kind: "reserve",
    accountId: input.accountId,
    payloadHash: idempotency.payloadHash,
    heldTokens: input.totalTokens,
    appliedAtRevision: ledger.revision + 1,
  }
  const nextLedger: RootBudgetLedgerV1 = {
    ...ledger,
    accounts: {
      ...ledger.accounts,
      [ROOT_ACCOUNT_ID]: { ...root, reservedTokens: root.reservedTokens + input.totalTokens },
      [input.accountId]: {
        kind: "child-task",
        taskId: input.taskId,
        totalTokens: input.totalTokens,
        heldTokens: 0,
        consumedTokens: 0,
        reservedTokens: 0,
      },
    },
    operations: { ...ledger.operations, [input.operationId]: receipt },
  }
  return { ledger: nextLedger, receipt }
}

/**
 * Reconciles a child account whose checkpoint can no longer be trusted. The
 * parent root had reserved the child's entire cap; return its unused portion
 * while conservatively charging both recorded consumption and any unresolved
 * hold. This is deliberately run-id based so corrupt checkpoint bytes never
 * need to be deserialized to release the reservation.
 */
export function reconcileAbandonedChildAccount(
  ledger: RootBudgetLedgerV1,
  input: { operationId: string; runId: string }
): { ledger: RootBudgetLedgerV1; reconciled: boolean } {
  const child = ledger.accounts[input.runId]
  if (!child || child.kind !== "child-task" || child.taskId !== input.runId) {
    return { ledger, reconciled: false }
  }
  const idempotency = checkOperationIdempotency(ledger, input.operationId, input)
  if (idempotency.replay) return { ledger, reconciled: true }

  const root = getAccountOrThrow(ledger, ROOT_ACCOUNT_ID)
  const reserved = child.totalTokens ?? 0
  if (reserved > root.reservedTokens) {
    throw new BudgetOverReleaseError(
      `cannot reconcile child ${input.runId}: ${reserved} reserved but root has ${root.reservedTokens}`
    )
  }
  const conservativelyConsumed = child.consumedTokens + child.heldTokens
  const { [input.runId]: _removed, ...remainingAccounts } = ledger.accounts
  const receipt: BudgetOperationReceipt = {
    operationId: input.operationId,
    kind: "release",
    accountId: input.runId,
    payloadHash: idempotency.payloadHash,
    consumedTokens: conservativelyConsumed,
    releasedTokens: Math.max(0, reserved - conservativelyConsumed),
    appliedAtRevision: ledger.revision + 1,
  }
  return {
    reconciled: true,
    ledger: {
      ...ledger,
      accounts: {
        ...remainingAccounts,
        [ROOT_ACCOUNT_ID]: {
          ...root,
          reservedTokens: root.reservedTokens - reserved,
          consumedTokens: root.consumedTokens + conservativelyConsumed,
        },
      },
      operations: { ...ledger.operations, [input.operationId]: receipt },
    },
  }
}

// ---------------------------------------------------------------------------
// Durable CAS store: <baseDir>/<rootRunId>/budget.json

const SAFE_ROOT_RUN_ID = /^[\w-]{1,128}$/
const LEDGER_FILE = "budget.json"

function isSafeRootRunId(id: string): boolean {
  return SAFE_ROOT_RUN_ID.test(id)
}

export class InvalidRootRunIdError extends Error {
  constructor(rootRunId: string) {
    super(`invalid root run id: ${rootRunId}`)
    this.name = "InvalidRootRunIdError"
  }
}

export class RootBudgetLedgerNotFoundError extends Error {
  constructor(rootRunId: string) {
    super(`root budget ledger not found: ${rootRunId}`)
    this.name = "RootBudgetLedgerNotFoundError"
  }
}

export class StaleLedgerRevisionError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(`stale ledger revision: expected ${expected}, current is ${actual}`)
    this.name = "StaleLedgerRevisionError"
  }
}

export class RootBudgetLedgerStore {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly baseDir: string) {}

  async create(ledger: RootBudgetLedgerV1): Promise<RootBudgetLedgerV1> {
    return this.withLock(ledger.rootRunId, async () => {
      const dir = this.runDir(ledger.rootRunId)
      const existing = await this.readRaw(ledger.rootRunId)
      if (existing !== null)
        throw new Error(`root budget ledger already exists: ${ledger.rootRunId}`)
      await fs.mkdir(dir, { recursive: true })
      await writeJsonFile(this.ledgerPath(ledger.rootRunId), ledger)
      return ledger
    })
  }

  async load(rootRunId: string): Promise<RootBudgetLedgerV1> {
    const raw = await this.readRaw(rootRunId)
    if (raw === null) throw new RootBudgetLedgerNotFoundError(rootRunId)
    return raw as RootBudgetLedgerV1
  }

  async mutate(
    rootRunId: string,
    expectedRevision: number,
    mutator: (ledger: RootBudgetLedgerV1) => RootBudgetLedgerV1
  ): Promise<RootBudgetLedgerV1> {
    return this.withLock(rootRunId, async () => {
      const raw = await this.readRaw(rootRunId)
      if (raw === null) throw new RootBudgetLedgerNotFoundError(rootRunId)
      const current = raw as RootBudgetLedgerV1
      if (current.revision !== expectedRevision) {
        throw new StaleLedgerRevisionError(expectedRevision, current.revision)
      }
      const mutated = mutator(current)
      const next: RootBudgetLedgerV1 = { ...mutated, revision: expectedRevision + 1 }
      await writeJsonFile(this.ledgerPath(rootRunId), next)
      return next
    })
  }

  /** Finds any parent root ledger that reserved a child account for this run
   * and releases it through the conservative reconciliation above. Safe to
   * call repeatedly during corrupt-run abandonment. */
  async reconcileAbandonedRun(runId: string): Promise<void> {
    if (!isSafeRootRunId(runId)) throw new InvalidRootRunIdError(runId)
    let rootIds: string[]
    try {
      rootIds = await fs.readdir(this.baseDir)
    } catch (err) {
      if (isNotFound(err)) return
      throw err
    }
    for (const rootRunId of rootIds.filter(isSafeRootRunId)) {
      for (;;) {
        let ledger: RootBudgetLedgerV1
        try {
          ledger = await this.load(rootRunId)
        } catch (err) {
          if (err instanceof RootBudgetLedgerNotFoundError) break
          throw err
        }
        const reconciled = reconcileAbandonedChildAccount(ledger, {
          operationId: `abandon-corrupt-child:${runId}`,
          runId,
        })
        if (!reconciled.reconciled) break
        try {
          await this.mutate(rootRunId, ledger.revision, () => reconciled.ledger)
          break
        } catch (err) {
          if (!(err instanceof StaleLedgerRevisionError)) throw err
        }
      }
    }
  }

  private async readRaw(rootRunId: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(this.ledgerPath(rootRunId), "utf-8")) as unknown
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  private runDir(rootRunId: string): string {
    if (!isSafeRootRunId(rootRunId)) throw new InvalidRootRunIdError(rootRunId)
    return path.join(this.baseDir, rootRunId)
  }

  private ledgerPath(rootRunId: string): string {
    return path.join(this.runDir(rootRunId), LEDGER_FILE)
  }

  private withLock<T>(rootRunId: string, fn: () => Promise<T>): Promise<T> {
    if (!isSafeRootRunId(rootRunId)) throw new InvalidRootRunIdError(rootRunId)
    const previous = this.locks.get(rootRunId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.locks.set(
      rootRunId,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
