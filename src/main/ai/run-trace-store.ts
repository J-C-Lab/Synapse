import type { ToolPrincipal } from "@synapse/plugin-sdk"
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

export type RunTraceErrorCategory = "denied" | "tool-error" | "aborted" | "exception"

export interface RunTraceToolCall {
  /** Fully-qualified tool name as seen by AiToolRegistry. */
  name: string
  startedAt: number
  ms: number
  ok: boolean
  /** Closed set — never a payload. See RunTraceErrorCategory. */
  error?: RunTraceErrorCategory
}

export interface RunTrace {
  runId: string
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  origin: "interactive" | "background-agent" | "subagent" | "mcp"
  principal?: ToolPrincipal
  workspaceId?: string
  triggerInstanceId?: string
  startedAt: number
  endedAt: number
  outcome: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
  toolCalls: RunTraceToolCall[]
  /** The agent's final declared plan for this run, if update_plan was called. */
  plan?: PlanStep[]
}

/** Cap on retained per-run files; oldest beyond this are pruned after each write. */
export const MAX_RUN_FILES = 500

/** The one place the runs directory path is computed — used by both the
 *  existing AgentService wiring and the new runs IPC registration, so
 *  they can never drift apart. */
export function runTraceDir(userDataDir: string): string {
  return path.join(userDataDir, "logs", "runs")
}

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
    return unwrap(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return undefined
  }
}

// --- strict, idempotent terminal-finalization upsert -----------------------
// recordRun above stays a best-effort, unconditional overwrite for every
// non-terminal caller (background/subagent runs not yet migrated onto the
// durable finalizer). upsertRunTrace is the terminal-finalization path
// (design §"Terminal finalization across stores" step 3): identical retries
// (same finalizationId + traceHash) return the already-stored revision;
// the same finalizationId with a different hash is corruption, never
// silently overwritten. The on-disk envelope wraps the plain RunTrace so
// getRunTrace/listRuns keep reading old plain-RunTrace files exactly as
// before (unwrap() below falls back to treating the whole payload as a
// legacy RunTrace when it isn't a recognized envelope).

export interface TraceUpsertInput {
  runId: string
  finalizationId: string
  traceHash: string
  trace: RunTrace
}

export interface TraceUpsertReceipt {
  revision: number
}

export class TraceUpsertCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TraceUpsertCorruptionError"
  }
}

interface TraceEnvelope {
  envelopeVersion: 1
  finalizationId: string
  traceHash: string
  revision: number
  trace: RunTrace
}

function isTraceEnvelope(value: unknown): value is TraceEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { envelopeVersion?: unknown }).envelopeVersion === 1 &&
    typeof (value as { finalizationId?: unknown }).finalizationId === "string" &&
    typeof (value as { trace?: unknown }).trace === "object"
  )
}

/** Unwraps a v1 envelope to its trace; anything else is treated as a legacy
 *  plain RunTrace payload, preserved unchanged. */
function unwrap(value: unknown): RunTrace {
  return isTraceEnvelope(value) ? value.trace : (value as RunTrace)
}

export function upsertRunTrace(dir: string, input: TraceUpsertInput): TraceUpsertReceipt {
  if (!isSafeRunId(input.runId)) {
    throw new Error(`refusing unsafe runId for trace upsert: ${input.runId}`)
  }
  const file = path.join(dir, `${input.runId}.json`)
  const existing = readEnvelope(file)

  if (existing && existing.finalizationId === input.finalizationId) {
    if (existing.traceHash !== input.traceHash) {
      throw new TraceUpsertCorruptionError(
        `trace upsert for run ${input.runId}, finalization ${input.finalizationId}: ` +
          `stored hash ${existing.traceHash} does not match ${input.traceHash}`
      )
    }
    return { revision: existing.revision }
  }

  const revision = (existing?.revision ?? 0) + 1
  const envelope: TraceEnvelope = {
    envelopeVersion: 1,
    finalizationId: input.finalizationId,
    traceHash: input.traceHash,
    revision,
    trace: input.trace,
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `${JSON.stringify(envelope)}\n`)
  prune(dir)
  return { revision }
}

function readEnvelope(file: string): TraceEnvelope | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return isTraceEnvelope(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export interface RunListFilter {
  conversationId?: string
  parentRunId?: string
  origin?: RunTrace["origin"]
  outcome?: RunTrace["outcome"]
  workspaceId?: string
  triggerInstanceId?: string
  limit?: number
}

export function listRuns(dir: string, opts: RunListFilter = {}): RunTrace[] {
  let traces = readAll(dir)
  if (opts.conversationId !== undefined) {
    traces = traces.filter((t) => t.conversationId === opts.conversationId)
  }
  if (opts.parentRunId !== undefined) {
    traces = traces.filter((t) => t.parentRunId === opts.parentRunId)
  }
  if (opts.origin !== undefined) {
    traces = traces.filter((t) => t.origin === opts.origin)
  }
  if (opts.outcome !== undefined) {
    traces = traces.filter((t) => t.outcome === opts.outcome)
  }
  if (opts.workspaceId !== undefined) {
    traces = traces.filter((t) => t.workspaceId === opts.workspaceId)
  }
  if (opts.triggerInstanceId !== undefined) {
    traces = traces.filter((t) => t.triggerInstanceId === opts.triggerInstanceId)
  }
  traces.sort((a, b) => b.startedAt - a.startedAt)
  return opts.limit !== undefined ? traces.slice(0, opts.limit) : traces
}

/**
 * The most recent non-empty plan recorded for a conversation, so reselecting
 * it (or reopening the app) can restore the Progress card instead of it only
 * ever existing for the lifetime of the live run that produced it.
 */
export function getLatestPlan(dir: string, conversationId: string): PlanStep[] | undefined {
  for (const trace of listRuns(dir, { conversationId })) {
    if (trace.plan && trace.plan.length > 0) return trace.plan
  }
  return undefined
}

function readAll(dir: string): RunTrace[] {
  if (!existsSync(dir)) return []
  const out: RunTrace[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    try {
      out.push(unwrap(JSON.parse(readFileSync(path.join(dir, name), "utf8"))))
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
