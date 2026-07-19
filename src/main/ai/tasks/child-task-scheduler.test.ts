import type { ChatProvider } from "../providers/types"
import type { AgentRunCheckpointV1 } from "../runs/checkpoint-schema"
import type { ToolHostPort } from "../tool-registry"
import type { ChildTaskSchedulerDeps, StartChildTaskInput } from "./child-task-scheduler"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InsufficientBudgetError, RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { ConversationStore } from "../conversation-store"
import { emptyUsage } from "../providers/types"
import { upsertRunTrace } from "../run-trace-store"
import { AgentRunRecoveryService } from "../runs/agent-run-recovery-service"
import { AgentRunStore } from "../runs/agent-run-store"
import { setupInteractiveRun } from "../runs/interactive-run-setup"
import { RunEventStore } from "../runs/run-event-store"
import { finalizeRun } from "../runs/run-finalizer"
import {
  autoResumeRecoverableRuns,
  continueBackgroundOrSubagentRun,
} from "../runs/run-recovery-orchestrator"
import { setupSubagentRun } from "../runs/subagent-run-setup"
import { AiToolRegistry } from "../tool-registry"
import { ChildTaskScheduler } from "./child-task-scheduler"
import { ChildTaskStore } from "./child-task-store"

// This file's tests drive real end-to-end run cycles (setup, admission,
// execution, finalization — sometimes twice, for a queued-backlog/cancel
// scenario) through real filesystem I/O, exactly like the durable-run-
// restart integration suite. Vitest's default 5s per-test timeout is
// comfortably enough in isolation but can be tight under the full suite's
// parallel worker contention; give these room the same way that heavier
// integration coverage elsewhere in this repo does.
vi.setConfig({ testTimeout: 20_000 })

let dir: string
let runsDir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let eventStore: RunEventStore
let taskStore: ChildTaskStore
let conversations: ConversationStore
let idCounter: number

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-child-task-scheduler-"))
  runsDir = join(dir, "runs")
  runStore = new AgentRunStore(runsDir)
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  eventStore = new RunEventStore(join(dir, "events"))
  taskStore = new ChildTaskStore(join(dir, "tasks"))
  conversations = new ConversationStore(join(dir, "conversations"), () => 1000)
  idCounter = 0
})

afterEach(async () => {
  // A couple of tests deliberately leave a dispatch permanently in flight
  // (a provider stream that never resolves, standing in for a crashed
  // process) rather than awaiting it to completion — under heavy parallel
  // load its last in-progress atomic write can still be renaming into this
  // directory the instant cleanup starts. Retry past that narrow window
  // instead of failing the test over an unrelated teardown race.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt >= 5 || !(err instanceof Error) || !/ENOTEMPTY|EBUSY/.test(err.message)) throw err
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
})

