import type { AgentRunStatus } from "@synapse/agent-protocol"
import type { AgentRunCheckpointV1, CheckpointValidationResult } from "./checkpoint-schema"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { isTerminalRunStatus } from "@synapse/agent-protocol"
import { writeJsonFile } from "../../lan/atomic-json-store"
import { validateCheckpoint } from "./checkpoint-schema"

// The authoritative recovery store: <baseDir>/<runId>/checkpoint.json
// (design §"Durable checkpoint store"). Every mutation requires the caller's
// `expectedRevision`; a stale writer gets a typed conflict and never writes.
// Mutations are additionally serialized per run through a promise-chain
// mutex, since expectedRevision alone can't stop two truly concurrent
// writers from both reading the same revision before either writes.

const SAFE_RUN_ID = /^[\w-]{1,128}$/
const CHECKPOINT_FILE = "checkpoint.json"

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
      await writeJsonFile(this.checkpointPath(runId), initial)
      return initial
    })
  }

  async load(runId: string): Promise<CheckpointValidationResult> {
    const raw = await readCheckpointRaw(this.checkpointPath(runId))
    if (raw.kind === "missing") throw new RunNotFoundError(runId)
    if (raw.kind === "corrupt") return { ok: false, reason: "malformed" }
    return validateCheckpoint(raw.value)
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
      const next: AgentRunCheckpointV1 = { ...mutated, revision: expectedRevision + 1 }
      await writeJsonFile(this.checkpointPath(runId), next)
      return next
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

      if (result.ok) {
        if (filter.status && !filter.status.includes(result.checkpoint.status)) continue
        if (filter.nonTerminalOnly && isTerminalRunStatus(result.checkpoint.status)) continue
        if (
          filter.incompleteFinalizationOnly &&
          (!result.checkpoint.finalization || result.checkpoint.finalization.phase === "complete")
        ) {
          continue
        }
      }
      out.push({ runId, result })
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
