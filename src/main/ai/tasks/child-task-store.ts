import type { ChildTaskRecord, ChildTaskStatus } from "./child-task-types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { writeJsonFile } from "../../lan/atomic-json-store"
import { isValidChildTaskRecord, isValidChildTaskStatusTransition } from "./child-task-types"

// The durable store for ChildTaskRecord: <baseDir>/<taskId>/task.json.
// Mirrors agent-run-store.ts's CAS convention (revisioned writes, a
// per-taskId promise-chain mutex, a trust-boundary validator on every read)
// at a much smaller scale — one JSON object per task, no ledgers, no
// message history. Task 27's four tools (start/check/list/cancel) are the
// intended consumers of the read surface here (`get`, `listForConversation`,
// `scan`); ChildTaskScheduler is the only writer.

const SAFE_TASK_ID = /^[\w-]{1,128}$/
const TASK_FILE = "task.json"

function isSafeTaskId(id: string): boolean {
  return SAFE_TASK_ID.test(id)
}

export class InvalidChildTaskIdError extends Error {
  constructor(taskId: string) {
    super(`invalid child task id: ${taskId}`)
    this.name = "InvalidChildTaskIdError"
  }
}

export class ChildTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`child task not found: ${taskId}`)
    this.name = "ChildTaskNotFoundError"
  }
}

export class ChildTaskCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChildTaskCorruptionError"
  }
}

export class StaleChildTaskRevisionError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(`stale child task revision: expected ${expected}, current is ${actual}`)
    this.name = "StaleChildTaskRevisionError"
  }
}

export class IllegalChildTaskStatusTransitionError extends Error {
  constructor(
    taskId: string,
    public readonly from: ChildTaskStatus,
    public readonly to: ChildTaskStatus
  ) {
    super(`child task ${taskId}: illegal status transition ${from} -> ${to}`)
    this.name = "IllegalChildTaskStatusTransitionError"
  }
}

/** A task's owning conversation/origin/root/run identity is a creation-time
 *  commitment — v1 has no ownership handoff, so nothing may ever retarget
 *  it (design §"a task is actionable only from the conversation that owns
 *  it"). Mirrors agent-run-store.ts's ImmutableCheckpointFieldError. */
export class ImmutableChildTaskFieldError extends Error {
  constructor(taskId: string, field: string) {
    super(`child task ${taskId}: immutable field "${field}" was modified`)
    this.name = "ImmutableChildTaskFieldError"
  }
}

export interface ChildTaskScanFilter {
  status?: readonly ChildTaskStatus[]
}

const IMMUTABLE_FIELDS = [
  "taskId",
  "conversationId",
  "originRunId",
  "rootRunId",
  "currentRunId",
  "budgetAccountId",
  "allocationOperationId",
  "createdAt",
] as const

