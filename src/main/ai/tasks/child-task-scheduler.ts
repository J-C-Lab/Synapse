import type { AgentRunEvent } from "@synapse/agent-protocol"
import type { AgentArtifactRef, AgentArtifactStore } from "../artifacts/artifact-types"
import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { EstimatorQuarantineStore } from "../estimator-quarantine-store"
import type { ChatMessage, ChatProvider } from "../providers/types"
import type { RunTrace, TraceUpsertInput, TraceUpsertReceipt } from "../run-trace-store"
import type { AgentRunStore } from "../runs/agent-run-store"
import type { AgentRunCheckpointV1 } from "../runs/checkpoint-schema"
import type { RunEventStore } from "../runs/run-event-store"
import type { GenericRunContinuationDeps } from "../runs/run-recovery-orchestrator"
import type { SkillPackageLeaseStore } from "../skills/skill-package-leases"
import type { AiToolRegistry, ToolHostPort } from "../tool-registry"
import type { ChildTaskStore } from "./child-task-store"
import type { ChildTaskRecord, ChildTaskStatus } from "./child-task-types"
import { randomUUID } from "node:crypto"
import { isTerminalRunStatus } from "@synapse/agent-protocol"
import { toChatMessages } from "../runs/durable-messages"
import { continueBackgroundOrSubagentRun } from "../runs/run-recovery-orchestrator"
import { setupSubagentRun } from "../runs/subagent-run-setup"
import {
  IllegalChildTaskStatusTransitionError,
  StaleChildTaskRevisionError,
} from "./child-task-store"
import { isTerminalChildTaskStatus } from "./child-task-types"

// Bounded-concurrency dispatch and lifecycle wiring for durable async child
// tasks (design §"Durable async child tasks", v1 scope revision). Reuses
// the existing synchronous subagent path unchanged for setup
// (setupSubagentRun — least-privilege tool intersection, workspace binding,
// budget reservation, principal lineage all frozen exactly as they are
// today) and the existing generic recovery driver
// (continueBackgroundOrSubagentRun — already resumes any interrupted
// `origin: "subagent"` checkpoint to completion) as the ONE mechanism that
// actually drives a child's model/tool loop, whether that drive is a fresh
// dispatch, a startup-recovery resume of a task that was already `running`,
// or a forced cancellation. There is no separate "detached execution"
// runner: continueBackgroundOrSubagentRun already works unchanged on a
// freshly-created, zero-step checkpoint (see run-recovery-orchestrator.
// test.ts), so it is both the fresh-dispatch path and the resume path.
//
// Checkpoint-level vs scheduler-level recovery split (see the task's own
// design notes for the long version): a task's checkpoint is created
// eagerly, at `start()` time, regardless of whether a concurrency slot is
// free — this is what lets setupSubagentRun freeze authority/budget
// atomically, exactly as it does for today's synchronous subagent path, and
// is why `ChildTaskRecord` needs no separate replay spec (instruction,
// provider, tool list, ...) of its own: the checkpoint is that spec. A
// `queued` task's checkpoint therefore already exists but has never been
// driven — nothing else will ever drive it, so `recoverAtStartup()` must.
// A `running` task's checkpoint was already being driven before a crash;
// the existing generic autoResumeRecoverableRuns/continueAnyRun startup
// scan (index.ts) already resumes every non-terminal automatic-recovery
// `origin: "subagent"` checkpoint unconditionally — so recoverAtStartup()
// only needs to recompute this scheduler's own in-process slot bookkeeping
// for those (never re-dispatch them itself), so a *live* start() call made
// shortly after restart correctly queues behind whatever is already active
// rather than double-admitting past the cap.

export interface ChildTaskSchedulerLimits {
  /** At most this many active (status "running") tasks per root run. */
  maxActivePerRoot: number
  /** At most this many active tasks across every root run combined. */
  maxActiveGlobal: number
}

export const DEFAULT_CHILD_TASK_LIMITS: ChildTaskSchedulerLimits = {
  maxActivePerRoot: 3,
  maxActiveGlobal: 6,
}