function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function fakeHost(): ToolHostPort {
  return {
    listTools: () => [
      {
        fqName: "com.x/read",
        pluginId: "com.x",
        provenance: "plugin",
        manifestTool: { name: "read", description: "", inputSchema: { type: "object" } },
      },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
  }
}

function fakeProvider(text = "done") {
  return {
    id: "fake",
    async *stream() {
      yield {
        type: "message" as const,
        message: { role: "assistant" as const, content: [{ type: "text" as const, text }] },
        usage: emptyUsage(),
        stopReason: "end_turn" as const,
      }
    },
  }
}

/** A provider whose stream() never resolves on its own — reacts to the
 *  request's abort signal exactly like a real provider must (design
 *  §"Implementations must honour req.signal"). `reject` is captured
 *  synchronously (the Promise executor runs immediately), so there is no
 *  race between constructing this and a caller reaching for `reject`. */
function makeHangingProvider(): {
  provider: { id: string; stream: (req?: { signal?: AbortSignal }) => AsyncGenerator<never> }
  reject: (err: unknown) => void
  /** Resolves the instant stream()'s (lazy) generator body actually starts
   *  running — a deterministic "the dispatch has genuinely reached the
   *  provider call and is now stuck" signal. Prefer this over polling for
   *  checkpoint-revision stability: under heavy parallel-suite load, "no
   *  change across one short poll gap" can be a false positive (the writer
   *  merely got scheduled out, not actually blocked yet), which raced a
   *  second independent driver against the first one's still-pending write
   *  in exactly the scenario this fixture exists to test. */
  entered: Promise<void>
} {
  let reject!: (err: unknown) => void
  const gate = new Promise<never>((_resolve, rej) => {
    reject = rej
  })
  let markEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  const provider = {
    id: "fake",
    async *stream(req?: { signal?: AbortSignal }): AsyncGenerator<never> {
      markEntered()
      // The signal may already be aborted by the time this (lazy) generator
      // body actually starts running — check synchronously before also
      // listening for a later abort, or an already-fired event would be
      // missed entirely.
      if (req?.signal?.aborted) throw new Error("aborted")
      req?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      await gate
    },
  }
  return { provider, reject, entered }
}

/** A provider whose stream() blocks until explicitly released, then
 *  completes normally (end_turn) — unlike makeHangingProvider (which only
 *  ever errors out), this lets a test hold a dispatch open just long enough
 *  to deterministically observe a downstream effect (e.g. a sibling task
 *  staying genuinely "queued") before letting it succeed for real. */
function makeControllableProvider(): {
  provider: ChatProvider
  release: (text?: string) => void
} {
  let release!: (text: string) => void
  const gate = new Promise<string>((resolve) => {
    release = resolve
  })
  const provider = {
    id: "fake",
    async *stream() {
      const text = await gate
      yield {
        type: "message" as const,
        message: { role: "assistant" as const, content: [{ type: "text" as const, text }] },
        usage: emptyUsage(),
        stopReason: "end_turn" as const,
      }
    },
  }
  return { provider, release: (text = "done") => release(text) }
}

async function seedInteractiveRun(
  runId: string,
  conversationId: string,
  runBudgetTokens?: number
): Promise<void> {
  await conversations.save({
    id: conversationId,
    workspaceId: "ws-1",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })
  await setupInteractiveRun(
    {
      runStore,
      budgetStore,
      conversations,
      tools: new AiToolRegistry(fakeHost()),
      now: () => 1000,
    },
    {
      runId,
      conversationId,
      workspaceId: "ws-1",
      text: "parent turn",
      providerId: "anthropic",
      model: "claude-x",
      maxOutputTokens: 4096,
      maxSteps: 10,
      runBudgetTokens,
      contextCompression: {
        enabled: false,
        thresholdTokens: 0,
        keepRecentFraction: 0.5,
        hardReserveTokens: 0,
      },
      executionWorkspaces: [],
    }
  )
}

/** Test-only stand-in for index.ts's `continueAnyRun`: a per-runId
 *  in-flight dedup map wrapping a real continueBackgroundOrSubagentRun call.
 *  This is deliberately the SAME shape production wiring uses — the
 *  scheduler must never build its own continueBackgroundOrSubagentRun call
 *  (see child-task-scheduler.ts's top-of-file note), so exercising it
 *  through anything else would test a fiction. `scheduler` is filled in
 *  after construction (mirroring index.ts's own forward-reference from
 *  continueAnyRun's closure to the childTaskScheduler it wires into). */
function makeDispatchRun(
  options: {
    tools?: ToolHostPort
    buildProvider?: () => Promise<ChatProvider>
  } = {}
): {
  dispatchRun: (runId: string) => Promise<void>
  bindScheduler: (s: ChildTaskScheduler) => void
  dispatchCount: () => number
} {
  let scheduler: ChildTaskScheduler | undefined
  let count = 0
  const inFlight = new Map<string, Promise<void>>()
  const dispatchRun = (runId: string): Promise<void> => {
    const existing = inFlight.get(runId)
    if (existing) return existing
    const promise = (async () => {
      const loaded = await runStore.load(runId)
      if (!loaded.ok) return
      count += 1
      const cancelledChildTask = await taskStore.findByRunId(runId)
      const controller = new AbortController()
      if (cancelledChildTask?.status === "cancelled") controller.abort()
      scheduler!.registerLiveController(runId, controller)
      try {
        await continueBackgroundOrSubagentRun(
          {
            runStore,
            budgetStore,
            eventStore,
            upsertTrace: (input) => upsertRunTrace(runsDir, input),
            tools: options.tools ?? fakeHost(),
            buildProvider: async () =>
              options.buildProvider ? options.buildProvider() : fakeProvider(),
            onTerminal: (cp) => scheduler!.handleRunTerminal(cp),
          },
          loaded.checkpoint as AgentRunCheckpointV1,
          controller.signal
        )
      } finally {
        scheduler!.unregisterLiveController(runId)
      }
    })()
    const tracked = promise.finally(() => {
      if (inFlight.get(runId) === tracked) inFlight.delete(runId)
    })
    inFlight.set(runId, tracked)
    return tracked
  }
  return {
    dispatchRun,
    bindScheduler: (s) => {
      scheduler = s
    },
    dispatchCount: () => count,
  }
}

function makeScheduler(
  overrides: Partial<ChildTaskSchedulerDeps> = {},
  dispatchOptions: Parameters<typeof makeDispatchRun>[0] = {}
): ChildTaskScheduler {
  const { dispatchRun, bindScheduler } = makeDispatchRun(dispatchOptions)
  const deps: ChildTaskSchedulerDeps = {
    store: taskStore,
    runStore,
    budgetStore,
    dispatchRun,
    now: () => 2000,
    newId: () => nextId("id"),
    ...overrides,
  }
  const scheduler = new ChildTaskScheduler(deps)
  bindScheduler(scheduler)
  return scheduler
}

function taskInput(overrides: Partial<StartChildTaskInput> = {}): StartChildTaskInput {
  return {
    originRunId: "origin-1",
    name: "count files",
    description: "count the files in the workspace",
    instruction: "count them",
    tools: new AiToolRegistry(fakeHost()),
    providerId: "anthropic",
    model: "claude-x",
    maxOutputTokens: 4096,
    maxSteps: 3,
    budgetTokens: 32_768,
    ...overrides,
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("childTaskScheduler.start", () => {
  it("fails closed (no task, no checkpoint) when the origin run does not exist", async () => {
    const scheduler = makeScheduler()
    await expect(scheduler.start(taskInput({ originRunId: "does-not-exist" }))).rejects.toThrow(
      /run not found/
    )
    expect(await taskStore.scan()).toEqual([])
  })

  it("fails closed (no task, no checkpoint) when the origin run has no conversation", async () => {
    const { setupBackgroundRun } = await import("../runs/background-run-setup")
    const backgroundCheckpoint = await setupBackgroundRun(
      { runStore, budgetStore, tools: new AiToolRegistry(fakeHost()), now: () => 1000 },
      {
        runId: "bg-origin-1",
        workspaceId: "ws-1",
        invocationId: "inv-1",
        triggerInstanceId: "instance-1",
        pluginId: "com.example.plugin",
        triggerId: "trigger-1",
        pluginIdentity: {
          pluginId: "com.example.plugin",
          publisherId: "unsigned",
          signingKeyFingerprint: "local:user",
          capabilityDeclarationHash: "declaration-v1",
        },
        allowedUses: [],
        instruction: "background work",
        event: {},
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 1,
        maxSteps: 1,
        maxToolCallsPerRun: 0,
        timeoutMs: 60_000,
        executionWorkspaces: [],
      }
    )
    expect(backgroundCheckpoint.identity.conversationId).toBeUndefined()

    const scheduler = makeScheduler()
    await expect(scheduler.start(taskInput({ originRunId: "bg-origin-1" }))).rejects.toThrow(
      /interactive run with an active conversation/
    )
    expect(await taskStore.scan()).toEqual([])
  })

  it("creates a task, admits it immediately when a slot is free, and drives it to succeeded", async () => {
    await seedInteractiveRun("origin-1", "c1")
    const scheduler = makeScheduler()
    const { taskId } = await scheduler.start(taskInput())

    await waitUntil(async () => (await taskStore.get(taskId)).status === "succeeded")
    const record = await taskStore.get(taskId)
    expect(record.conversationId).toBe("c1")
    expect(record.originRunId).toBe("origin-1")
    expect(record.status).toBe("succeeded")

    const finalCheckpoint = await runStore.load(record.currentRunId)
    expect(finalCheckpoint.ok && finalCheckpoint.checkpoint.status).toBe("completed")
  })

  it("captures the child's final text as a child-result artifact when an artifact store is supplied", async () => {
    await seedInteractiveRun("origin-1", "c1")
    const artifactStore = {
      capture: vi.fn(async (bytes: Uint8Array | AsyncIterable<Uint8Array>, _metadata: unknown) => {
        const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : 0
        return {
          uri: `artifact://run/r/a1` as const,
          runId: "r",
          artifactId: "a1",
          kind: "child-result" as const,
          mediaType: "text/plain; charset=utf-8",
          capturedBytes: byteLength,
          complete: true,
          sha256: "0".repeat(64),
          createdAt: 1,
        }
      }),
      stat: vi.fn(),
      read: vi.fn(),
      resolve: vi.fn(),
      releaseRunPin: vi.fn(async () => {}),
      collectEligible: vi.fn(async () => ({
        reconciledReservations: 0,
        reclaimedReservedBytes: 0,
        orphanedTempFilesRemoved: 0,
        deletedArtifacts: 0,
        deletedBytes: 0,
      })),
    }
    const scheduler = makeScheduler({ artifactStore })
    const { taskId } = await scheduler.start(taskInput())

    await waitUntil(async () => (await taskStore.get(taskId)).status === "succeeded")
    const record = await taskStore.get(taskId)
    expect(record.resultArtifact?.kind).toBe("child-result")
    expect(artifactStore.capture).toHaveBeenCalledTimes(1)
  })

  it("fails closed and never persists a task record when the budget reservation is insufficient", async () => {
    // Each durable child reserves its own explicit finite account from the
    // parent root. A tiny 10-token root backs exactly one 10-token child;
    // a sibling cannot overbook the already-exhausted free balance.
    await seedInteractiveRun("origin-1", "c1", 10)
    const scheduler = makeScheduler()
    const first = await scheduler.start(taskInput({ instruction: "first", budgetTokens: 10 }))

    await expect(
      scheduler.start(taskInput({ instruction: "second", budgetTokens: 10 }))
    ).rejects.toBeInstanceOf(InsufficientBudgetError)
    const tasks = await taskStore.scan()
    expect(tasks.map((t) => t.taskId)).toEqual([first.taskId])

    // Let the first task's dispatch actually finish before the test ends,
    // so afterEach's directory cleanup never races an in-flight checkpoint
    // write from this test's own background dispatch.
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")
  })

  it("releases a completed child's unused reservation so a later child can be admitted", async () => {
    await seedInteractiveRun("origin-1", "c1", 100)
    const { provider: controllableProvider, release } = makeControllableProvider()
    const scheduler = makeScheduler({}, { buildProvider: async () => controllableProvider })
    const first = await scheduler.start(
      taskInput({ instruction: "first", maxOutputTokens: 64, budgetTokens: 100 })
    )
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "running")

    // The full root cap is reserved by the active first child, even before
    // it spends any model tokens.
    await expect(
      scheduler.start(taskInput({ instruction: "second", maxOutputTokens: 64, budgetTokens: 100 }))
    ).rejects.toBeInstanceOf(InsufficientBudgetError)

    release("first done")
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")
    const firstRecord = await taskStore.get(first.taskId)
    await waitUntil(async () => {
      const ledger = await budgetStore.load("origin-1")
      return ledger.accounts[firstRecord.currentRunId] === undefined
    })
    const releasedLedger = await budgetStore.load("origin-1")
    expect(releasedLedger.accounts[firstRecord.currentRunId]).toBeUndefined()
    expect(releasedLedger.accounts.root?.reservedTokens).toBe(0)

    await expect(
      scheduler.start(taskInput({ instruction: "second", maxOutputTokens: 64, budgetTokens: 100 }))
    ).resolves.toEqual(expect.objectContaining({ taskId: expect.any(String) }))
  })

  it("releases a failed child's reservation without erasing its accounted consumption", async () => {
    await seedInteractiveRun("origin-1", "c1", 100)
    // Finalize a durably admitted child through the same terminal hook an
    // actual failed model run reaches. This keeps the test focused on the
    // scheduler's release/reconciliation contract rather than provider
    // retry policy.
    const scheduler = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      dispatchRun: async () => {},
    })
    const { taskId } = await scheduler.start(taskInput({ maxOutputTokens: 64, budgetTokens: 100 }))
    await waitUntil(async () => (await taskStore.get(taskId)).status === "running")
    const record = await taskStore.get(taskId)
    const failed = await finalizeRun(
      {
        runStore,
        upsertTrace: (input) => upsertRunTrace(runsDir, input),
        releaseResources: async () => ({ artifactRunPinReleased: false }),
        now: () => 3000,
      },
      record.currentRunId,
      {
        desiredStatus: "failed",
        stopReason: "provider_error",
        trace: {
          runId: record.currentRunId,
          origin: "subagent",
          startedAt: 1000,
          endedAt: 3000,
          outcome: "error",
          toolCalls: [],
        },
        resourceReleasePlan: {
          budgetOperationIds: [],
          skillPackageLeaseIds: [],
          releaseArtifactRunPin: false,
          adoptionLeaseIds: [],
        },
      }
    )
    await scheduler.handleRunTerminal(failed)
    expect((await taskStore.get(taskId)).status).toBe("failed")
    const ledger = await budgetStore.load("origin-1")
    expect(ledger.accounts[record.currentRunId]).toBeUndefined()
    expect(ledger.accounts.root?.reservedTokens).toBe(0)
    expect(ledger.accounts.root?.consumedTokens).toBeGreaterThanOrEqual(0)
  })
})

