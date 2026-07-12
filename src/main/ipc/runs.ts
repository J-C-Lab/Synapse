import type { ToolPrincipal } from "@synapse/plugin-sdk"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { PlanStep, PlanStepStatus } from "../ai/plan/plan-types"
import type { RunTrace, RunTraceErrorCategory } from "../ai/run-trace-store"
import { getRunTrace, listRuns } from "../ai/run-trace-store"
import { requireString } from "./validation"

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

export interface RegisterRunsIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerRunsIpc(
  ipcMain: IpcMain,
  runsDir: string,
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
}