export interface StartChildTaskInput {
  /** The interactive run whose tool call is creating this task. Must have
   *  an active conversation — checked against the live checkpoint, not
   *  trusted from the caller, before anything else happens. */
  originRunId: string
  name: string
  description: string
  instruction: string
  /** Already narrowed to the least-privilege subset this task may use —
   *  same contract as SubagentRunInput.tools (SpawnSubagentToolSource
   *  computes this intersection today; a future host-tool source for
   *  `start_subagent_task` does the same before calling start()). */
  tools: AiToolRegistry
  providerId: string
  model: string
  maxOutputTokens: number
  maxSteps: number
}

export interface ChildTaskSchedulerDeps {
  store: ChildTaskStore
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  eventStore: RunEventStore
  upsertTrace: (input: TraceUpsertInput) => TraceUpsertReceipt
  recordRun?: (trace: RunTrace) => void
  /** The live global tool host (unnarrowed) — continueBackgroundOrSubagentRun
   *  narrows it down to exactly each checkpoint's frozen authority fqNames
   *  itself, the same way it already does for every resumed background/
   *  subagent run today. */
  tools: ToolHostPort
  buildProvider: (providerId: string) => Promise<ChatProvider>
  now?: () => number
  newId?: () => string
  artifactStore?: AgentArtifactStore
  skillPackageLeases?: SkillPackageLeaseStore
  estimatorQuarantine?: EstimatorQuarantineStore
  onEvent?: (event: AgentRunEvent) => void
  /** Best-effort diagnostic hook for a dispatch that threw a genuine setup
   *  failure (missing credential, corrupt checkpoint) — continueBackground
   *  OrSubagentRun never throws for a normal terminal/suspended outcome, so
   *  this is never the "happy path". Never rethrown: a broken dispatch must
   *  free its slot and let the queue keep moving, not wedge the scheduler. */
  onDispatchError?: (taskId: string, err: unknown) => void
  limits?: Partial<ChildTaskSchedulerLimits>
}

interface PendingEntry {
  taskId: string
  rootRunId: string
}

export class ChildTaskScheduler {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly limits: ChildTaskSchedulerLimits
  private globalActive = 0
  private readonly perRootActive = new Map<string, number>()
  private readonly pendingQueue: PendingEntry[] = []
  /** runId -> the controller currently driving it, whether the drive was
   *  started by this scheduler's own dispatch() or registered externally
   *  (index.ts registers one for every generic background/subagent
   *  continuation too, so cancel() can reach a task even if it is being
   *  resumed by the startup recovery scan rather than this scheduler). */
  private readonly liveControllers = new Map<string, AbortController>()

  constructor(private readonly deps: ChildTaskSchedulerDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    this.limits = { ...DEFAULT_CHILD_TASK_LIMITS, ...deps.limits }
  }

  get store(): ChildTaskStore {
    return this.deps.store
  }

  /** Creates a new child task and, if a concurrency slot is immediately
   *  free, dispatches it without waiting for completion — the returned
   *  promise resolves as soon as the task is durably recorded, never once
   *  its child run finishes. Throws (before persisting anything) if the
   *  origin run has no conversation, or if a finite budget account cannot
   *  be reserved (setupSubagentRun's own InsufficientBudgetError path) —
   *  both are fail-closed: no checkpoint, no ChildTaskRecord, no reserved
   *  tokens survive a rejected start(). */
  async start(input: StartChildTaskInput): Promise<{ taskId: string }> {
    const origin = await this.deps.runStore.load(input.originRunId)
    if (!origin.ok) {
      throw new Error(
        `cannot start child task: origin run ${input.originRunId} checkpoint is ${origin.reason}`
      )
    }
    if (
      origin.checkpoint.identity.origin !== "interactive" ||
      !origin.checkpoint.identity.conversationId
    ) {
      throw new Error(
        "child tasks can only be started from an interactive run with an active conversation"
      )
    }

    const taskId = this.newId()
    const currentRunId = this.newId()
    const checkpoint = await setupSubagentRun(
      {
        runStore: this.deps.runStore,
        budgetStore: this.deps.budgetStore,
        tools: input.tools,
        now: this.now,
      },
      {
        runId: currentRunId,
        parentRunId: input.originRunId,
        instruction: input.instruction,
        providerId: input.providerId,
        model: input.model,
        maxOutputTokens: input.maxOutputTokens,
        maxSteps: input.maxSteps,
      }
    )

    const createdAt = this.now()
    const record: ChildTaskRecord = {
      schemaVersion: 1,
      revision: 0,
      taskId,
      conversationId: checkpoint.identity.conversationId!,
      originRunId: input.originRunId,
      rootRunId: checkpoint.identity.rootRunId,
      currentRunId,
      name: input.name,
      description: input.description,
      status: "queued",
      budgetAccountId: currentRunId,
      allocationOperationId: `reserve-subagent:${currentRunId}`,
      createdAt,
      updatedAt: createdAt,
    }
    await this.deps.store.create(record)
    this.tryAdmitOrEnqueue(taskId, record.rootRunId)
    return { taskId }
  }