describe("childTaskScheduler bounded concurrency", () => {
  it("queues a task beyond the per-root cap and dispatches it once a slot frees", async () => {
    await seedInteractiveRun("origin-1", "c1")
    const scheduler = makeScheduler({ limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 } })

    const first = await scheduler.start(taskInput({ instruction: "first" }))
    const second = await scheduler.start(taskInput({ instruction: "second" }))

    // The second task could not get a slot (cap=1) — it starts out queued,
    // its checkpoint already created but never driven.
    const secondQueuedRecord = await taskStore.get(second.taskId)
    expect(secondQueuedRecord.status).toBe("queued")

    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")
    await waitUntil(async () => (await taskStore.get(second.taskId)).status === "succeeded")
  })

  it("enforces a global cap across different root runs", async () => {
    await seedInteractiveRun("origin-1", "c1")
    await seedInteractiveRun("origin-2", "c2")
    const scheduler = makeScheduler({ limits: { maxActivePerRoot: 3, maxActiveGlobal: 1 } })

    const first = await scheduler.start(taskInput({ originRunId: "origin-1" }))
    const second = await scheduler.start(taskInput({ originRunId: "origin-2" }))

    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")
    await waitUntil(async () => (await taskStore.get(second.taskId)).status === "succeeded")
  })

  it("manual queued-run admission waits for an occupied cap and dispatches once that slot releases", async () => {
    await seedInteractiveRun("origin-1", "c1")
    const { provider: controllableProvider, release } = makeControllableProvider()
    const scheduler = makeScheduler(
      { limits: { maxActivePerRoot: 1, maxActiveGlobal: 1 } },
      { buildProvider: async () => controllableProvider }
    )
    const first = await scheduler.start(taskInput({ instruction: "slot holder" }))
    const second = await scheduler.start(taskInput({ instruction: "manual resume target" }))
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "running")
    const queued = await taskStore.get(second.taskId)
    expect(queued.status).toBe("queued")

    // This is the exact scheduler method runs:resume invokes after durable
    // recovery. It must not begin the model run while the first task owns
    // the sole global/per-root slot.
    await expect(scheduler.admitQueuedRunForResume(queued.currentRunId)).resolves.toBe(true)
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    release("slot released")
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")
    await waitUntil(async () => (await taskStore.get(second.taskId)).status === "succeeded")
  })
})