export class ChildTaskStore {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly baseDir: string) {}

  async create(record: ChildTaskRecord): Promise<ChildTaskRecord> {
    return this.withLock(record.taskId, async () => {
      const dir = this.taskDir(record.taskId)
      const existing = await this.readRaw(record.taskId)
      if (existing !== null) throw new Error(`child task already exists: ${record.taskId}`)
      await fs.mkdir(dir, { recursive: true })
      const initial: ChildTaskRecord = { ...record, revision: 1 }
      if (!isValidChildTaskRecord(initial)) {
        throw new ChildTaskCorruptionError(`new child task record ${record.taskId} is malformed`)
      }
      await writeJsonFile(this.taskPath(record.taskId), initial)
      return initial
    })
  }

  async get(taskId: string): Promise<ChildTaskRecord> {
    const raw = await this.readRawOrThrowMissing(taskId)
    if (!isValidChildTaskRecord(raw)) {
      throw new ChildTaskCorruptionError(`child task ${taskId} is malformed`)
    }
    if (raw.taskId !== taskId) {
      throw new ChildTaskCorruptionError(`child task ${taskId} record identity mismatch`)
    }
    return raw
  }

  async mutate(
    taskId: string,
    expectedRevision: number,
    mutator: (record: ChildTaskRecord) => ChildTaskRecord
  ): Promise<ChildTaskRecord> {
    return this.withLock(taskId, async () => {
      const raw = await this.readRawOrThrowMissing(taskId)
      if (!isValidChildTaskRecord(raw) || raw.taskId !== taskId) {
        throw new ChildTaskCorruptionError(`child task ${taskId} is malformed`)
      }
      if (raw.revision !== expectedRevision) {
        throw new StaleChildTaskRevisionError(expectedRevision, raw.revision)
      }
      const mutated = mutator(raw)
      for (const field of IMMUTABLE_FIELDS) {
        if (mutated[field] !== raw[field]) {
          throw new ImmutableChildTaskFieldError(taskId, field)
        }
      }
      if (
        mutated.status !== raw.status &&
        !isValidChildTaskStatusTransition(raw.status, mutated.status)
      ) {
        throw new IllegalChildTaskStatusTransitionError(taskId, raw.status, mutated.status)
      }
      const next: ChildTaskRecord = { ...mutated, revision: expectedRevision + 1 }
      if (!isValidChildTaskRecord(next)) {
        throw new ChildTaskCorruptionError(
          `mutator for child task ${taskId} produced an invalid record`
        )
      }
      await writeJsonFile(this.taskPath(taskId), next)
      return next
    })
  }

  /** Every valid task record, optionally filtered by status. Corrupt/
   *  unreadable entries are silently skipped — unlike AgentRunStore.scan(),
   *  nothing durable depends on surfacing a corrupt child-task record to
   *  recovery (there is no separate child-task recovery review UI in v1). */
  async scan(filter: ChildTaskScanFilter = {}): Promise<ChildTaskRecord[]> {
    let ids: string[]
    try {
      ids = await fs.readdir(this.baseDir)
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    const out: ChildTaskRecord[] = []
    for (const taskId of ids) {
      if (!isSafeTaskId(taskId)) continue
      const raw = await this.readRaw(taskId)
      if (raw === null || !isValidChildTaskRecord(raw) || raw.taskId !== taskId) continue
      if (filter.status && !filter.status.includes(raw.status)) continue
      out.push(raw)
    }
    return out
  }

  async listForConversation(conversationId: string): Promise<ChildTaskRecord[]> {
    const all = await this.scan()
    return all.filter((record) => record.conversationId === conversationId)
  }

  /** Scans for the (at most one) task whose one-and-only run is `runId` —
   *  used by the scheduler to map a resumed checkpoint back to its owning
   *  task without a separate reverse index (point 5's "recomputed by
   *  scanning" guidance applies here too: expected child-task cardinality is
   *  low enough that a full scan is cheap). */
  async findByRunId(runId: string): Promise<ChildTaskRecord | undefined> {
    const all = await this.scan()
    return all.find((record) => record.currentRunId === runId)
  }

  /** Returns `null` for both "missing" and "corrupt JSON" — used by callers
   *  (create/scan) that treat the two the same way. */
  private async readRaw(taskId: string): Promise<unknown | null> {
    if (!isSafeTaskId(taskId)) throw new InvalidChildTaskIdError(taskId)
    try {
      return JSON.parse(await fs.readFile(this.taskPath(taskId), "utf-8")) as unknown
    } catch (err) {
      if (isNotFound(err)) return null
      if (err instanceof SyntaxError) return null
      throw err
    }
  }

  /** Like readRaw, but distinguishes "missing" (throws
   *  ChildTaskNotFoundError) from "corrupt JSON" (returns a value that will
   *  fail isValidChildTaskRecord, so the caller reports
   *  ChildTaskCorruptionError instead of silently treating it as missing). */
  private async readRawOrThrowMissing(taskId: string): Promise<unknown> {
    if (!isSafeTaskId(taskId)) throw new InvalidChildTaskIdError(taskId)
    try {
      return JSON.parse(await fs.readFile(this.taskPath(taskId), "utf-8")) as unknown
    } catch (err) {
      if (isNotFound(err)) throw new ChildTaskNotFoundError(taskId)
      if (err instanceof SyntaxError) return { corrupt: true }
      throw err
    }
  }

  private taskDir(taskId: string): string {
    if (!isSafeTaskId(taskId)) throw new InvalidChildTaskIdError(taskId)
    return path.join(this.baseDir, taskId)
  }

  private taskPath(taskId: string): string {
    return path.join(this.taskDir(taskId), TASK_FILE)
  }

  private withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    if (!isSafeTaskId(taskId)) throw new InvalidChildTaskIdError(taskId)
    const previous = this.locks.get(taskId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.locks.set(
      taskId,
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
