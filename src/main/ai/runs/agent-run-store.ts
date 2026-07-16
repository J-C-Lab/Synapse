import type { AgentRunStatus } from "@synapse/agent-protocol"
import type { CanonicalJson } from "./canonical-json"
import type { AgentRunCheckpointV1, CheckpointValidationResult } from "./checkpoint-schema"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { isTerminalRunStatus } from "@synapse/agent-protocol"
import { writeJsonFile } from "../../lan/atomic-json-store"
import { canonicalHash } from "./canonical-json"
import { validateCheckpoint } from "./checkpoint-schema"
import { RUN_STATUS_TRANSITIONS } from "./run-types"

// The authoritative recovery store: <baseDir>/<runId>/checkpoint.json
// (design §"Durable checkpoint store"). Every mutation requires the caller's
// `expectedRevision`; a stale writer gets a typed conflict and never writes.
// Mutations are additionally serialized per run through a promise-chain
// mutex, since expectedRevision alone can't stop two truly concurrent
// writers from both reading the same revision before either writes.

const SAFE_RUN_ID = /^[\w-]{1,128}$/
const CHECKPOINT_FILE = "checkpoint.json"
const ABANDONED_DIR = ".abandoned"

function isSafeRunId(id: string): boolean {
  return SAFE_RUN_ID.test(id)
}

