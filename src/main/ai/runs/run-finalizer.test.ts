import type { AgentRunEvent } from "@synapse/agent-protocol"
import type { RunTrace } from "../run-trace-store"
import type { AgentRunCheckpointV1, RunFinalizationLedger } from "./checkpoint-schema"
import type { RunEventEmitter } from "./run-event-emitter"
import type { FinalizeRunInput, RunFinalizerDeps, RunFinalizerFaultPoint } from "./run-finalizer"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationStore } from "../conversation-store"
import { getRunTrace, upsertRunTrace } from "../run-trace-store"
import { AgentRunStore } from "./agent-run-store"
import { finalizeRun } from "./run-finalizer"

function fakeEmitter(): RunEventEmitter & { events: AgentRunEvent[] } {
  const events: AgentRunEvent[] = []
  return {
    events,
    async emit(input) {
      events.push({ ...input } as AgentRunEvent)
    },
  }
}

let dir: string
let runStore: AgentRunStore
let conversation: ConversationStore
let tracesDir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-run-finalizer-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  conversation = new ConversationStore(join(dir, "conversations"), () => 1000)
  tracesDir = join(dir, "traces")
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function baseCheckpoint(
  runId: string,
  overrides: Partial<AgentRunCheckpointV1> = {}
): AgentRunCheckpointV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    identity: { runId, rootRunId: runId, origin: "interactive" },
    status: "running",
    recovery: { kind: "automatic" },
    createdAt: 1,
    updatedAt: 1,
    config: {
      schemaVersion: 1,
      providerId: "fake",
      model: "fake-model",
      resolvedProfile: {
        profileId: "p1",
        providerId: "fake",
        modelPattern: "*",
        contextWindowTokens: 100_000,
        defaultMaxOutputTokens: 1024,
        supportsPromptCaching: false,
        supportsParallelToolCalls: false,
        supportsReasoningStream: false,
        tokenBudgeting: {
          upperBoundEstimatorId: "byte-upper-bound",
          upperBoundEstimatorVersion: "1",
          providerFramingReserveTokens: 10,
        },
        contextPolicy: {
          summarizeAtFraction: 0.75,
          keepRecentFraction: 0.5,
          hardReserveTokens: 100,
        },
      },
      maxOutputTokens: 256,
      runBudgetTokens: 10_000,
      maxSteps: 10,
      contextCompression: {
        enabled: false,
        thresholdTokens: 0,
        keepRecentFraction: 0.5,
        hardReserveTokens: 0,
      },
      workspaceBinding: { bindingRevision: 0, rootIds: [], rootSetHash: "h" },
      authority: {
        schemaVersion: 1,
        principal: { kind: "interactive", actor: "user" },
        capabilities: [],
        tools: [],
        integrityHash: "h",
      },
      context: {
        schemaVersion: 1,
        baseSystemPrompt: { normalizedText: "You are helpful.", sha256: "h" },
        workspaceInstructions: [],
        aggregateHash: "h",
      },
    },
    messages: [
      { messageId: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    nextStep: 1,
    modelSteps: [],
    toolBatches: [],
    activatedSkills: [],
    ...overrides,
  }
}

function trace(runId: string, overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId,
    origin: "interactive",
    startedAt: 1,
    endedAt: 2,
    outcome: "end_turn",
    toolCalls: [],
    ...overrides,
  }
}

function releasePlan(
  overrides: Partial<RunFinalizationLedger["resourceReleasePlan"]> = {}
): RunFinalizationLedger["resourceReleasePlan"] {
  return {
    budgetOperationIds: ["budget-op-1"],
    skillPackageLeaseIds: [],
    releaseArtifactRunPin: false,
    adoptionLeaseIds: [],
    ...overrides,
  }
}

/** Tracks releases idempotently by operation id, like the real budget
 *  ledger's release/forfeit operations do — so a retried call after a
 *  simulated crash never double-releases. */
function makeReleaseResources() {
  const released = new Set<string>()
  const fn = vi.fn(async (plan: RunFinalizationLedger["resourceReleasePlan"]) => {
    for (const id of plan.budgetOperationIds) released.add(id)
    for (const id of plan.skillPackageLeaseIds) released.add(id)
    for (const id of plan.adoptionLeaseIds) released.add(id)
  })
  return { fn, released }
}

function baseDeps(overrides: Partial<RunFinalizerDeps> = {}): RunFinalizerDeps {
  return {
    runStore,
    upsertTrace: (input) => upsertRunTrace(tracesDir, input),
    releaseResources: async () => {},
    now: () => 5000,
    ...overrides,
  }
}

async function seedRun(
  runId: string,
  overrides: Partial<AgentRunCheckpointV1> = {}
): Promise<void> {
  await runStore.create(baseCheckpoint(runId, overrides))
}

