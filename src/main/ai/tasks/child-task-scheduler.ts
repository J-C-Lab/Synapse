import type { AgentArtifactRef, AgentArtifactStore } from "../artifacts/artifact-types"
import type { ChatMessage } from "../providers/types"
import type { AgentRunStore } from "../runs/agent-run-store"
import type { AgentRunCheckpointV1 } from "../runs/checkpoint-schema"
import type { ChildTaskStore } from "./child-task-store"
import type { ChildTaskRecord, ChildTaskStatus } from "./child-task-types"
import { randomUUID } from "node:crypto"
import { isTerminalRunStatus } from "@synapse/agent-protocol"
import { toChatMessages } from "../runs/durable-messages"
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
// today).
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
//
// CRITICAL invariant (fixed after spec review found a real gap): this
// scheduler must NEVER call continueBackgroundOrSubagentRun directly. Doing
// so would let it drive a checkpoint fully independently of index.ts's
// generic autoResumeRecoverableRuns startup scan, which ALSO drives any
// non-terminal automatic-recovery subagent checkpoint — including a
// `queued` child task's, since a fresh, zero-step, matching-authority
// checkpoint classifies as `automatic` with nothing to distinguish it from
// one that is genuinely already in flight. Two independent drivers racing
// to dispatch the same runId at startup is a real double-tool-execution
// risk, not merely a wasted duplicate call: the checkpoint store's per-runId
// CAS mutex only bounds the damage (one loses with a StaleRevisionError on
// its first write), it does not prevent whatever the losing driver already
// executed before that write.
//
// The fix: every real drive of a child's checkpoint — fresh admission,
// startup-recovery dispatch of the `queued` backlog, and a forced
// cancellation of a never-dispatched task — goes through the single
// `dispatchRun` dependency, which in production IS index.ts's
// `continueAnyRun`: the same per-runId in-flight dedup map every other
// entry point into a run (chat(), Resume, the generic recovery scan) already
// shares. Whichever caller reaches `continueAnyRun(runId)` first actually
// drives it; every other concurrent caller for the same runId gets the
// exact same in-flight promise back rather than starting a second drive.
// Production wiring (index.ts) also checks ChildTaskStore for an
// already-durable "cancelled" decision immediately before constructing its
// AbortController, pre-aborting if so — this is what lets cancel() of a
// never-dispatched task finalize to "cancelled" through this exact same
// shared path, without a separate forced-drive method here.
//
// Because `dispatchRun` (== continueAnyRun) resolves once ownership is
// merely *established* for a background/subagent run — not once the run
// actually finishes — this scheduler can no longer release a concurrency
// slot from a `finally` wrapped around that call. Slot release instead
// happens from `handleRunTerminal`, keyed by `slotHolders` (a set of runIds
// that actually went through normal admission), so it fires exactly once,
// whenever the checkpoint genuinely reaches a terminal state, regardless of
// which caller ends up being the one that actually drives it.

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
  tools: import("../tool-registry").AiToolRegistry
  providerId: string
  model: string
  maxOutputTokens: number
  maxSteps: number
}