export class InvalidRunIdError extends Error {
  constructor(runId: string) {
    super(`invalid run id: ${runId}`)
    this.name = "InvalidRunIdError"
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run not found: ${runId}`)
    this.name = "RunNotFoundError"
  }
}

export class StaleRevisionError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(`stale revision: expected ${expected}, current is ${actual}`)
    this.name = "StaleRevisionError"
  }
}

export class CheckpointCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CheckpointCorruptionError"
  }
}

export class IllegalStatusTransitionError extends Error {
  constructor(
    runId: string,
    public readonly from: AgentRunStatus,
    public readonly to: AgentRunStatus
  ) {
    super(`run ${runId}: illegal status transition ${from} -> ${to}`)
    this.name = "IllegalStatusTransitionError"
  }
}

/** Identity and frozen configuration are creation-time commitments. A
 * revision mutator may advance ledgers and status, but can never retarget a
 * run or smuggle broader authority/context into an existing checkpoint. */
export class ImmutableCheckpointFieldError extends Error {
  constructor(runId: string, field: "identity" | "config") {
    super(`run ${runId}: immutable checkpoint ${field} was modified`)
    this.name = "ImmutableCheckpointFieldError"
  }
}

export interface RunScanEntry {
  runId: string
  result: CheckpointValidationResult
}

export interface RunScanFilter {
  status?: readonly AgentRunStatus[]
  /** Only checkpoints whose status is not terminal. Blocked/corrupt entries
   *  always pass, since recovery must see them too. */
  nonTerminalOnly?: boolean
  /** Only checkpoints with a finalization ledger whose phase isn't
   *  "complete". Blocked/corrupt entries always pass. */
  incompleteFinalizationOnly?: boolean
}

type RawRead = { kind: "missing" } | { kind: "corrupt" } | { kind: "ok"; value: unknown }

export class AgentRunStore {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly baseDir: string) {}

  async create(checkpoint: AgentRunCheckpointV1): Promise<AgentRunCheckpointV1> {
    const runId = checkpoint.identity.runId
    return this.withLock(runId, async () => {
      const dir = this.runDir(runId)
      const existing = await readCheckpointRaw(this.checkpointPath(runId))
      if (existing.kind !== "missing") {
        throw new Error(`run already exists: ${runId}`)
      }
      await fs.mkdir(dir, { recursive: true })
      const initial: AgentRunCheckpointV1 = { ...checkpoint, revision: 1 }
      const validated = validateCheckpoint(initial)
      if (!validated.ok) {
        throw new CheckpointCorruptionError(
          `new checkpoint for run ${runId} is ${validated.reason}`
        )
      }
      await writeJsonFile(this.checkpointPath(runId), initial)
      return validated.checkpoint
    })
  }

  async load(runId: string): Promise<CheckpointValidationResult> {
    const raw = await readCheckpointRaw(this.checkpointPath(runId))
    if (raw.kind === "missing") throw new RunNotFoundError(runId)
    if (raw.kind === "corrupt") return { ok: false, reason: "malformed" }
    const validated = validateCheckpoint(raw.value)
    if (validated.ok && validated.checkpoint.identity.runId !== runId) {
      return { ok: false, reason: "malformed" }
    }
    return validated
  }

  /**
   * Performs the narrowly-scoped v1 background execution migration. Early
   * v1 checkpoints predate the runtime debit ledger and absolute deadline;
   * changing either through normal mutate() is intentionally forbidden as
   * frozen config. This audited migration is the one exception: it derives a
   * conservative debit from already-recorded requested calls and preserves
   * the original timeout as createdAt + timeoutMs.
   */
  async migrateLegacyBackgroundExecution(
    runId: string,
    expectedRevision: number
  ): Promise<AgentRunCheckpointV1> {
    return this.withLock(runId, async () => {
      const raw = await readCheckpointRaw(this.checkpointPath(runId))
      if (raw.kind === "missing") throw new RunNotFoundError(runId)
      if (raw.kind === "corrupt") {
        throw new CheckpointCorruptionError(`checkpoint for run ${runId} is corrupt JSON`)
      }
      const validated = validateCheckpoint(raw.value)
      if (!validated.ok) {
        throw new CheckpointCorruptionError(`checkpoint for run ${runId} is ${validated.reason}`)
      }
      const current = validated.checkpoint
      if (current.revision !== expectedRevision) {
        throw new StaleRevisionError(expectedRevision, current.revision)
      }
      if (current.identity.origin !== "background-agent" || !current.config.backgroundExecution) {
        return current
      }
      const execution = current.config.backgroundExecution
      const needsLedger = current.backgroundExecutionLedger === undefined
      const needsDeadline = current.config.deadlineAt === undefined
      if (!needsLedger && !needsDeadline) return current

      const toolCallsConsumed = Math.min(
        execution.maxToolCallsPerRun,
        current.toolBatches.reduce((total, batch) => total + batch.calls.length, 0)
      )
      const deadlineAt = safeDeadline(current.createdAt, execution.timeoutMs)
      const migrated: AgentRunCheckpointV1 = {
        ...current,
        config: needsDeadline ? { ...current.config, deadlineAt } : current.config,
        backgroundExecutionLedger: current.backgroundExecutionLedger ?? { toolCallsConsumed },
        updatedAt: Math.max(current.updatedAt, current.createdAt),
        revision: expectedRevision + 1,
      }
      const revalidated = validateCheckpoint(migrated)
      if (!revalidated.ok) {
        throw new CheckpointCorruptionError(
          `legacy background migration for run ${runId} produced ${revalidated.reason}`
        )
      }
      await writeJsonFile(this.checkpointPath(runId), migrated)
      return revalidated.checkpoint
    })
  }

  /** Isolates, rather than deletes, an explicitly abandoned malformed or
   * unsupported checkpoint. The evidence is retained with a tombstone for
   * diagnosis, while callers reconcile external run-scoped resources before
   * invoking this operation. */
  async discard(runId: string): Promise<void> {
    if (!isSafeRunId(runId)) throw new InvalidRunIdError(runId)
    await this.withLock(runId, async () => {
      const source = this.runDir(runId)
      try {
        await fs.access(source)
      } catch (err) {
        if (isNotFound(err)) return
        throw err
      }
      const evidenceDir = path.join(this.baseDir, ABANDONED_DIR, `${runId}-${Date.now()}`)
      await fs.mkdir(path.dirname(evidenceDir), { recursive: true })
      await fs.rename(source, evidenceDir)
      await writeJsonFile(path.join(evidenceDir, "abandonment.json"), {
        schemaVersion: 1,
        runId,
        abandonedAt: Date.now(),
        reason: "checkpoint-unreadable",
      })
    })
  }

  async mutate(
    runId: string,
    expectedRevision: number,
    mutator: (checkpoint: AgentRunCheckpointV1) => AgentRunCheckpointV1
  ): Promise<AgentRunCheckpointV1> {
    return this.withLock(runId, async () => {
      const raw = await readCheckpointRaw(this.checkpointPath(runId))
      if (raw.kind === "missing") throw new RunNotFoundError(runId)
      if (raw.kind === "corrupt") {
        throw new CheckpointCorruptionError(`checkpoint for run ${runId} is corrupt JSON`)
      }
      const validated = validateCheckpoint(raw.value)
      if (!validated.ok) {
        throw new CheckpointCorruptionError(`checkpoint for run ${runId} is ${validated.reason}`)
      }
      if (validated.checkpoint.revision !== expectedRevision) {
        throw new StaleRevisionError(expectedRevision, validated.checkpoint.revision)
      }
      const mutated = mutator(validated.checkpoint)
      if (
        canonicalHash(mutated.identity as unknown as CanonicalJson) !==
        canonicalHash(validated.checkpoint.identity as unknown as CanonicalJson)
      ) {
        throw new ImmutableCheckpointFieldError(runId, "identity")
      }
      if (
        canonicalHash(mutated.config as unknown as CanonicalJson) !==
        canonicalHash(validated.checkpoint.config as unknown as CanonicalJson)
      ) {
        throw new ImmutableCheckpointFieldError(runId, "config")
      }
      // The base transition table only — never the extra ctx-gated
      // preconditions (hasRecoveryDecision, childOwnershipResolved,
      // finalizationPhase), which mutate() has no way to know and which
      // callers that actually drive a transition (agent-run-recovery-
      // service.ts, run-finalizer.ts) already check with full context
      // before ever calling mutate(). This is a structural safety net
      // underneath that: no mutator, however it got here, can silently
      // persist a status jump the state machine itself never allows (e.g.
      // "waiting_approval" straight to "completed", skipping
      // "terminalizing").
      if (
        mutated.status !== validated.checkpoint.status &&
        !RUN_STATUS_TRANSITIONS[validated.checkpoint.status].includes(mutated.status)
      ) {
        throw new IllegalStatusTransitionError(runId, validated.checkpoint.status, mutated.status)
      }
      const next: AgentRunCheckpointV1 = { ...mutated, revision: expectedRevision + 1 }
      const revalidated = validateCheckpoint(next)
      if (!revalidated.ok) {
        throw new CheckpointCorruptionError(
          `mutator for run ${runId} produced an invalid checkpoint: ${revalidated.reason}`
        )
      }
      await writeJsonFile(this.checkpointPath(runId), next)
      return revalidated.checkpoint
    })
  }

  /** Every run's checkpoint, validated — never loads events.jsonl. Blocked or
   *  corrupt entries are always included regardless of filter; only "ok"
   *  entries are filtered, since recovery must still see the others. */
  async scan(filter: RunScanFilter = {}): Promise<RunScanEntry[]> {
    let ids: string[]
    try {
      ids = await fs.readdir(this.baseDir)
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }

    const out: RunScanEntry[] = []
    for (const runId of ids) {
      if (!isSafeRunId(runId)) continue
      const raw = await readCheckpointRaw(this.checkpointPath(runId))
      if (raw.kind === "missing") continue
      const result: CheckpointValidationResult =
        raw.kind === "corrupt" ? { ok: false, reason: "malformed" } : validateCheckpoint(raw.value)

      const identityMatchesDirectory = result.ok && result.checkpoint.identity.runId === runId

      if (result.ok && identityMatchesDirectory) {
        if (filter.status && !filter.status.includes(result.checkpoint.status)) continue
        if (filter.nonTerminalOnly && isTerminalRunStatus(result.checkpoint.status)) continue
        if (
          filter.incompleteFinalizationOnly &&
          (!result.checkpoint.finalization || result.checkpoint.finalization.phase === "complete")
        ) {
          continue
        }
      }
      out.push({
        runId,
        result: identityMatchesDirectory ? result : { ok: false, reason: "malformed" },
      })
    }
    return out
  }

  private runDir(runId: string): string {
    if (!isSafeRunId(runId)) throw new InvalidRunIdError(runId)
    return path.join(this.baseDir, runId)
  }

  private checkpointPath(runId: string): string {
    return path.join(this.runDir(runId), CHECKPOINT_FILE)
  }

  private withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    // Validate before ever touching the lock map keyed by the raw id.
    if (!isSafeRunId(runId)) throw new InvalidRunIdError(runId)
    const previous = this.locks.get(runId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.locks.set(
      runId,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }
}

async function readCheckpointRaw(filePath: string): Promise<RawRead> {
  let text: string
  try {
    text = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    if (isNotFound(err)) return { kind: "missing" }
    throw err
  }
  try {
    return { kind: "ok", value: JSON.parse(text) }
  } catch {
    return { kind: "corrupt" }
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}

function safeDeadline(createdAt: number, timeoutMs: number): number {
  const deadline = createdAt + timeoutMs
  return Number.isSafeInteger(deadline) ? deadline : Number.MAX_SAFE_INTEGER
}