  /** Cancels a task from either "queued" or "running". The cancellation
   *  decision is written durably FIRST — before any abort signal goes out —
   *  so it is never lost to a crash between the two, and is visible/
   *  consistent after a restart even if nothing in this process ever gets a
   *  chance to actually abort a live driver. Idempotent: cancelling an
   *  already-terminal task is a no-op. */
  async cancel(taskId: string): Promise<void> {
    const record = await this.markCancelledIfPossible(taskId)
    if (record.status !== "cancelled") return // already succeeded/failed by the time we tried

    if (this.abortIfLive(record.currentRunId)) return // a live driver (ours or the generic path) will finalize it

    this.removeFromPendingQueue(taskId)
    const loaded = await this.deps.runStore.load(record.currentRunId)
    if (!loaded.ok) return
    if (isTerminalRunStatus(loaded.checkpoint.status)) return
    // Never dispatched (queued backlog, possibly across a restart) and
    // nothing is currently driving it — drive it once, ourselves, with an
    // already-aborted signal so it finalizes to "cancelled" on its very
    // first loop check (interactive-run-driver.ts's `if (signal?.aborted)`
    // branch) without taking a single real model/tool step. Deliberately
    // does not occupy a concurrency slot: this is cleanup of a decision
    // already made, not new admission.
    await this.dispatch(record, loaded.checkpoint, { preAbort: true })
  }

  /** Called once at startup, after the generic autoResumeRecoverableRuns
   *  scan has been wired to resume every non-terminal checkpoint (including
   *  this scheduler's `running` child tasks) — see this file's top-of-file
   *  note for the full checkpoint-level/scheduler-level split. Rebuilds
   *  in-process slot bookkeeping from durable ChildTaskRecord status (never
   *  its own separate ledger) and dispatches the `queued` backlog — the one
   *  bucket nothing else will ever drive — respecting the same cap a live
   *  start() would. */
  async recoverAtStartup(): Promise<void> {
    const nonTerminal = await this.deps.store.scan({ status: ["queued", "running"] })
    const running = nonTerminal.filter((record) => record.status === "running")
    const queued = nonTerminal.filter((record) => record.status === "queued")
    for (const record of running) {
      this.perRootActive.set(record.rootRunId, (this.perRootActive.get(record.rootRunId) ?? 0) + 1)
      this.globalActive += 1
    }
    for (const record of queued) {
      this.tryAdmitOrEnqueue(record.taskId, record.rootRunId)
    }
  }

  /** Registers the AbortController driving `runId` in this process, so
   *  cancel() can reach it. Exposed for index.ts's generic background/
   *  subagent continuation dispatch, which drives every `origin: "subagent"`
   *  checkpoint (child tasks included) through the same
   *  continueBackgroundOrSubagentRun call this scheduler itself uses —
   *  registering there too means a task resumed by the startup scan (rather
   *  than by this scheduler's own dispatch) is still cancellable. */
  registerLiveController(runId: string, controller: AbortController): void {
    this.liveControllers.set(runId, controller)
  }

  unregisterLiveController(runId: string): void {
    this.liveControllers.delete(runId)
  }

  /** The onTerminal hook wired into every continueBackgroundOrSubagentRun
   *  call this scheduler makes AND (via index.ts) every generic background/
   *  subagent continuation — harmless no-op for a checkpoint that isn't a
   *  child task's run (findByRunId returns undefined). */
  async handleRunTerminal(checkpoint: AgentRunCheckpointV1): Promise<void> {
    if (checkpoint.identity.origin !== "subagent") return
    const record = await this.deps.store.findByRunId(checkpoint.identity.runId)
    if (!record) return
    if (isTerminalChildTaskStatus(record.status)) return // a cancel() decision already recorded — it wins
    const nextStatus = mapCheckpointStatusToChildTaskStatus(checkpoint.status)
    if (!nextStatus) return
    const resultArtifact =
      nextStatus === "succeeded"
        ? await this.captureResult(record, checkpoint).catch(() => undefined)
        : undefined
    await this.casMutate(record.taskId, (r) => ({
      ...r,
      status: nextStatus,
      resultArtifact,
      updatedAt: this.now(),
    }))
  }

