import type { PlanStep } from "./plan/plan-types"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { logger } from "../logging"

// A per-run summary index. It does NOT duplicate tool arguments/results or
// message text — those live in ConversationStore (full history) and audit.log
// (redacted capability decisions). RunTrace is the thread that ties a run's
// tool calls and capability decisions together, keyed by runId. Written with
// synchronous, best-effort fs calls (matching logging/file-sink.ts): a disk
// error must never fail the agent turn.

export interface RunTraceToolCall {
  /** Fully-qualified tool name as seen by AiToolRegistry. */
  name: string
  startedAt: number
  ms: number
  ok: boolean
  /** Short category only ("denied" | error.message) — never a payload. */
  error?: string
}

export interface RunTrace {
  runId: string
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  origin: "interactive" | "background-agent" | "subagent"
  startedAt: number
  endedAt: number
  outcome: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
  toolCalls: RunTraceToolCall[]
  /** The agent's final declared plan for this run, if update_plan was called. */
  plan?: PlanStep[]
}

/** Cap on retained per-run files; oldest beyond this are pruned after each write. */
export const MAX_RUN_FILES = 500

// runId becomes a filename, so the store validates it defensively rather than
// trusting callers. Real ids are UUIDs; anything with a path separator, `..`,
// or other filename-hostile chars is refused so a bogus id can never escape the
// runs dir. This is a store-level invariant, independent of who calls it.
const SAFE_RUN_ID = /^[\w.-]+$/

function isSafeRunId(runId: string): boolean {
  return runId !== "." && runId !== ".." && !runId.includes("..") && SAFE_RUN_ID.test(runId)
}

export function recordRun(dir: string, trace: RunTrace): void {
  if (!isSafeRunId(trace.runId)) {
    logger.child("run-trace").warn("refusing unsafe runId for trace file", { runId: trace.runId })
    return
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${trace.runId}.json`), `${JSON.stringify(trace)}\n`)
    prune(dir)
  } catch (err) {
    logger.child("run-trace").warn("failed to record run trace", { runId: trace.runId, err })
  }
}

export function getRunTrace(dir: string, runId: string): RunTrace | undefined {
  if (!isSafeRunId(runId)) return undefined
  const file = path.join(dir, `${runId}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunTrace
  } catch {
    return undefined
  }
}

export function listRuns(
  dir: string,
  opts: { conversationId?: string; parentRunId?: string; limit?: number } = {}
): RunTrace[] {
  let traces = readAll(dir)
  if (opts.conversationId !== undefined) {
    traces = traces.filter((t) => t.conversationId === opts.conversationId)
  }
  if (opts.parentRunId !== undefined) {
    traces = traces.filter((t) => t.parentRunId === opts.parentRunId)
  }
  traces.sort((a, b) => b.startedAt - a.startedAt)
  return opts.limit !== undefined ? traces.slice(0, opts.limit) : traces
}

function readAll(dir: string): RunTrace[] {
  if (!existsSync(dir)) return []
  const out: RunTrace[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, name), "utf8")) as RunTrace)
    } catch {
      // Skip a corrupt/partial file rather than failing the whole listing.
    }
  }
  return out
}

function prune(dir: string): void {
  const traces = readAll(dir)
  if (traces.length <= MAX_RUN_FILES) return
  traces.sort((a, b) => a.startedAt - b.startedAt) // oldest first
  for (const stale of traces.slice(0, traces.length - MAX_RUN_FILES)) {
    rmSync(path.join(dir, `${stale.runId}.json`), { force: true })
  }
}