/** Creates a conversation and hands back the lease fields a checkpoint's
 *  `conversationCommit` needs to match — mirrors what the interactive-chat
 *  driver (Task 13) will populate when it acquires a run lease. */
async function conversationWithLease(
  conversationId: string,
  runId: string
): Promise<AgentRunCheckpointV1["conversationCommit"]> {
  await conversation.save({
    id: conversationId,
    workspaceId: "ws",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })
  const { fencingToken, deletionEpoch } = await conversation.acquireRunLease(
    conversationId,
    0,
    runId
  )
  return { baseContentRevision: 0, leaseFencingToken: fencingToken, deletionEpoch }
}

describe("finalizeRun — no conversation (background run)", () => {
  it("skips commit/lease-release, upserts the trace, releases resources, and reaches the desired terminal status", async () => {
    const runId = "run-bg-1"
    await seedRun(runId)
    const { fn: releaseResources, released } = makeReleaseResources()
    const input: FinalizeRunInput = {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan(),
    }

    const checkpoint = await finalizeRun(baseDeps({ releaseResources }), runId, input)

    expect(checkpoint.status).toBe("completed")
    expect(checkpoint.finalization?.phase).toBe("complete")
    expect(checkpoint.finalization?.conversationReceipt).toEqual({
      status: "skipped",
      reason: "no-conversation",
    })
    expect(checkpoint.finalization?.leaseReleaseRevision).toBeUndefined()
    expect(checkpoint.finalization?.traceUpsertRevision).toBe(1)
    expect(getRunTrace(tracesDir, runId)?.outcome).toBe("end_turn")
    expect(released).toEqual(new Set(["budget-op-1"]))
  })
})

describe("finalizeRun — bound to a conversation", () => {
  it("commits the conversation, releases its lease, and completes", async () => {
    const runId = "run-conv-1"
    const conversationId = "conv-1"
    const conversationCommit = await conversationWithLease(conversationId, runId)
    await seedRun(runId, {
      identity: { runId, rootRunId: runId, origin: "interactive", conversationId },
      conversationCommit,
    })

    const input: FinalizeRunInput = {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan(),
    }
    const { fn: releaseResources } = makeReleaseResources()

    const checkpoint = await finalizeRun(baseDeps({ conversation, releaseResources }), runId, input)

    expect(checkpoint.status).toBe("completed")
    expect(checkpoint.finalization?.conversationReceipt).toEqual({
      status: "committed",
      contentRevision: 1,
    })
    expect(checkpoint.finalization?.leaseReleaseRevision).toBeDefined()

    const stored = await conversation.get(conversationId)
    expect(stored?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
  })

  it("skips commit when the conversation was tombstoned before finalization ran", async () => {
    const runId = "run-conv-tombstoned"
    const conversationId = "conv-tombstoned"
    const conversationCommit = await conversationWithLease(conversationId, runId)
    await conversation.tombstone(conversationId, 0)
    await seedRun(runId, {
      identity: { runId, rootRunId: runId, origin: "interactive", conversationId },
      conversationCommit,
    })

    const input: FinalizeRunInput = {
      desiredStatus: "cancelled",
      stopReason: "aborted",
      trace: trace(runId, { outcome: "aborted" }),
      resourceReleasePlan: releasePlan({ budgetOperationIds: [] }),
    }
    const { fn: releaseResources } = makeReleaseResources()

    const checkpoint = await finalizeRun(baseDeps({ conversation, releaseResources }), runId, input)

    expect(checkpoint.status).toBe("cancelled")
    expect(checkpoint.finalization?.conversationReceipt).toEqual({
      status: "skipped",
      reason: "conversation-tombstoned",
    })
    expect(checkpoint.finalization?.leaseReleaseRevision).toBeUndefined()
  })
})

describe("finalizeRun — idempotent resume across every phase boundary", () => {
  const boundaries: RunFinalizerFaultPoint[] = [
    "before_prepare",
    "after_prepared",
    "before_conversation_commit",
    "after_conversation_committed",
    "before_trace_upsert",
    "after_trace_upserted",
    "before_resource_release",
    "after_resources_released",
    "before_lease_release",
    "after_lease_released",
    "before_complete",
    "after_complete",
  ]

  for (const boundary of boundaries) {
    it(`resumes to exactly one commit/trace/release after a crash at "${boundary}"`, async () => {
      const runId = `run-crash-${boundary}`
      const conversationId = `conv-crash-${boundary}`
      const conversationCommit = await conversationWithLease(conversationId, runId)
      await seedRun(runId, {
        identity: { runId, rootRunId: runId, origin: "interactive", conversationId },
        conversationCommit,
      })

      const { fn: releaseResources, released } = makeReleaseResources()
      const commitRunSpy = vi.spyOn(conversation, "commitRun")
      const releaseLeaseSpy = vi.spyOn(conversation, "releaseRunLease")

      const input: FinalizeRunInput = {
        desiredStatus: "completed",
        stopReason: "end_turn",
        trace: trace(runId),
        resourceReleasePlan: releasePlan(),
      }

      let crashedOnce = false
      const deps = baseDeps({
        conversation,
        releaseResources,
        fault: (point) => {
          if (!crashedOnce && point === boundary) {
            crashedOnce = true
            throw new Error(`simulated crash at ${boundary}`)
          }
        },
      })

      await expect(finalizeRun(deps, runId, input)).rejects.toThrow(/simulated crash/)

      // Resume with fresh deps (no fault injected) and the same logical
      // input — finalizeRun must not need the caller to remember anything.
      const checkpoint = await finalizeRun(
        baseDeps({ conversation, releaseResources }),
        runId,
        input
      )

      expect(checkpoint.status).toBe("completed")
      expect(checkpoint.finalization?.phase).toBe("complete")

      // Whatever the retry count (commitRun/releaseRunLease may each have
      // been called once or twice depending on exactly when the simulated
      // crash landed), exactly one committed conversation revision, one
      // trace revision, and one effective release per operation id must
      // have resulted — the store-level idempotency, not the call count,
      // is the invariant under test.
      expect(commitRunSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(releaseLeaseSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(checkpoint.finalization?.conversationReceipt).toEqual({
        status: "committed",
        contentRevision: 1,
      })
      expect(checkpoint.finalization?.traceUpsertRevision).toBe(1)
      expect(released).toEqual(new Set(["budget-op-1"]))

      const stored = await conversation.get(conversationId)
      expect(stored?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])

      commitRunSpy.mockRestore()
      releaseLeaseSpy.mockRestore()
    })
  }
})

describe("finalizeRun — invalid transitions", () => {
  it("refuses to finalize a run whose status cannot reach terminalizing", async () => {
    const runId = "run-already-terminal"
    await seedRun(runId, { status: "completed" })
    const input: FinalizeRunInput = {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ budgetOperationIds: [] }),
    }
    await expect(finalizeRun(baseDeps(), runId, input)).rejects.toThrow(/invalid transition/)
  })
})