describe("childTaskScheduler.cancel", () => {
  it("cancels a queued task (never dispatched) and finalizes its checkpoint as cancelled", async () => {
    await seedInteractiveRun("origin-1", "c1")
    // "first" holds the only slot open (via a controllable, not-yet-resolved
    // provider) for as long as this test needs — without that, "first" can
    // race to completion and free its slot before this test ever gets to
    // cancel "second", letting pumpQueue() auto-promote "second" out of
    // "queued" first and turning this into a flaky test of a completely
    // different scenario.
    const { provider: controllableProvider, release } = makeControllableProvider()
    const scheduler = makeScheduler(
      { limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 } },
      { buildProvider: async () => controllableProvider }
    )
    const first = await scheduler.start(taskInput({ instruction: "first" }))
    const second = await scheduler.start(taskInput({ instruction: "second" }))
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "running")
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    await scheduler.cancel(second.taskId)
    const cancelledRecord = await taskStore.get(second.taskId)
    expect(cancelledRecord.status).toBe("cancelled")

    await waitUntil(async () => {
      const cp = await runStore.load(cancelledRecord.currentRunId)
      return cp.ok && cp.checkpoint.status === "cancelled"
    })
    await waitUntil(async () => {
      const ledger = await budgetStore.load("origin-1")
      return ledger.accounts[cancelledRecord.currentRunId] === undefined
    })
    const ledgerAfterQueuedCancel = await budgetStore.load("origin-1")
    expect(ledgerAfterQueuedCancel.accounts[cancelledRecord.currentRunId]).toBeUndefined()

    // Cancelling the queued task must not consume its concurrency slot —
    // releasing "first" now should let it complete normally.
    release()
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")
  })

  it("cancels a running task by aborting its live controller", async () => {
    await seedInteractiveRun("origin-1", "c1")
    // A provider that never resolves on its own lets the test reliably
    // observe the task still "running" before cancelling it; it reacts to
    // the abort signal exactly like a real provider must.
    const { provider: hangingProvider } = makeHangingProvider()
    const scheduler = makeScheduler({}, { buildProvider: async () => hangingProvider })
    const { taskId } = await scheduler.start(taskInput())

    await waitUntil(async () => (await taskStore.get(taskId)).status === "running")
    await scheduler.cancel(taskId)

    // cancel() persists the task-record decision immediately (durable
    // -before-signal, by design) but the underlying checkpoint only reaches
    // its own terminal "cancelled" status once the aborted drive actually
    // finishes finalizing, asynchronously — wait for that directly rather
    // than for the (already-flipped) task record.
    const record = await taskStore.get(taskId)
    expect(record.status).toBe("cancelled")
    await waitUntil(async () => {
      const cp = await runStore.load(record.currentRunId)
      return cp.ok && cp.checkpoint.status === "cancelled"
    })
  })

  it("is idempotent for an already-terminal task", async () => {
    await seedInteractiveRun("origin-1", "c1")
    const scheduler = makeScheduler()
    const { taskId } = await scheduler.start(taskInput())
    await waitUntil(async () => (await taskStore.get(taskId)).status === "succeeded")

    await expect(scheduler.cancel(taskId)).resolves.toBeUndefined()
    expect((await taskStore.get(taskId)).status).toBe("succeeded")
  })
})

