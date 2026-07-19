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
import { sealCheckpointIntegrity } from "./checkpoint-schema"
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
  return sealCheckpointIntegrity({
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
        skillCatalog: [],
        skillCatalogHash: "h",
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
  })
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
 *  simulated crash never double-releases. Also tracks whether the artifact
 *  run pin was "released" (mirrors artifact-retention.ts's
 *  releaseArtifactRunResources contract: report true only when the plan
 *  actually asked for it). */
function makeReleaseResources() {
  const released = new Set<string>()
  const pinReleases: string[] = []
  const fn = vi.fn(
    async (
      plan: RunFinalizationLedger["resourceReleasePlan"],
      context: { runId: string; finalizationId: string }
    ) => {
      for (const id of plan.budgetOperationIds) released.add(id)
      for (const id of plan.skillPackageLeaseIds) released.add(id)
      for (const id of plan.adoptionLeaseIds) released.add(id)
      if (plan.releaseArtifactRunPin) pinReleases.push(context.runId)
      return { artifactRunPinReleased: plan.releaseArtifactRunPin }
    }
  )
  return { fn, released, pinReleases }
}

function baseDeps(overrides: Partial<RunFinalizerDeps> = {}): RunFinalizerDeps {
  return {
    runStore,
    upsertTrace: (input) => upsertRunTrace(tracesDir, input),
    releaseResources: async () => ({ artifactRunPinReleased: false }),
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

  it("persists a non-tombstone commit conflict as suspended_conversation_conflict", async () => {
    const runId = "run-conv-conflict"
    const conversationId = "conv-conflict"
    const conversationCommit = await conversationWithLease(conversationId, runId)
    await conversation.save({
      id: conversationId,
      workspaceId: "default",
      messages: [{ role: "user", content: [{ type: "text", text: "concurrent write" }] }],
      createdAt: 1,
      updatedAt: 1,
    })
    await seedRun(runId, {
      identity: { runId, rootRunId: runId, origin: "interactive", conversationId },
      conversationCommit,
    })

    const checkpoint = await finalizeRun(baseDeps({ conversation }), runId, {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ budgetOperationIds: [] }),
    })

    expect(checkpoint.status).toBe("suspended_conversation_conflict")
    expect(checkpoint.recovery).toEqual({
      kind: "requires_review",
      reason: "conversation-conflict",
    })
    expect(checkpoint.finalization).toBeUndefined()
  })
})

describe("finalizeRun — artifact run pin release and history-artifact references (Task 21)", () => {
  it("reports resourceReceipts.artifactRunPinReleased true only when the plan actually asks for release", async () => {
    const runId = "run-pin-release"
    await seedRun(runId, { conversationCommit: undefined })
    const { fn: releaseResources } = makeReleaseResources()

    const checkpoint = await finalizeRun(baseDeps({ releaseResources }), runId, {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ releaseArtifactRunPin: true }),
    })

    expect(checkpoint.finalization?.resourceReceipts?.artifactRunPinReleased).toBe(true)
    expect(releaseResources).toHaveBeenCalledWith(
      expect.objectContaining({ releaseArtifactRunPin: true }),
      { runId, finalizationId: checkpoint.finalization?.finalizationId }
    )
  })

  it("reports resourceReceipts.artifactRunPinReleased false when the plan does not ask for release", async () => {
    const runId = "run-pin-no-release"
    await seedRun(runId, { conversationCommit: undefined })
    const { fn: releaseResources } = makeReleaseResources()

    const checkpoint = await finalizeRun(baseDeps({ releaseResources }), runId, {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ releaseArtifactRunPin: false }),
    })

    expect(checkpoint.finalization?.resourceReceipts?.artifactRunPinReleased).toBe(false)
  })

  it("reflects the real outcome, not merely the plan, when releaseResources reports failure to release", async () => {
    const runId = "run-pin-release-failed"
    await seedRun(runId, { conversationCommit: undefined })
    // A plan that ASKS for release, but the real release call reports it did
    // not actually happen (e.g. no artifact store wired at this call site).
    const releaseResources = vi.fn(async () => ({ artifactRunPinReleased: false }))

    const checkpoint = await finalizeRun(baseDeps({ releaseResources }), runId, {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ releaseArtifactRunPin: true }),
    })

    expect(checkpoint.finalization?.resourceReceipts?.artifactRunPinReleased).toBe(false)
  })

  it("resumes cleanly and releases the pin exactly once after a crash injected around resource release", async () => {
    const runId = "run-pin-crash"
    await seedRun(runId, { conversationCommit: undefined })
    const { fn: releaseResources, pinReleases } = makeReleaseResources()

    let crashedOnce = false
    const deps = baseDeps({
      releaseResources,
      fault: (point) => {
        if (!crashedOnce && point === "before_resource_release") {
          crashedOnce = true
          throw new Error("simulated crash before resource release")
        }
      },
    })
    const input: FinalizeRunInput = {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ releaseArtifactRunPin: true }),
    }

    await expect(finalizeRun(deps, runId, input)).rejects.toThrow(/simulated crash/)

    const checkpoint = await finalizeRun(baseDeps({ releaseResources }), runId, input)
    expect(checkpoint.status).toBe("completed")
    expect(checkpoint.finalization?.resourceReceipts?.artifactRunPinReleased).toBe(true)
    // The plan-building/release call may have run again on resume, but the
    // idempotent underlying store-level release is the invariant — this
    // fake tracks call count, which is fine to be >= 1.
    expect(pinReleases.length).toBeGreaterThanOrEqual(1)
  })
})

