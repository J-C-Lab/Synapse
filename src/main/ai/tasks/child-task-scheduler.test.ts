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
import { AgentRunStore } from "../runs/agent-run-store"
import { setupInteractiveRun } from "../runs/interactive-run-setup"
import { RunEventStore } from "../runs/run-event-store"
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
 *  §"Implementations must honour req.signal"), and can also be force-
 *  rejected directly for tests that just need to abandon a dispatch
 *  without going through cancel()/abort. `reject` is captured
 *  synchronously (the Promise executor runs immediately), so there is no
 *  race between constructing this and a caller reaching for `reject`. */
function makeHangingProvider(): {
  provider: { id: string; stream: (req?: { signal?: AbortSignal }) => AsyncGenerator<never> }
  reject: (err: unknown) => void
} {
  let reject!: (err: unknown) => void
  const gate = new Promise<never>((_resolve, rej) => {
    reject = rej
  })
  const provider = {
    id: "fake",
    async *stream(req?: { signal?: AbortSignal }): AsyncGenerator<never> {
      // The signal may already be aborted by the time this (lazy) generator
      // body actually starts running — check synchronously before also
      // listening for a later abort, or an already-fired event would be
      // missed entirely.
      if (req?.signal?.aborted) throw new Error("aborted")
      req?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      await gate
    },
  }
  return { provider, reject }
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

function makeScheduler(overrides: Partial<ChildTaskSchedulerDeps> = {}): ChildTaskScheduler {
  const deps: ChildTaskSchedulerDeps = {
    store: taskStore,
    runStore,
    budgetStore,
    eventStore,
    upsertTrace: (input) => upsertRunTrace(runsDir, input),
    tools: fakeHost(),
    buildProvider: async () => fakeProvider(),
    now: () => 2000,
    newId: () => nextId("id"),
    ...overrides,
  }
  return new ChildTaskScheduler(deps)
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
    const captured: unknown[] = []
    const artifactStore = {
      capture: vi.fn(async (bytes: Uint8Array | AsyncIterable<Uint8Array>, metadata: unknown) => {
        captured.push(metadata)
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
    // A subagent's reservation is always the parent's whole runBudgetTokens
    // (see subagent-run-setup.ts's ensureBudgetAccount) — a tiny 10-token
    // parent budget backs exactly one child; a second child on the same
    // origin/root cannot get a second 10-token reservation out of an
    // already-exhausted root free balance.
    await seedInteractiveRun("origin-1", "c1", 10)
    const scheduler = makeScheduler()
    const first = await scheduler.start(taskInput({ instruction: "first" }))

    await expect(scheduler.start(taskInput({ instruction: "second" }))).rejects.toBeInstanceOf(
      InsufficientBudgetError
    )
    const tasks = await taskStore.scan()
    expect(tasks.map((t) => t.taskId)).toEqual([first.taskId])

    // Let the first task's dispatch actually finish before the test ends,
    // so afterEach's directory cleanup never races an in-flight checkpoint
    // write from this test's own background dispatch.
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")
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
})

describe("childTaskScheduler.cancel", () => {
  it("cancels a queued task (never dispatched) and finalizes its checkpoint as cancelled", async () => {
    await seedInteractiveRun("origin-1", "c1")
    const scheduler = makeScheduler({ limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 } })
    const first = await scheduler.start(taskInput({ instruction: "first" }))
    const second = await scheduler.start(taskInput({ instruction: "second" }))
    expect((await taskStore.get(second.taskId)).status).toBe("queued")

    await scheduler.cancel(second.taskId)
    const cancelledRecord = await taskStore.get(second.taskId)
    expect(cancelledRecord.status).toBe("cancelled")

    await waitUntil(async () => {
      const cp = await runStore.load(cancelledRecord.currentRunId)
      return cp.ok && cp.checkpoint.status === "cancelled"
    })

    // Cancelling the queued task must not consume its concurrency slot —
    // the first task (already running) should still complete normally.
    await waitUntil(async () => (await taskStore.get(first.taskId)).status === "succeeded")
  })

  it("cancels a running task by aborting its live controller", async () => {
    await seedInteractiveRun("origin-1", "c1")
    // A provider that never resolves on its own lets the test reliably
    // observe the task still "running" before cancelling it; it reacts to
    // the abort signal exactly like a real provider must.
    const { provider: hangingProvider } = makeHangingProvider()
    const scheduler = makeScheduler({ buildProvider: async () => hangingProvider })
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
    const crashedProcess = makeScheduler({
      buildProvider: async () => hangingProvider,
      limits: { maxActivePerRoot: 1, maxActiveGlobal: 6 },
    })
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
})

describe("childTaskScheduler.handleRunTerminal (generic-path integration)", () => {
  it("updates a task's status when its checkpoint is driven by a caller other than this scheduler's own dispatch", async () => {
    await seedInteractiveRun("origin-1", "c1")
    // A scheduler with a hanging provider stands in for "a task left running
    // by a previous process" — we never let its own dispatch reach
    // completion; instead we drive the SAME checkpoint through a second,
    // independent continueBackgroundOrSubagentRun call (standing in for
    // index.ts's generic startup-recovery dispatch) with a FRESH scheduler
    // instance's handleRunTerminal wired as onTerminal, and confirm it
    // updates the record even though that scheduler never called start().
    // Deliberately never resolved/rejected — see the identical rationale in
    // the recoverAtStartup bookkeeping test above.
    const { provider: hangingProvider } = makeHangingProvider()
    const owningScheduler = makeScheduler({ buildProvider: async () => hangingProvider })
    const { taskId } = await owningScheduler.start(taskInput())
    const record = await taskStore.get(taskId)
    // The original (still in-flight, permanently stuck) dispatch keeps
    // writing admission-hold bookkeeping to the checkpoint right up until
    // it actually reaches the hanging provider call, after which nothing
    // further ever mutates it again. Wait for the revision to stop moving
    // — a stronger, race-free signal than any single field, since it can't
    // be observed "true" a half-write early the way e.g. modelSteps.length
    // can.
    let previousRevision: number | undefined
    await waitUntil(async () => {
      const cp = await runStore.load(record.currentRunId)
      if (!cp.ok) return false
      const stable =
        cp.checkpoint.revision === previousRevision && cp.checkpoint.modelSteps.length > 0
      previousRevision = cp.checkpoint.revision
      return stable
    })

    const loaded = await runStore.load(record.currentRunId)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const observer = makeScheduler()
    const { continueBackgroundOrSubagentRun } = await import("../runs/run-recovery-orchestrator")
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