describe("childTaskScheduler.recoverAtStartup", () => {
  it("dispatches a queued backlog left over from a previous process, respecting the per-root cap", async () => {
    await seedInteractiveRun("origin-1", "c1")
    const firstProcess = makeScheduler({ limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 } })
    const first = await firstProcess.start(taskInput({ instruction: "first" }))
    const second = await firstProcess.start(taskInput({ instruction: "second" }))
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    // Let the first one actually finish so the "restart" scenario is a
    // genuinely leftover queued backlog, not a still-running task.
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")

    // A fresh scheduler instance simulates a new process: no in-memory
    // bookkeeping, no live controllers, only what's durable.
    const restarted = makeScheduler({ limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 } })
    await restarted.recoverAtStartup()

    await waitUntil(async () => (await taskStore.get(second.taskId)).status === "succeeded")
  })

  it("recomputes running-task bookkeeping so a live start() right after restart still respects the cap", async () => {
    await seedInteractiveRun("origin-1", "c1")
    // Simulate a task whose checkpoint was left "running" by a crashed
    // process: created directly (bypassing the scheduler's own dispatch),
    // status left at "running".
    // Deliberately never resolved/rejected: the point of this fixture is a
    // dispatch that is genuinely still in flight (as if the process were
    // about to crash), not one that cleanly errors out.
    const { provider: hangingProvider } = makeHangingProvider()
    const crashedProcess = makeScheduler(
      { limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 } },
      { buildProvider: async () => hangingProvider }
    )
    const leftRunning = await crashedProcess.start(taskInput())
    await waitUntil(async () => (await taskStore.get(leftRunning.taskId)).status === "running")

    const restarted = makeScheduler({ limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 } })
    await restarted.recoverAtStartup()

    // The cap is already fully occupied by the "running" record recomputed
    // from disk — a brand-new task on the same root must queue behind it,
    // not bypass the cap.
    const extra = await restarted.start(taskInput({ instruction: "extra" }))
    expect((await taskStore.get(extra.taskId)).status).toBe("queued")
  })

  it("does not discard a live task or its reservation when checkpoint loading has an I/O failure", async () => {
    await seedInteractiveRun("origin-1", "c1", 100)
    // Durable setup has completed; only the original process's dispatch is
    // absent. This models a restart whose storage momentarily returns EIO
    // for an otherwise intact child checkpoint.
    const beforeRestart = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      dispatchRun: async () => {},
    })
    const { taskId } = await beforeRestart.start(taskInput({ budgetTokens: 100 }))
    await waitUntil(async () => (await taskStore.get(taskId)).status === "running")
    const record = await taskStore.get(taskId)
    const ledgerBefore = await budgetStore.load("origin-1")

    const ioFailure = Object.assign(new Error("simulated EIO while reading checkpoint"), {
      code: "EIO",
    })
    const originalLoad = runStore.load.bind(runStore)
    const load = vi.spyOn(runStore, "load").mockImplementation(async (runId) => {
      if (runId === record.currentRunId) throw ioFailure
      return originalLoad(runId)
    })
    const restarted = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      dispatchRun: async () => {},
    })

    try {
      await expect(restarted.recoverAtStartup()).rejects.toBe(ioFailure)
    } finally {
      load.mockRestore()
    }

    // The failed startup pass did not confuse a transient read failure with
    // a missing/corrupt checkpoint. Generic recovery will be held back by
    // the propagated error, and its later retry sees the untouched record
    // and finite child reservation.
    expect((await taskStore.get(taskId)).status).toBe("running")
    expect(await budgetStore.load("origin-1")).toEqual(ledgerBefore)
  })

  it("keeps queued work out of generic restart recovery and below the global cap across roots", async () => {
    await seedInteractiveRun("origin-1", "c1")
    await seedInteractiveRun("origin-2", "c2")
    const limits = { maxActivePerRoot: 1, maxActiveGlobal: 1 }
    // Process #1 reserves both children but only admits the first global
    // slot. Its no-op dispatcher models a crash immediately after admission.
    const beforeRestart = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      dispatchRun: async () => {},
      limits,
    })
    const first = await beforeRestart.start(taskInput({ originRunId: "origin-1" }))
    const second = await beforeRestart.start(taskInput({ originRunId: "origin-2" }))
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "running")
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    // Process #2 reconstructs the occupied global slot before generic
    // recovery. It can neither admit the cross-root queued record nor let
    // the generic scan do so behind the scheduler's back.
    const afterRestart = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      dispatchRun: async () => {},
      limits,
    })
    await afterRestart.recoverAtStartup()
    expect((await taskStore.get(first.taskId)).status).toBe("running")
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    const genericDispatches: string[] = []
    await autoResumeRecoverableRuns({
      recovery: {
        listRecoverable: async () => {
          const records = await taskStore.scan()
          const summaries = []
          for (const record of records) {
            if (record.status === "queued") continue
            const loaded = await runStore.load(record.currentRunId)
            if (!loaded.ok) continue
            summaries.push({
              runId: record.currentRunId,
              rootRunId: loaded.checkpoint.identity.rootRunId,
              origin: "subagent" as const,
              status: "running" as const,
              recovery: { kind: "automatic" as const },
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            })
          }
          return summaries
        },
        resume: async () => {},
        abandon: async () => {},
      },
      runStore,
      continueRun: async (checkpoint) => {
        genericDispatches.push(checkpoint.identity.runId)
      },
    })
    expect(genericDispatches).toEqual([(await taskStore.get(first.taskId)).currentRunId])

    const third = await afterRestart.start(taskInput({ originRunId: "origin-1" }))
    expect((await taskStore.get(third.taskId)).status).toBe("queued")
  })
})