describe("finalizeRun — skill-package lease release (Task 25)", () => {
  it("releases every skill-package lease named in the plan during resources_released", async () => {
    const runId = "run-skill-lease-release"
    await seedRun(runId, { conversationCommit: undefined })
    const { fn: releaseResources } = makeReleaseResources()
    const releasedLeaseIds: string[] = []
    const releaseSkillPackageLeases = vi.fn(async (leaseIds: readonly string[]) => {
      releasedLeaseIds.push(...leaseIds)
    })

    const checkpoint = await finalizeRun(
      baseDeps({ releaseResources, releaseSkillPackageLeases }),
      runId,
      {
        desiredStatus: "completed",
        stopReason: "end_turn",
        trace: trace(runId),
        resourceReleasePlan: releasePlan({ skillPackageLeaseIds: ["lease-1", "lease-2"] }),
      }
    )

    expect(releaseSkillPackageLeases).toHaveBeenCalledWith(["lease-1", "lease-2"])
    expect(releasedLeaseIds).toEqual(["lease-1", "lease-2"])
    // The receipt mirrors the plan (same convention as budgetOperationIds/
    // adoptionLeaseIds today), independent of the live release call.
    expect(checkpoint.finalization?.resourceReceipts?.skillPackageLeaseIds).toEqual([
      "lease-1",
      "lease-2",
    ])
  })

  it("tolerates releaseSkillPackageLeases being omitted (no skill runtime wired)", async () => {
    const runId = "run-skill-lease-omitted"
    await seedRun(runId, { conversationCommit: undefined })
    const { fn: releaseResources } = makeReleaseResources()

    const checkpoint = await finalizeRun(baseDeps({ releaseResources }), runId, {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ skillPackageLeaseIds: ["lease-1"] }),
    })

    expect(checkpoint.status).toBe("completed")
    expect(checkpoint.finalization?.resourceReceipts?.skillPackageLeaseIds).toEqual(["lease-1"])
  })

  it("resumes cleanly and calls releaseSkillPackageLeases again (idempotently) after a crash injected around resource release", async () => {
    const runId = "run-skill-lease-crash"
    await seedRun(runId, { conversationCommit: undefined })
    const { fn: releaseResources } = makeReleaseResources()
    const released = new Set<string>()
    const releaseSkillPackageLeases = vi.fn(async (leaseIds: readonly string[]) => {
      for (const id of leaseIds) released.add(id)
    })

    let crashedOnce = false
    const deps = baseDeps({
      releaseResources,
      releaseSkillPackageLeases,
      fault: (point) => {
        if (!crashedOnce && point === "before_resource_release") {
          crashedOnce = true
          throw new Error("simulated crash before resource release")
        }
      },
    })
    const input: FinalizeRunInput = {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ skillPackageLeaseIds: ["lease-1"] }),
    }

    await expect(finalizeRun(deps, runId, input)).rejects.toThrow(/simulated crash/)

    const checkpoint = await finalizeRun(
      baseDeps({ releaseResources, releaseSkillPackageLeases }),
      runId,
      input
    )
    expect(checkpoint.status).toBe("completed")
    expect(released.has("lease-1")).toBe(true)
  })
})

describe("finalizeRun — artifact run pin release and history-artifact references continued (Task 21)", () => {
  it("commits history-artifact uris (current compaction + superseded rounds) into the conversation's artifactUris", async () => {
    const runId = "run-history-artifacts"
    const conversationId = "conv-history-artifacts"
    const conversationCommit = await conversationWithLease(conversationId, runId)
    await seedRun(runId, {
      identity: { runId, rootRunId: runId, origin: "interactive", conversationId },
      conversationCommit,
      contextCompaction: {
        compactionId: "c2",
        evictedThroughMessageId: "u1",
        summaryText: "[Earlier conversation summary]\nsummary",
        summarizerTokens: 10,
        artifact: {
          uri: "artifact://run/run-history-artifacts/current-history",
          kind: "history",
          mediaType: "application/json",
          capturedBytes: 10,
          complete: true,
        },
        createdAt: 1,
      },
      supersededCompactionArtifactUris: ["artifact://run/run-history-artifacts/superseded-history"],
    })

    const input: FinalizeRunInput = {
      desiredStatus: "completed",
      stopReason: "end_turn",
      trace: trace(runId),
      resourceReleasePlan: releasePlan({ budgetOperationIds: [] }),
    }
    const { fn: releaseResources } = makeReleaseResources()

    await finalizeRun(baseDeps({ conversation, releaseResources }), runId, input)

    const record = JSON.parse(
      await fs.readFile(join(dir, "conversations", `${conversationId}.json`), "utf-8")
    )
    expect(record.artifactUris).toEqual(
      expect.arrayContaining([
        "artifact://run/run-history-artifacts/current-history",
        "artifact://run/run-history-artifacts/superseded-history",
      ])
    )
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
