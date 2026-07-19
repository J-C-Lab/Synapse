import type {
  AgentArtifactRefSummary,
  AgentRunEvent,
  AgentRunSnapshot,
  AgentRunSummary,
} from "@synapse/agent-protocol"
import type { ToolPrincipal } from "@synapse/plugin-sdk"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type {
  AgentArtifactStore,
  ArtifactCaller,
  ArtifactReadErrorCode,
} from "../ai/artifacts/artifact-types"
import type { PlanStep, PlanStepStatus } from "../ai/plan/plan-types"
import type { RunTrace, RunTraceErrorCategory } from "../ai/run-trace-store"
import type {
  AgentRunRecoveryService,
  RecoveryDecision,
} from "../ai/runs/agent-run-recovery-service"
import type { AgentRunStore } from "../ai/runs/agent-run-store"
import type { RunEventStore } from "../ai/runs/run-event-store"
import type { ChildTaskScheduler } from "../ai/tasks/child-task-scheduler"
import type { ChildTaskStore } from "../ai/tasks/child-task-store"
import {
  decodeForModel,
  MAX_ARTIFACT_READ_BYTES,
  parseArtifactUri,
} from "../ai/artifacts/artifact-tool-source"
import { ArtifactReadError } from "../ai/artifacts/artifact-types"
import { toArtifactSummary } from "../ai/artifacts/tool-result-capture"
import { getRunTrace, listRuns } from "../ai/run-trace-store"
import {
  ConversationConflictUnresumableError,
  RecoveryBlockedError,
  RecoveryDecisionRequiredError,
} from "../ai/runs/agent-run-recovery-service"
import { RunNotFoundError } from "../ai/runs/agent-run-store"
import { toAgentRunSnapshot } from "../ai/runs/run-projection"
import { requireString } from "./validation"

const RECOVERY_DECISION_KINDS = new Set<string>(["retry", "mark_failed"])

const ORIGINS = new Set<string>(["interactive", "background-agent", "subagent", "mcp"])
const OUTCOMES = new Set<string>(["end_turn", "max_steps", "aborted", "budget_exceeded", "error"])
const ERROR_CATEGORIES = new Set<string>(["denied", "tool-error", "aborted", "exception"])
const PLAN_STATUSES = new Set<string>(["pending", "in_progress", "completed"])
const PLAN_TITLE_MAX_CHARS = 500

export type RendererRunTraceError = RunTraceErrorCategory | "legacy-error"

export interface RendererToolCall {
  name: string
  startedAt: number
  ms: number
  ok: boolean
  error?: RendererRunTraceError
}

export interface RendererRunTrace {
  runId: string
  origin: RunTrace["origin"]
  outcome: RunTrace["outcome"]
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  workspaceId?: string
  triggerInstanceId?: string
  principal?: ToolPrincipal
  startedAt: number
  endedAt: number
  toolCalls: RendererToolCall[]
  plan?: PlanStep[]
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function normalizeToolCall(value: unknown): RendererToolCall | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (
    typeof v.name !== "string" ||
    typeof v.startedAt !== "number" ||
    typeof v.ms !== "number" ||
    typeof v.ok !== "boolean"
  ) {
    return undefined
  }
  const rawError = optionalString(v.error)
  const error: RendererRunTraceError | undefined =
    rawError === undefined
      ? undefined
      : ERROR_CATEGORIES.has(rawError)
        ? (rawError as RunTraceErrorCategory)
        : "legacy-error"
  return {
    name: v.name,
    startedAt: v.startedAt,
    ms: v.ms,
    ok: v.ok,
    ...(error !== undefined ? { error } : {}),
  }
}

function normalizePlanStep(value: unknown): PlanStep | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.title !== "string" || typeof v.status !== "string" || !PLAN_STATUSES.has(v.status)) {
    return undefined
  }
  return { title: v.title.slice(0, PLAN_TITLE_MAX_CHARS), status: v.status as PlanStepStatus }
}

/** Validates and reconstructs a value read off disk into a renderer-safe
 *  shape, field by field — never `{ ...value }`. Returns undefined for a
 *  structurally invalid record; callers skip it rather than failing an
 *  entire list. */