describe("childTaskScheduler.handleRunTerminal (generic-path integration)", () => {
  it("updates a task's status when its checkpoint is driven by a caller other than this scheduler's own dispatch", async () => {
    await seedInteractiveRun("origin-1", "c1")
    // A no-op dispatcher stands in for a process that died immediately after
    // durable admission. There is no surviving in-flight model request in
    // this process; a fresh generic recovery driver below is therefore the
    // sole continuation owner, precisely matching a real restart.
    const owningScheduler = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      dispatchRun: async () => {},
    })
    const { taskId } = await owningScheduler.start(taskInput())
    await waitUntil(async () => (await taskStore.get(taskId)).status === "running")
    const record = await taskStore.get(taskId)

    const loaded = await runStore.load(record.currentRunId)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const observer = makeScheduler()
    await continueBackgroundOrSubagentRun(
      {
        runStore,
        budgetStore,
        eventStore,
        upsertTrace: (input) => upsertRunTrace(runsDir, input),
        tools: fakeHost(),
        buildProvider: async () => fakeProvider("resumed by generic path"),
        onTerminal: (cp) => observer.handleRunTerminal(cp),
      },
      loaded.checkpoint
    )

    const final = await taskStore.get(taskId)
    expect(final.status).toBe("succeeded")
  })
})