  private tryAdmitOrEnqueue(taskId: string, rootRunId: string): void {
    const rootCount = this.perRootActive.get(rootRunId) ?? 0
    if (
      this.globalActive < this.limits.maxActiveGlobal &&
      rootCount < this.limits.maxActivePerRoot
    ) {
      this.perRootActive.set(rootRunId, rootCount + 1)
      this.globalActive += 1
      void this.admitAndDispatch(taskId, rootRunId).catch((err) => {
        this.deps.onDispatchError?.(taskId, err)
      })
    } else {
      this.pendingQueue.push({ taskId, rootRunId })
    }
  }

  /** Precondition: caller already incremented the slot for `rootRunId`.
   *  Every return path before actually driving the checkpoint releases it
   *  again itself; the drive's own finally releases it exactly once, only
   *  once it is actually reached.
   *
   *  The controller is registered as soon as `currentRunId` is known —
   *  strictly BEFORE the CAS write that makes status "running" externally
   *  observable. This ordering matters: cancel() decides whether a live
   *  driver exists by checking the controller registry, and it can only
   *  ever be called once it has observed "running" — if the registration
   *  happened after that write instead, a cancel() racing right behind the
   *  status flip could find no controller yet and wrongly conclude it must
   *  dispatch a second, independent drive of the same checkpoint. */
  private async admitAndDispatch(taskId: string, rootRunId: string): Promise<void> {
    let record: ChildTaskRecord
    try {
      record = await this.deps.store.get(taskId)
    } catch (err) {
      this.releaseSlotAndPump(rootRunId)
      throw err
    }
    if (isTerminalChildTaskStatus(record.status)) {
      this.releaseSlotAndPump(rootRunId)
      return
    }
    const controller = new AbortController()
    this.registerLiveController(record.currentRunId, controller)
    let running: ChildTaskRecord
    try {
      running = await this.deps.store.mutate(taskId, record.revision, (r) => ({
        ...r,
        status: "running",
        updatedAt: this.now(),
      }))
    } catch (err) {
      this.unregisterLiveController(record.currentRunId)
      this.releaseSlotAndPump(rootRunId)
      // Cancelled between our get() and this mutate() — not a real failure.
      if (err instanceof IllegalChildTaskStatusTransitionError) return
      throw err
    }
    const loaded = await this.deps.runStore.load(running.currentRunId)
    if (!loaded.ok) {
      this.unregisterLiveController(record.currentRunId)
      this.releaseSlotAndPump(rootRunId)
      return
    }
    try {
      await this.driveCheckpoint(running, loaded.checkpoint, controller)
    } finally {
      this.unregisterLiveController(record.currentRunId)
      this.releaseSlotAndPump(rootRunId)
    }
  }

  /** Used by cancel()'s forced-drive path, where no prior registration
   *  exists (a never-dispatched "queued" task) — creates and owns its own
   *  controller end to end. Never occupies a concurrency slot: it is
   *  cleanup of a decision already made, not new admission. */
  private async dispatch(
    record: ChildTaskRecord,
    checkpoint: AgentRunCheckpointV1,
    opts: { preAbort?: boolean }
  ): Promise<void> {
    const controller = new AbortController()
    if (opts.preAbort) controller.abort()
    this.registerLiveController(record.currentRunId, controller)
    try {
      await this.driveCheckpoint(record, checkpoint, controller)
    } finally {
      this.unregisterLiveController(record.currentRunId)
    }
  }

  private async driveCheckpoint(
    record: ChildTaskRecord,
    checkpoint: AgentRunCheckpointV1,
    controller: AbortController
  ): Promise<void> {
    try {
      await continueBackgroundOrSubagentRun(this.genericDeps(), checkpoint, controller.signal)
    } catch (err) {
      this.deps.onDispatchError?.(record.taskId, err)
    }
  }

  private releaseSlotAndPump(rootRunId: string): void {
    this.globalActive = Math.max(0, this.globalActive - 1)
    const current = this.perRootActive.get(rootRunId) ?? 0
    this.perRootActive.set(rootRunId, Math.max(0, current - 1))
    this.pumpQueue()
  }