export function normalizeRunTraceForRenderer(value: unknown): RendererRunTrace | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.runId !== "string") return undefined
  if (typeof v.origin !== "string" || !ORIGINS.has(v.origin)) return undefined
  if (typeof v.outcome !== "string" || !OUTCOMES.has(v.outcome)) return undefined
  if (typeof v.startedAt !== "number" || typeof v.endedAt !== "number") return undefined

  const toolCalls = Array.isArray(v.toolCalls)
    ? v.toolCalls.map(normalizeToolCall).filter((c): c is RendererToolCall => c !== undefined)
    : []
  const planRaw = Array.isArray(v.plan)
    ? v.plan.map(normalizePlanStep).filter((s): s is PlanStep => s !== undefined)
    : undefined

  return {
    runId: v.runId,
    origin: v.origin as RunTrace["origin"],
    outcome: v.outcome as RunTrace["outcome"],
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    conversationId: optionalString(v.conversationId),
    invocationId: optionalString(v.invocationId),
    parentRunId: optionalString(v.parentRunId),
    workspaceId: optionalString(v.workspaceId),
    triggerInstanceId: optionalString(v.triggerInstanceId),
    principal: v.principal as ToolPrincipal | undefined,
    toolCalls,
    ...(planRaw && planRaw.length > 0 ? { plan: planRaw } : {}),
  }
}

export interface RunSummary {
  runId: string
  origin: RunTrace["origin"]
  outcome: RunTrace["outcome"]
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  workspaceId?: string
  triggerInstanceId?: string
  principal?: ToolPrincipal
  startedAt: number
  endedAt: number
  toolCallCount: number
  failedToolCallCount: number
  hasPlan: boolean
}

export function toRunSummary(trace: RendererRunTrace): RunSummary {
  return {
    runId: trace.runId,
    origin: trace.origin,
    outcome: trace.outcome,
    conversationId: trace.conversationId,
    invocationId: trace.invocationId,
    parentRunId: trace.parentRunId,
    workspaceId: trace.workspaceId,
    triggerInstanceId: trace.triggerInstanceId,
    principal: trace.principal,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    toolCallCount: trace.toolCalls.length,
    failedToolCallCount: trace.toolCalls.filter((c) => !c.ok).length,
    hasPlan: Boolean(trace.plan && trace.plan.length > 0),
  }
}

export interface RunListQuery {
  parentRunId?: string
}

export function normalizeRunListQuery(input: unknown): RunListQuery {
  if (input === undefined) return {}
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("payload must be an object")
  }
  const v = input as Record<string, unknown>
  const keys = Object.keys(v)
  if (keys.length === 0) return {}
  if (keys.some((key) => key !== "parentRunId")) {
    throw new Error("unexpected field in payload")
  }
  const parentRunId = requireString(v.parentRunId, "parentRunId").trim()
  if (!parentRunId) throw new Error("parentRunId must be a non-empty string")
  if (parentRunId.length > 200) throw new Error("parentRunId is too long")
  return { parentRunId }
}

export interface EventsSinceQuery {
  runId: string
  afterSequence: number
}

export function normalizeEventsSinceQuery(input: unknown): EventsSinceQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("payload must be an object")
  }
  const v = input as Record<string, unknown>
  const runId = requireString(v.runId, "runId")
  if (
    typeof v.afterSequence !== "number" ||
    !Number.isInteger(v.afterSequence) ||
    v.afterSequence < 0
  ) {
    throw new Error("afterSequence must be a non-negative integer")
  }
  return { runId, afterSequence: v.afterSequence }
}

export interface ResumeRunQuery {
  runId: string
  decision?: RecoveryDecision
}

function normalizeRecoveryDecision(value: unknown): RecoveryDecision | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("decision must be an object")
  }
  const v = value as Record<string, unknown>
  if (typeof v.kind !== "string" || !RECOVERY_DECISION_KINDS.has(v.kind)) {
    throw new Error('decision.kind must be "retry" or "mark_failed"')
  }
  return { kind: v.kind } as RecoveryDecision
}

export function normalizeResumeQuery(input: unknown): ResumeRunQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("payload must be an object")
  }
  const v = input as Record<string, unknown>
  return {
    runId: requireString(v.runId, "runId"),
    decision: normalizeRecoveryDecision(v.decision),
  }
}

