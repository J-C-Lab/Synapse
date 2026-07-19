import type { AgentArtifactRef } from "../artifacts/artifact-types"

// Durable async child-task kernel (design §"Durable async child tasks",
// v1 scope revision 2026-07-18 — see that section's "Scope revision" and
// "Checkpoint E" bullets). v1 fixes a task's owning conversation at
// creation, forever: there is no ownership union, owner epoch, adoption
// lease, or fencing token, and no `update`/run-history. A task has exactly
// one child run for its whole lifetime.
//
// This is deliberately a much smaller type than the full design doc's
// `ChildTaskRecord` (~line 1586 there): no `ownership`, no `authority`
// (the child run's own checkpoint already carries its frozen authority —
// duplicating it here would be a second, driftable copy of the same fact),
// no `allowedTools`/`budget` (same reasoning: the checkpoint is the
// authority for both), and no `runHistory` (v1 never appends a second run).

export type ChildTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export const CHILD_TASK_STATUSES: ReadonlySet<ChildTaskStatus> = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])

/** Mirrors run-types.ts's RUN_STATUS_TRANSITIONS shape for the same reason:
 *  a single table both docs and code (the store's CAS mutate()) stay in
 *  sync against. `queued -> cancelled` is a task cancelled before it ever
 *  received a worker slot; `running -> {succeeded, failed, cancelled}` is
 *  every way its one child run can end. Nothing is ever legal out of a
 *  terminal state — v1 has no update/requeue. */
export const CHILD_TASK_STATUS_TRANSITIONS: Record<ChildTaskStatus, readonly ChildTaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export function isTerminalChildTaskStatus(status: ChildTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled"
}

export function isValidChildTaskStatusTransition(
  from: ChildTaskStatus,
  to: ChildTaskStatus
): boolean {
  if (from === to) return true
  return CHILD_TASK_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * One durably-tracked async child task, owned by `conversationId` from the
 * moment it is created until it reaches a terminal status — never
 * reassigned, never detached, never adopted. `originRunId` is the
 * interactive run whose tool call created the task; `currentRunId` is that
 * task's one and only child run (a `subagent`-origin `AgentRunCheckpointV1`
 * built via `setupSubagentRun`, which already freezes least-privilege tool
 * intersection, workspace binding, and principal lineage — this record
 * never duplicates any of that). `budgetAccountId`/`allocationOperationId`
 * name the finite child-budget-account reservation
 * (`reserveChildAccount`/`root-budget-ledger.ts`) carved for this task's one
 * run; in v1 that is always exactly `currentRunId` /
 * `reserve-subagent:${currentRunId}`, matching today's synchronous subagent
 * convention (see subagent-run-setup.ts's `ensureBudgetAccount`) — kept as
 * named fields rather than re-deriving the string every time so a future
 * release that ever needs a task-stable id distinct from its single run id
 * has somewhere to put it without a schema migration.
 */
export interface ChildTaskRecord {
  schemaVersion: 1
  revision: number
  taskId: string
  conversationId: string
  originRunId: string
  /** The ORIGIN interactive run's own `identity.rootRunId` — the grouping
   *  key ChildTaskScheduler's per-root concurrency cap uses. Deliberately
   *  sourced from the trusted origin checkpoint rather than duplicated from
   *  task input. It also remains the sibling fairness grouping if a future
   *  setup path gives a child a distinct execution root. */
  rootRunId: string
  currentRunId: string
  name: string
  description: string
  status: ChildTaskStatus
  budgetAccountId: string
  allocationOperationId: string
  /** Set only once, when status first becomes "succeeded" — a `child-result`
   *  artifact capturing the child's final assistant text. Absent for
   *  "failed"/"cancelled" tasks (nothing trustworthy to hand back) and for
   *  every non-terminal status. */
  resultArtifact?: AgentArtifactRef
  /** A successfully generated result captured before the child run releases
   *  its artifact pin during finalization. It is promoted atomically to
   *  `resultArtifact` once the checkpoint is terminal. This short-lived
   *  durable reference closes the finalization/GC crash window without
   *  retaining any other child-run artifacts. */
  pendingResultArtifact?: AgentArtifactRef
  createdAt: number
  updatedAt: number
}

const TASK_ID_PATTERN = /^[\w-]{1,128}$/
const RUN_ID_PATTERN = /^[\w-]{1,128}$/
const ARTIFACT_ID_PATTERN = /^[\w-]{1,128}$/
const ARTIFACT_SHA256_PATTERN = /^[a-f0-9]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  )
}

function isValidArtifactRef(v: unknown): v is AgentArtifactRef {
  if (!isRecord(v)) return false
  if (typeof v.runId !== "string" || !RUN_ID_PATTERN.test(v.runId)) return false
  if (typeof v.artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(v.artifactId)) return false
  if (v.uri !== `artifact://run/${v.runId}/${v.artifactId}`) return false
  if (v.kind !== "child-result") return false
  if (typeof v.mediaType !== "string" || v.mediaType.length === 0) return false
  if (!isNonNegativeInteger(v.capturedBytes)) return false
  if (typeof v.complete !== "boolean") return false
  if (typeof v.sha256 !== "string" || !ARTIFACT_SHA256_PATTERN.test(v.sha256)) return false
  if (!isNonNegativeInteger(v.createdAt)) return false
  return true
}

/** Trust-boundary validator for a record read back off disk, mirroring
 *  checkpoint-schema.ts's `validateCheckpoint` convention: a corrupted or
 *  hand-edited field is never coerced with a default. */
export function isValidChildTaskRecord(value: unknown): value is ChildTaskRecord {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== 1) return false
  if (!isNonNegativeInteger(value.revision)) return false
  if (!isNonEmptyString(value.taskId) || !TASK_ID_PATTERN.test(value.taskId)) return false
  if (!isNonEmptyString(value.conversationId)) return false
  if (!isNonEmptyString(value.originRunId)) return false
  if (!isNonEmptyString(value.rootRunId)) return false
  if (!isNonEmptyString(value.currentRunId) || !RUN_ID_PATTERN.test(value.currentRunId))
    return false
  if (typeof value.name !== "string") return false
  if (typeof value.description !== "string") return false
  if (
    typeof value.status !== "string" ||
    !CHILD_TASK_STATUSES.has(value.status as ChildTaskStatus)
  ) {
    return false
  }
  if (!isNonEmptyString(value.budgetAccountId)) return false
  if (!isNonEmptyString(value.allocationOperationId)) return false
  if (value.resultArtifact !== undefined && !isValidArtifactRef(value.resultArtifact)) return false
  if (
    value.pendingResultArtifact !== undefined &&
    !isValidArtifactRef(value.pendingResultArtifact)
  ) {
    return false
  }
  if (value.resultArtifact !== undefined && value.pendingResultArtifact !== undefined) return false
  if (value.status !== "succeeded" && value.resultArtifact !== undefined) return false
  if (value.status !== "running" && value.pendingResultArtifact !== undefined) return false
  if (!isNonNegativeInteger(value.createdAt) || !isNonNegativeInteger(value.updatedAt)) return false
  return true
}