describe("finalizeRun — durable event emission", () => {
  it("emits run_status_changed, one finalization_phase_updated per phase, and run_completed on a normal completion", async () => {
    const runId = "run-events-1"
    await seedRun(runId, { conversationCommit: undefined })
    const emitter = fakeEmitter()
    const input: FinalizeRunInput = {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ budgetOperationIds: [] }),
    }

    await finalizeRun(baseDeps({ eventEmitter: emitter }), runId, input)

    expect(emitter.events.map((e) => e.type)).toEqual([
      "run_status_changed",
      "finalization_phase_updated",
      "finalization_phase_updated",
      "finalization_phase_updated",
      "finalization_phase_updated",
      "finalization_phase_updated",
      "finalization_phase_updated",
      "run_status_changed",
      "run_completed",
    ])
    const phases = emitter.events
      .filter((e) => e.type === "finalization_phase_updated")
      .map((e) => (e.type === "finalization_phase_updated" ? e.phase : undefined))
    expect(phases).toEqual([
      "prepared",
      "conversation_committed",
      "trace_upserted",
      "resources_released",
      "conversation_lease_released",
      "complete",
    ])
    expect(emitter.events[0]).toMatchObject({ type: "run_status_changed", status: "terminalizing" })
    expect(emitter.events[7]).toMatchObject({ type: "run_status_changed", status: "completed" })
  })

  it("emits run_failed with the desired status as outcome for a cancelled run", async () => {
    const runId = "run-events-2"
    await seedRun(runId, { conversationCommit: undefined })
    const emitter = fakeEmitter()
    const input: FinalizeRunInput = {
      desiredStatus: "cancelled",
      stopReason: "aborted",
      trace: trace(runId, { outcome: "aborted" }),
      resourceReleasePlan: releasePlan({ budgetOperationIds: [] }),
    }

    await finalizeRun(baseDeps({ eventEmitter: emitter }), runId, input)

    const last = emitter.events.at(-1)
    expect(last).toMatchObject({ type: "run_failed", outcome: "cancelled", reason: "aborted" })
  })

  it("never throws when eventEmitter is omitted (every existing caller keeps working)", async () => {
    const runId = "run-events-3"
    await seedRun(runId, { conversationCommit: undefined })
    const input: FinalizeRunInput = {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ budgetOperationIds: [] }),
    }
    await expect(finalizeRun(baseDeps(), runId, input)).resolves.toMatchObject({
      status: "completed",
    })
  })
})