/** Mirrors the plain-promise (no ok/error envelope) convention every other
 *  AI/runs endpoint already uses (see src/renderer/src/lib/electron.ts) —
 *  except resume, whose failure modes are meaningful, typed outcomes a
 *  recovery UI needs to branch on (blocked vs. needs-a-decision vs.
 *  conversation-conflict), not exceptional — so this is the one endpoint
 *  that returns a discriminated result instead of throwing across IPC. */
export type ResumeRunResult =
  | { ok: true }
  | { ok: false; reason: "blocked"; blockedReason: string }
  | { ok: false; reason: "decision_required"; reviewReason: string }
  | { ok: false; reason: "conversation_conflict_unresumable" }

export interface RunsDurableDeps {
  runStore: AgentRunStore
  eventStore: RunEventStore
  recovery: AgentRunRecoveryService
  /** Fire-and-forget: actually drives the run's durable loop forward after a
   *  successful resume — `recovery.resume()` itself only flips the status
   *  field back to "running". Errors are the continuator's own
   *  responsibility to log; the IPC response must never wait on a full turn
   *  completing. Optional so callers that haven't wired origin-aware
   *  continuation yet keep the pre-existing status-flip-only behavior. */
  continueRun?: (runId: string) => void
  /** Recoverable artifact backend (Checkpoint B). Backs the artifact
   *  status/preview endpoints and the manual retention-sweep endpoint below
   *  (Task 21). Omitted in tests that don't exercise artifacts — those three
   *  channels simply aren't registered. */
  artifactStore?: AgentArtifactStore
  /** Durable conversation-owned child-task records. Snapshot projection only
   * exposes tasks created by the requested parent run; ownership remains on
   * the host side and the renderer receives the protocol's bounded summary. */
  childTaskStore?: ChildTaskStore
  /** Queued child tasks may only be resumed through this bounded scheduler;
   *  the generic `continueRun` path is safe for running children but would
   *  otherwise bypass per-root/global admission. */
  childTaskScheduler?: Pick<ChildTaskScheduler, "admitQueuedRunForResume">
}

// ---------------------------------------------------------------------------
// Artifact status / bounded preview (Task 21) — no precedent to extend: this
// is the first IPC surface that lets the renderer ask about an
// `artifact://...` uri at all. Mirrors artifact-tool-source.ts's
// `read_artifact` tool exactly (same uri grammar, same per-call byte cap) so
// the two access paths (model vs. renderer/human) never disagree about what
// "a bounded read" means. Every rejection is the same closed
// `ArtifactReadErrorCode` union `read_artifact` already surfaces — renderer
// cards branch on `status: "unavailable"` + `code`, never on a thrown IPC
// error, so a stale/expired/forbidden reference degrades into an explicit,
// stable UI state instead of an unhandled rejection.

export type ArtifactStatusResult =
  | { status: "available"; summary: AgentArtifactRefSummary }
  | { status: "unavailable"; code: ArtifactReadErrorCode }

export interface ArtifactPreviewRange {
  start?: number
  end?: number
}

export type ArtifactPreviewResult =
  | {
      status: "available"
      content: string
      encoding: "utf-8" | "base64"
      range: { start: number; end: number }
      rangeClamped: boolean
    }
  | { status: "unavailable"; code: ArtifactReadErrorCode }

/** The IPC layer is host-privileged and single-tenant (one local desktop
 *  user): every artifact reachable from `getConversation`/`getRunSnapshot`
 *  is already fully visible to this same renderer. Rather than duplicating
 *  a second access policy here, the caller context is built to match the
 *  artifact's own owning run — the same trivial "same run" branch
 *  `checkArtifactAccess` already grants in artifact-access.ts — so this
 *  never needs (or gets) any capability `read_artifact`'s real per-run
 *  caller context doesn't also effectively have from inside that run. */
function rendererCallerFor(runId: string): ArtifactCaller {
  return { runId, rootRunId: runId, principal: { kind: "local-user" } }
}

export function normalizeArtifactUri(input: unknown): string {
  return requireString(input, "uri")
}