  private pumpQueue(): void {
    for (let i = 0; i < this.pendingQueue.length; ) {
      if (this.globalActive >= this.limits.maxActiveGlobal) break
      const entry = this.pendingQueue[i]!
      const rootCount = this.perRootActive.get(entry.rootRunId) ?? 0
      if (rootCount >= this.limits.maxActivePerRoot) {
        i++
        continue
      }
      this.pendingQueue.splice(i, 1)
      this.perRootActive.set(entry.rootRunId, rootCount + 1)
      this.globalActive += 1
      void this.admitAndDispatch(entry.taskId, entry.rootRunId).catch((err) => {
        this.deps.onDispatchError?.(entry.taskId, err)
      })
      // Don't advance i — the splice already shifted the next entry into
      // this index.
    }
  }

  private removeFromPendingQueue(taskId: string): void {
    const index = this.pendingQueue.findIndex((entry) => entry.taskId === taskId)
    if (index !== -1) this.pendingQueue.splice(index, 1)
  }

  private abortIfLive(runId: string): boolean {
    const controller = this.liveControllers.get(runId)
    if (!controller) return false
    controller.abort()
    return true
  }

  private async markCancelledIfPossible(taskId: string): Promise<ChildTaskRecord> {
    for (;;) {
      const record = await this.deps.store.get(taskId)
      if (isTerminalChildTaskStatus(record.status)) return record
      try {
        return await this.deps.store.mutate(taskId, record.revision, (r) => ({
          ...r,
          status: "cancelled",
          updatedAt: this.now(),
        }))
      } catch (err) {
        if (err instanceof StaleChildTaskRevisionError) continue
        throw err
      }
    }
  }

  private async casMutate(
    taskId: string,
    mutator: (record: ChildTaskRecord) => ChildTaskRecord
  ): Promise<ChildTaskRecord> {
    for (;;) {
      const record = await this.deps.store.get(taskId)
      try {
        return await this.deps.store.mutate(taskId, record.revision, mutator)
      } catch (err) {
        if (err instanceof StaleChildTaskRevisionError) continue
        throw err
      }
    }
  }

  private async captureResult(
    record: ChildTaskRecord,
    checkpoint: AgentRunCheckpointV1
  ): Promise<AgentArtifactRef | undefined> {
    if (!this.deps.artifactStore) return undefined
    const text = finalAssistantText(toChatMessages(checkpoint.messages))
    const bytes = new TextEncoder().encode(text)
    return this.deps.artifactStore.capture(
      bytes,
      {
        runId: checkpoint.identity.runId,
        owner: {
          runId: checkpoint.identity.runId,
          rootRunId: checkpoint.identity.rootRunId,
          parentRunId: checkpoint.identity.parentRunId,
          conversationId: checkpoint.identity.conversationId,
          workspaceId: checkpoint.identity.workspaceId,
          principal: { kind: "subagent", parentRunId: record.originRunId },
        },
        kind: "child-result",
        mediaType: "text/plain; charset=utf-8",
        sourceBytes: bytes.byteLength,
      },
      // A plain in-memory Uint8Array capture has nothing live to cancel —
      // same rationale as history-artifact.ts's identical no-op abort.
      { abort: () => {} }
    )
  }

  private genericDeps(): GenericRunContinuationDeps {
    return {
      runStore: this.deps.runStore,
      budgetStore: this.deps.budgetStore,
      eventStore: this.deps.eventStore,
      upsertTrace: this.deps.upsertTrace,
      recordRun: this.deps.recordRun,
      tools: this.deps.tools,
      buildProvider: this.deps.buildProvider,
      now: this.now,
      onEvent: this.deps.onEvent,
      estimatorQuarantine: this.deps.estimatorQuarantine,
      artifactStore: this.deps.artifactStore,
      skillPackageLeases: this.deps.skillPackageLeases,
      onTerminal: (checkpoint) => this.handleRunTerminal(checkpoint),
    }
  }
}

function mapCheckpointStatusToChildTaskStatus(
  status: AgentRunCheckpointV1["status"]
): ChildTaskStatus | undefined {
  if (status === "completed") return "succeeded"
  if (status === "cancelled") return "cancelled"
  if (status === "failed") return "failed"
  return undefined
}

function finalAssistantText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant")
  return (
    last?.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() ?? ""
  )
}
