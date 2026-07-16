import type { AgentRunEvent } from "@synapse/agent-protocol"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { isAgentRunEvent } from "@synapse/agent-protocol"

// Append-only, sequence-numbered replay/diagnostic projection —
// <baseDir>/<runId>/events.jsonl (design §"Durable checkpoint store"). NOT
// recovery authority: a missing or truncated final line may lose an
// observation but must never change what the checkpoint decides. Callers
// append an event only after the corresponding checkpoint mutation commits.

const SAFE_RUN_ID = /^[\w-]{1,128}$/
const EVENTS_FILE = "events.jsonl"

function isSafeRunId(id: string): boolean {
  return SAFE_RUN_ID.test(id)
}

export class InvalidRunIdError extends Error {
  constructor(runId: string) {
    super(`invalid run id: ${runId}`)
    this.name = "InvalidRunIdError"
  }
}

export class RunEventStore {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly baseDir: string) {}

  /** Appends one event. Rejects (without writing) if `event.sequence` does
   *  not strictly exceed the run's last durable sequence. */
  async append(runId: string, event: AgentRunEvent): Promise<void> {
    await this.withLock(runId, async () => {
      if (!isAgentRunEvent(event) || event.runId !== runId || !event.persisted) {
        throw new Error(`invalid persisted event for run ${runId}`)
      }
      const events = await this.readAllUnlocked(runId)
      const last = events.length > 0 ? events[events.length - 1]!.sequence : 0
      if (event.sequence <= last) {
        throw new Error(
          `event sequence must strictly increase for run ${runId}: got ${event.sequence}, last was ${last}`
        )
      }
      const dir = this.runDir(runId)
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(this.eventsPath(runId), `${JSON.stringify(event)}\n`, "utf-8")
    })
  }

  /** Every durably readable event for a run, in file order. Tolerates only
   *  an unterminated, corrupt final line (the crash-mid-append case); a
   *  newline-terminated malformed record is durable corruption and throws. */
  async readAll(runId: string): Promise<AgentRunEvent[]> {
    return this.readAllUnlocked(runId)
  }

  async readAfter(runId: string, afterSequence: number): Promise<AgentRunEvent[]> {
    return (await this.readAllUnlocked(runId)).filter((event) => event.sequence > afterSequence)
  }

  private async readAllUnlocked(runId: string): Promise<AgentRunEvent[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.eventsPath(runId), "utf-8")
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    const terminated = raw.endsWith("\n")
    const lines = raw.split("\n")
    if (terminated) lines.pop()
    const events: AgentRunEvent[] = []
    for (const [index, line] of lines.entries()) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isAgentRunEvent(parsed) || parsed.runId !== runId || !parsed.persisted) {
          throw new Error("invalid event shape")
        }
        const last = events[events.length - 1]
        if (last && parsed.sequence <= last.sequence) {
          throw new Error("non-monotonic event sequence")
        }
        events.push(parsed)
      } catch {
        if (!terminated && index === lines.length - 1) break // crash-mid-append
        throw new Error(`corrupt event journal line ${index} for run ${runId}`)
      }
    }
    return events
  }

  private runDir(runId: string): string {
    if (!isSafeRunId(runId)) throw new InvalidRunIdError(runId)
    return path.join(this.baseDir, runId)
  }

  private eventsPath(runId: string): string {
    return path.join(this.runDir(runId), EVENTS_FILE)
  }

  private withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
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

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