export function normalizeArtifactPreviewQuery(input: unknown): {
  uri: string
  range?: ArtifactPreviewRange
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("payload must be an object")
  }
  const v = input as Record<string, unknown>
  const uri = requireString(v.uri, "uri")
  if (v.range === undefined) return { uri }
  if (!v.range || typeof v.range !== "object" || Array.isArray(v.range)) {
    throw new Error("range must be an object")
  }
  const r = v.range as Record<string, unknown>
  const start = r.start === undefined ? undefined : r.start
  const end = r.end === undefined ? undefined : r.end
  if (start !== undefined && (typeof start !== "number" || !Number.isInteger(start) || start < 0)) {
    throw new Error("range.start must be a non-negative integer")
  }
  if (end !== undefined && (typeof end !== "number" || !Number.isInteger(end) || end < 0)) {
    throw new Error("range.end must be a non-negative integer")
  }
  return { uri, range: { start: start as number | undefined, end: end as number | undefined } }
}

export async function getArtifactStatus(
  store: AgentArtifactStore,
  uri: string
): Promise<ArtifactStatusResult> {
  const parsed = parseArtifactUri(uri)
  if (!parsed) return { status: "unavailable", code: "artifact_missing" }
  try {
    const ref = await store.resolve(
      parsed.runId,
      parsed.artifactId,
      rendererCallerFor(parsed.runId)
    )
    return { status: "available", summary: toArtifactSummary(ref) }
  } catch (err) {
    if (err instanceof ArtifactReadError) return { status: "unavailable", code: err.code }
    throw err
  }
}

export async function readArtifactPreview(
  store: AgentArtifactStore,
  uri: string,
  range?: ArtifactPreviewRange
): Promise<ArtifactPreviewResult> {
  const parsed = parseArtifactUri(uri)
  if (!parsed) return { status: "unavailable", code: "artifact_missing" }
  try {
    const caller = rendererCallerFor(parsed.runId)
    const ref = await store.resolve(parsed.runId, parsed.artifactId, caller)
    const start = range?.start ?? 0
    const requestedEnd = range?.end ?? Math.min(ref.capturedBytes, start + MAX_ARTIFACT_READ_BYTES)
    const cappedEnd = Math.min(requestedEnd, ref.capturedBytes, start + MAX_ARTIFACT_READ_BYTES)
    const bytes = await store.read(ref, { start, end: cappedEnd }, caller)
    const decoded = decodeForModel(bytes, ref.mediaType)
    return {
      status: "available",
      content: decoded.content,
      encoding: decoded.encoding,
      range: { start, end: cappedEnd },
      rangeClamped: cappedEnd < requestedEnd,
    }
  } catch (err) {
    if (err instanceof ArtifactReadError) return { status: "unavailable", code: err.code }
    throw err
  }
}