export interface ChildTaskSchedulerDeps {
  store: ChildTaskStore
  runStore: AgentRunStore
  budgetStore: import("../budget/root-budget-ledger").RootBudgetLedgerStore
  /** Drives one run to a terminal outcome, deduped by runId against every
   *  other in-process caller trying to drive the same run — index.ts's
   *  `continueAnyRun` in production. This scheduler never builds its own
   *  AbortController or calls continueBackgroundOrSubagentRun directly; see
   *  this file's top-of-file note for why that invariant is load-bearing,
   *  not stylistic. */
  dispatchRun: (runId: string) => Promise<void>
  now?: () => number
  newId?: () => string
  /** Recoverable artifact backend — used only to capture a succeeded task's
   *  final text as a `child-result` artifact. Omitted in tests that don't
   *  exercise that capture. */
  artifactStore?: AgentArtifactStore
  /** Best-effort diagnostic hook for a dispatchRun call that rejected —
   *  index.ts's continueAnyRun already logs+swallows genuine setup failures
   *  internally, so this is realistically never the "happy path", but nothing
   *  here may let such a rejection propagate and wedge the scheduler. */
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
  /** runId -> the controller currently driving it. Populated externally by
   *  index.ts around every continueAnyRun call for a background/subagent
   *  checkpoint (this scheduler never constructs its own), so cancel() can
   *  reach a task regardless of which entry point ends up actually driving
   *  it. */
  private readonly liveControllers = new Map<string, AbortController>()
  /** runIds that went through normal admission (queued -> running) and
   *  therefore hold a counted concurrency slot — checked and cleared by
   *  handleRunTerminal so a slot is released exactly once, independent of
   *  whatever the task record's own (possibly already-terminal, via a
   *  proactive cancel() write) status says by the time the checkpoint
   *  actually finishes. */
  private readonly slotHolders = new Set<string>()

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
      // Deliberately the ORIGIN run's own rootRunId, not the child
      // checkpoint's — setupSubagentRun/ensureBudgetAccount gives an
      // unlimited-budget parent's child its own independent, self-keyed
      // root ledger (checkpoint.identity.rootRunId === currentRunId in that
      // case), which would make every sibling task its own unique "root"
      // and silently defeat the per-root-run concurrency cap for the
      // common unlimited-parent case. The concurrency cap's "root run" is a
      // per-conversation/run-tree fairness grouping, orthogonal to whichever
      // budget ledger a given child happens to draw from.
      rootRunId: origin.checkpoint.identity.rootRunId,
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
    // nothing is currently driving it. Route through the exact same shared
    // dispatchRun dedup every other driver uses, rather than building a
    // separate forced-drive path here — production wiring (index.ts) checks
    // ChildTaskStore for precisely this "already durably cancelled" case
    // immediately before constructing its controller, and pre-aborts, so
    // this finalizes to "cancelled" without taking a real model/tool step
    // and can never race a concurrent admission attempt for the same runId.
    // Deliberately does not add to slotHolders: this was never a normal
    // admission, so no slot was ever counted for it.
    try {
      await this.deps.dispatchRun(record.currentRunId)
    } catch (err) {
      this.deps.onDispatchError?.(taskId, err)
    }
  }

  /** Called once at startup, after the generic autoResumeRecoverableRuns
   *  scan has been wired to resume every non-terminal checkpoint (including
   *  this scheduler's `running` child tasks) — see this file's top-of-file
   *  note for the full checkpoint-level/scheduler-level split. Rebuilds
   *  in-process slot bookkeeping from durable ChildTaskRecord status (never
   *  its own separate ledger) and dispatches the `queued` backlog — the one
   *  bucket nothing else will ever drive — respecting the same cap a live
   *  start() would, through the same deduped dispatchRun every other path
   *  uses.
   *
   *  Defensive cross-check: a `running` record's checkpoint is loaded and
   *  compared against its actual status before being trusted as active.
   *  handleRunTerminal is the primary fix for reconciling a checkpoint
   *  finalized outside the normal dispatch path (e.g. a human abandoning a
   *  crashed child task through the existing recovery panel), but this
   *  catches anything that primary fix ever misses — a record whose
   *  checkpoint already reached a real terminal state never counts against
   *  the concurrency cap, regardless of how it got there. */
  async recoverAtStartup(): Promise<void> {
    const nonTerminal = await this.deps.store.scan({ status: ["queued", "running"] })
    const running = nonTerminal.filter((record) => record.status === "running")
    const queued = nonTerminal.filter((record) => record.status === "queued")
    for (const record of running) {
      const loaded = await this.deps.runStore.load(record.currentRunId).catch(() => undefined)
      if (loaded?.ok && isTerminalRunStatus(loaded.checkpoint.status)) {
        await this.handleRunTerminal(loaded.checkpoint).catch(() => {})
        continue
      }
      this.perRootActive.set(record.rootRunId, (this.perRootActive.get(record.rootRunId) ?? 0) + 1)
      this.globalActive += 1
      this.slotHolders.add(record.currentRunId)
    }
    for (const record of queued) {
      this.tryAdmitOrEnqueue(record.taskId, record.rootRunId)
    }
  }

  /** Registers the AbortController driving `runId` in this process, so
   *  cancel() can reach it. This scheduler never constructs its own
   *  controller (see top-of-file note) — index.ts registers one around
   *  every continueAnyRun call for a background/subagent checkpoint, child
   *  tasks included, so a task is reachable by cancel() regardless of
   *  whether the drive was triggered by this scheduler's own dispatchRun
   *  call or by the generic startup recovery scan. */
  registerLiveController(runId: string, controller: AbortController): void {
    this.liveControllers.set(runId, controller)
  }

  unregisterLiveController(runId: string): void {
    this.liveControllers.delete(runId)
  }

  /** The onTerminal hook wired (by index.ts) into every
   *  continueBackgroundOrSubagentRun call `continueAnyRun` makes — harmless
   *  no-op for a checkpoint that isn't a child task's run (findByRunId
   *  returns undefined). Releases this task's concurrency slot, if it ever
   *  held one, regardless of whether its status was already written by a
   *  proactive cancel(). */
  async handleRunTerminal(checkpoint: AgentRunCheckpointV1): Promise<void> {
    if (checkpoint.identity.origin !== "subagent") return
    const runId = checkpoint.identity.runId
    const record = await this.deps.store.findByRunId(runId)
    if (!record) return
    if (!isTerminalChildTaskStatus(record.status)) {
      const nextStatus = mapCheckpointStatusToChildTaskStatus(checkpoint.status)
      if (nextStatus) {
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
    }
    if (this.slotHolders.delete(runId)) this.releaseSlotAndPump(record.rootRunId)
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
   *  Every path that returns without ever calling dispatchRun releases that
   *  slot directly (and, once claimed, removes it from slotHolders too);
   *  once dispatchRun is actually called, releasing the slot becomes
   *  handleRunTerminal's job — dispatchRun (== continueAnyRun in
   *  production) resolves once ownership is merely established, not once
   *  the run actually finishes, so a `finally` here would release the slot
   *  far too early. */
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
    let running: ChildTaskRecord
    try {
      running = await this.deps.store.mutate(taskId, record.revision, (r) => ({
        ...r,
        status: "running",
        updatedAt: this.now(),
      }))
    } catch (err) {
      this.releaseSlotAndPump(rootRunId)
      // Either cancelled between our get() and this mutate() (illegal
      // transition), or some other in-process caller (e.g. a concurrent
      // recovery pass) already advanced this exact record past the
      // revision we read — both are a benign "someone else already
      // resolved this", never a real dispatch failure.
      if (
        err instanceof IllegalChildTaskStatusTransitionError ||
        err instanceof StaleChildTaskRevisionError
      ) {
        return
      }
      throw err
    }
    this.slotHolders.add(running.currentRunId)
    const loaded = await this.deps.runStore.load(running.currentRunId)
    // Defensive: normally unreachable given the CAS ordering above (a
    // checkpoint that had already been fully driven to terminal would have
    // caused our own "running" mutate to fail with a stale revision first,
    // since handleRunTerminal always writes the task record before this
    // point) — kept as a belt-and-braces guard against ever re-dispatching
    // an already-finished run.
    if (!loaded.ok || isTerminalRunStatus(loaded.checkpoint.status)) {
      this.slotHolders.delete(running.currentRunId)
      this.releaseSlotAndPump(rootRunId)
      return
    }
    try {
      await this.deps.dispatchRun(running.currentRunId)
    } catch (err) {
      this.deps.onDispatchError?.(taskId, err)
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