describe("startup queued-admission gate (spec review fix)", () => {
  it("keeps a queued child out of generic recovery so only the capped scheduler dispatches it", async () => {
    await seedInteractiveRun("origin-1", "c1")

    // One shared dedup'd dispatchRun — standing in for index.ts's
    // continueAnyRun. The generic scan is deliberately filtered below: a
    // durable `queued` record has not claimed a child-task slot and must not
    // get an uncapped generic continuation during startup.
    const { dispatchRun, bindScheduler, dispatchCount } = makeDispatchRun()
    const scheduler = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      dispatchRun,
      now: () => 2000,
      newId: () => nextId("id"),
    })
    bindScheduler(scheduler)

    // A "queued, never dispatched" ChildTaskRecord constructed directly
    // (bypassing start()'s own auto-admission) — exactly what a crashed
    // process leaves behind: checkpoint already created and budget-reserved,
    // task record still "queued". This checkpoint is a fresh, zero-step,
    // matching-authority subagent checkpoint — indistinguishable, at the
    // checkpoint level, from one genuinely in flight, which is precisely why
    // the generic scan's classifier alone cannot skip it.
    const currentRunId = nextId("child")
    const checkpoint = await setupSubagentRun(
      { runStore, budgetStore, tools: new AiToolRegistry(fakeHost()), now: () => 2000 },
      {
        runId: currentRunId,
        parentRunId: "origin-1",
        instruction: "count them",
        providerId: "anthropic",
        model: "claude-x",
        maxOutputTokens: 4096,
        maxSteps: 3,
      }
    )
    const origin = await runStore.load("origin-1")
    if (!origin.ok) throw new Error("origin-1 checkpoint missing")
    const taskId = "task-under-test"
    await taskStore.create({
      schemaVersion: 1,
      revision: 0,
      taskId,
      conversationId: "c1",
      originRunId: "origin-1",
      // The ORIGIN's own rootRunId (matching ChildTaskScheduler.start()'s
      // real behavior) — not checkpoint.identity.rootRunId, which for this
      // unlimited-budget origin is the child's own self-referential ledger
      // key (see child-task-scheduler.ts's identical note in start()).
      rootRunId: origin.checkpoint.identity.rootRunId,
      currentRunId,
      name: "n",
      description: "d",
      status: "queued",
      budgetAccountId: currentRunId,
      allocationOperationId: `reserve-subagent:${currentRunId}`,
      createdAt: 2000,
      updatedAt: 2000,
    })

    // First prove the generic scan cannot dispatch a still-queued child.
    // Then perform the scheduler restart recovery, which is the only path
    // permitted to claim a slot and drive it.
    await autoResumeRecoverableRuns({
      recovery: {
        listRecoverable: async () => {
          const child = await taskStore.findByRunId(currentRunId)
          if (child?.status === "queued") return []
          return [
            {
              runId: currentRunId,
              rootRunId: checkpoint.identity.rootRunId,
              origin: "subagent" as const,
              status: "running" as const,
              recovery: { kind: "automatic" as const },
              createdAt: 1,
              updatedAt: 1,
            },
          ]
        },
        resume: async () => {},
        abandon: async () => {},
      },
      runStore,
      continueRun: async (cp) => {
        await dispatchRun(cp.identity.runId)
      },
    })
    expect(dispatchCount()).toBe(0)
    await scheduler.recoverAtStartup()

    await waitUntil(async () => (await taskStore.get(taskId)).status === "succeeded")
    expect(dispatchCount()).toBe(1)

    const finalCheckpoint = await runStore.load(currentRunId)
    expect(finalCheckpoint.ok && finalCheckpoint.checkpoint.status).toBe("completed")
  })
})