export interface RegisterRunsIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerRunsIpc(
  ipcMain: IpcMain,
  runsDir: string,
  durable: RunsDurableDeps,
  options: RegisterRunsIpcOptions
): void {
  const guard = (event: IpcMainInvokeEvent): void => {
    if (options.isTrustedSender(event)) return
    throw new Error("Untrusted IPC sender.")
  }

  ipcMain.handle("runs:list", (event, payload: unknown) => {
    guard(event)
    const query = normalizeRunListQuery(payload)
    const traces = listRuns(
      runsDir,
      query.parentRunId !== undefined ? { parentRunId: query.parentRunId } : { limit: 500 }
    )
    const summaries: RunSummary[] = []
    for (const trace of traces) {
      const normalized = normalizeRunTraceForRenderer(trace)
      if (normalized) summaries.push(toRunSummary(normalized))
    }
    return summaries
  })

  ipcMain.handle("runs:get", (event, runId: unknown) => {
    guard(event)
    const trace = getRunTrace(runsDir, requireString(runId, "runId"))
    return trace ? normalizeRunTraceForRenderer(trace) : undefined
  })

  ipcMain.handle(
    "runs:getSnapshot",
    async (event, runId: unknown): Promise<AgentRunSnapshot | undefined> => {
      guard(event)
      const id = requireString(runId, "runId")
      let result: Awaited<ReturnType<typeof durable.runStore.load>>
      try {
        result = await durable.runStore.load(id)
      } catch (err) {
        if (err instanceof RunNotFoundError) return undefined
        throw err
      }
      if (!result.ok) return undefined
      const events = await durable.eventStore.readAll(id)
      const lastSequence = events.length > 0 ? events[events.length - 1]!.sequence : 0
      const conversationId = result.checkpoint.identity.conversationId
      const childTasks =
        durable.childTaskStore && conversationId
          ? (await durable.childTaskStore.listForConversation(conversationId)).filter(
              (task) => task.originRunId === result.checkpoint.identity.runId
            )
          : []
      return toAgentRunSnapshot(result.checkpoint, lastSequence, childTasks)
    }
  )

  ipcMain.handle(
    "runs:getEventsSince",
    async (event, payload: unknown): Promise<AgentRunEvent[]> => {
      guard(event)
      const query = normalizeEventsSinceQuery(payload)
      return durable.eventStore.readAfter(query.runId, query.afterSequence)
    }
  )

  ipcMain.handle("runs:listRecoverable", async (event): Promise<AgentRunSummary[]> => {
    guard(event)
    return durable.recovery.listRecoverable()
  })

  ipcMain.handle("runs:resume", async (event, payload: unknown): Promise<ResumeRunResult> => {
    guard(event)
    const query = normalizeResumeQuery(payload)
    try {
      const childTask = await durable.childTaskStore?.findByRunId(query.runId)
      await durable.recovery.resume(query.runId, query.decision)
      if (childTask?.status === "queued") {
        if (!durable.childTaskScheduler) {
          throw new Error("queued child task resume requires ChildTaskScheduler")
        }
        // recovery.resume() restores/reclassifies the durable checkpoint,
        // but only the scheduler may claim a concurrency slot and actually
        // dispatch a queued child. If a concurrent admission changed it to
        // running already, that admission owns the continuation instead.
        await durable.childTaskScheduler.admitQueuedRunForResume(query.runId)
        return { ok: true }
      }
      durable.continueRun?.(query.runId)
      return { ok: true }
    } catch (err) {
      if (err instanceof RecoveryBlockedError) {
        return { ok: false, reason: "blocked", blockedReason: err.reason }
      }
      if (err instanceof RecoveryDecisionRequiredError) {
        return { ok: false, reason: "decision_required", reviewReason: err.reason }
      }
      if (err instanceof ConversationConflictUnresumableError) {
        return { ok: false, reason: "conversation_conflict_unresumable" }
      }
      throw err
    }
  })

  ipcMain.handle("runs:abandon", async (event, runId: unknown): Promise<void> => {
    guard(event)
    await durable.recovery.abandon(requireString(runId, "runId"))
  })

  // Artifact status/preview/retention channels are only registered when an
  // artifact store is actually wired — omitting them entirely (rather than
  // registering a handler that always fails) matches every other optional
  // dependency's pattern in this file (continueRun above).
  if (durable.artifactStore) {
    const artifactStore = durable.artifactStore

    ipcMain.handle(
      "runs:getArtifactStatus",
      async (event, payload: unknown): Promise<ArtifactStatusResult> => {
        guard(event)
        return getArtifactStatus(artifactStore, normalizeArtifactUri(payload))
      }
    )

    ipcMain.handle(
      "runs:readArtifactPreview",
      async (event, payload: unknown): Promise<ArtifactPreviewResult> => {
        guard(event)
        const query = normalizeArtifactPreviewQuery(payload)
        return readArtifactPreview(artifactStore, query.uri, query.range)
      }
    )

    // Manual maintenance trigger (Task 21) — no automatic scheduling exists
    // anywhere in this codebase for any store (see this task's design-
    // decision note); a renderer-triggered sweep is the minimum viable way
    // to expose real retention deletion without inventing new scheduling
    // infrastructure. A future scheduled-task system can call
    // artifactStore.collectEligible() directly instead of through IPC.
    //
    // This channel is fully wired end-to-end (main + preload + renderer
    // wrapper) but deliberately has no call site anywhere in the renderer UI
    // yet — no button, menu item, or scheduler invokes it — mirroring how
    // Task 20 shipped context compression fully wired but dormant
    // (`enabled: false`) pending a later task turning it on. Wiring an
    // automatic/UI trigger is intentionally deferred, not an oversight.
    ipcMain.handle("runs:collectArtifactGarbage", async (event) => {
      guard(event)
      return artifactStore.collectEligible()
    })
  }
}