describe("reconciliation via AgentRunRecoveryService.abandon() (code-quality review fix)", () => {
  it("updates the ChildTaskRecord and frees the concurrency slot when a running task is abandoned through the human-review recovery path", async () => {
    await seedInteractiveRun("origin-1", "c1")

    // A cap of 1 means "second" stays genuinely queued behind "first".
    // The first dispatch is intentionally a durable-startup crash seam: it
    // establishes `running`/slot state but does no model work. The second is
    // a real continuation, so success proves abandonment actually released
    // a usable slot rather than merely changing the record on paper.
    let scheduler!: ChildTaskScheduler
    let dispatches = 0
    const dispatchRun = async (runId: string): Promise<void> => {
      dispatches += 1
      if (dispatches === 1) return
      const loaded = await runStore.load(runId)
      if (!loaded.ok) return
      await continueBackgroundOrSubagentRun(
        {
          runStore,
          budgetStore,
          eventStore,
          upsertTrace: (input) => upsertRunTrace(runsDir, input),
          tools: fakeHost(),
          buildProvider: async () => fakeProvider(),
          onTerminal: (checkpoint) => scheduler.handleRunTerminal(checkpoint),
        },
        loaded.checkpoint
      )
    }
    scheduler = new ChildTaskScheduler({
      store: taskStore,
      runStore,
      budgetStore,
      dispatchRun,
      limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 },
    })
    const first = await scheduler.start(taskInput({ instruction: "first" }))
    const second = await scheduler.start(taskInput({ instruction: "second" }))
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "running")
    expect((await taskStore.get(first.taskId)).status).toBe("running")
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    // A real AgentRunRecoveryService, wired the same way index.ts wires it
    // in production: finalize() drives the checkpoint through the normal
    // six-phase protocol AND reconciles the ChildTaskRecord via
    // handleRunTerminal — the fix under test. abandon() itself never
    // consults the recovery classification (requires_review/blocked) at
    // all — it only requires a non-terminal checkpoint — so this exercises
    // the exact code path a human clicking "abandon" on a
    // requires_review: unknown-tool-outcome run in the existing recovery
    // panel would hit, without needing to separately fabricate that
    // classification.
    const recoveryService = new AgentRunRecoveryService({
      runStore,
      now: () => 9000,
      buildClassifierInput: async (checkpoint) => ({
        currentAuthority: checkpoint.config.authority,
        now: 9000,
      }),
      finalize: async (runId, input) => {
        const finalized = await finalizeRun(
          {
            runStore,
            upsertTrace: (i) => upsertRunTrace(runsDir, i),
            releaseResources: async () => ({ artifactRunPinReleased: false }),
            now: () => 9000,
          },
          runId,
          input
        )
        await scheduler.handleRunTerminal(finalized)
        return finalized
      },
      buildAbandonTrace: (checkpoint) => ({
        runId: checkpoint.identity.runId,
        origin: checkpoint.identity.origin,
        startedAt: checkpoint.createdAt,
        endedAt: 9000,
        outcome: "aborted",
        toolCalls: [],
      }),
      buildFailureTrace: (checkpoint) => ({
        runId: checkpoint.identity.runId,
        origin: checkpoint.identity.origin,
        startedAt: checkpoint.createdAt,
        endedAt: 9000,
        outcome: "error",
        toolCalls: [],
      }),
      buildAbandonResourcePlan: () => ({
        budgetOperationIds: [],
        skillPackageLeaseIds: [],
        releaseArtifactRunPin: false,
        adoptionLeaseIds: [],
      }),
    })

    const firstRunId = (await taskStore.get(first.taskId)).currentRunId
    await recoveryService.abandon(firstRunId)

    // The ChildTaskRecord reflects the terminal outcome — not left stuck at
    // "running" forever the way it did before this fix.
    const abandonedRecord = await taskStore.get(first.taskId)
    expect(abandonedRecord.status).toBe("cancelled")
    const abandonedCheckpoint = await runStore.load(firstRunId)
    expect(abandonedCheckpoint.ok && abandonedCheckpoint.checkpoint.status).toBe("cancelled")

    // The freed slot is real: "second" — previously blocked by the cap —
    // now gets admitted and its real continuation completes.
    await waitUntil(async () => (await taskStore.get(second.taskId)).status === "succeeded")
  })
})
