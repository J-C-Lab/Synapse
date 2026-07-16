import type { RunTrace } from "../run-trace-store"
import type { CanonicalJson } from "./canonical-json"
import type {
  AgentRunCheckpointV1,
  RunFinalizationLedger,
  ToolCallLedgerEntry,
} from "./checkpoint-schema"
import type { RecoveryClassifierInput } from "./recovery-classifier"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { upsertRunTrace } from "../run-trace-store"
import {
  AgentRunRecoveryService,
  ConversationConflictUnresumableError,
  RecoveryBlockedError,
  RecoveryDecisionRequiredError,
} from "./agent-run-recovery-service"
import { AgentRunStore } from "./agent-run-store"
import { canonicalHash } from "./canonical-json"
import { sealCheckpointIntegrity } from "./checkpoint-schema"
import { finalizeRun } from "./run-finalizer"

let dir: string
let runStore: AgentRunStore
let tracesDir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-recovery-service-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  tracesDir = join(dir, "traces")
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function baseCheckpoint(
  runId: string,
  overrides: Partial<AgentRunCheckpointV1> = {}
): AgentRunCheckpointV1 {
  const baseSystemText = "You are helpful."
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
        tools: [
          {
            fqName: "read_file",
            safeName: "read_file",
            provenance: "host",
            ownerId: "synapse-host",
            ownerVersion: "0.2.0",
            modelSchemaHash: canonicalHash({
              name: "read_file",
              description: "read_file",
              inputSchema: { type: "object" },
            } as unknown as CanonicalJson),
            annotationsHash: canonicalHash({}),
            invocationAdapterId: "host-tool",
            invocationAdapterVersion: "1",
            replayGuarantee: "none",
          },
        ],
        integrityHash: "h",
      },
      context: {
        schemaVersion: 1,
        baseSystemPrompt: { normalizedText: baseSystemText, sha256: sha256(baseSystemText) },
        workspaceInstructions: [],
        aggregateHash: sha256(sha256(baseSystemText)),
      },
    },
    // Several recovery cases seed a suspended batch that references a1;
    // make that reference structurally valid rather than relying on the
    // old shape-only checkpoint validator.
    messages: [{ messageId: "a1", message: { role: "assistant", content: [] } }],
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
    outcome: "aborted",
    toolCalls: [],
    ...overrides,
  }
}

function releasePlan(): RunFinalizationLedger["resourceReleasePlan"] {
  return {
    budgetOperationIds: [],
    skillPackageLeaseIds: [],
    releaseArtifactRunPin: false,
    adoptionLeaseIds: [],
  }
}

async function seedRun(
  runId: string,
  overrides: Partial<AgentRunCheckpointV1> = {}
): Promise<void> {
  await runStore.create(baseCheckpoint(runId, overrides))
}

/** A same-shape classifier input builder: reuses the checkpoint's own
 *  authority as "current" (so classification is automatic by default)
 *  unless a test overrides `matches` to point elsewhere. */
function neverDriftingClassifierInput(
  overrides: Partial<RecoveryClassifierInput> = {}
): (checkpoint: AgentRunCheckpointV1) => Promise<RecoveryClassifierInput> {
  return async (checkpoint) => ({
    currentAuthority: checkpoint.config.authority,
    now: 100,
    ...overrides,
  })
}

function makeService(
  overrides: Partial<ConstructorParameters<typeof AgentRunRecoveryService>[0]> = {}
): AgentRunRecoveryService {
  return new AgentRunRecoveryService({
    runStore,
    buildClassifierInput: neverDriftingClassifierInput(),
    finalize: (runId, input) =>
      finalizeRun(
        {
          runStore,
          upsertTrace: (i) => upsertRunTrace(tracesDir, i),
          releaseResources: async () => {},
          now: () => 5000,
        },
        runId,
        input
      ),
    buildAbandonTrace: (checkpoint) => trace(checkpoint.identity.runId),
    buildAbandonResourcePlan: () => releasePlan(),
    now: () => 5000,
    ...overrides,
  })
}

function unresolvedCall(status: "started" | "unknown"): ToolCallLedgerEntry {
  return {
    ordinal: 0,
    toolUseId: "t1",
    safeName: "read_file",
    fqName: "read_file",
    input: {},
    annotations: {},
    replayGuarantee: "none",
    approval: { status: "not_required" },
    attempts: [
      {
        attemptId: "attempt-1",
        invocationId: "inv-1",
        invocationFingerprint: "fp-1",
        state:
          status === "started"
            ? { status: "started", startedAt: 1 }
            : { status: "unknown", startedAt: 1, reason: "process-exit" },
      },
    ],
    resolution: { status: "unresolved" },
  }
}

describe("agentRunRecoveryService.listRecoverable", () => {
  it("returns non-terminal runs with a freshly persisted disposition, skipping fully-finalized ones", async () => {
    await seedRun("running-1", { status: "running" })
    await seedRun("done-1", {
      status: "completed",
      finalization: {
        finalizationId: "f1",
        desiredStatus: "completed",
        phase: "complete",
        outcome: "end_turn",
        stopReason: "end_turn",
        endedAt: 2,
        trace: trace("done-1"),
        traceHash: canonicalHash(trace("done-1") as unknown as CanonicalJson),
        resourceReleasePlan: releasePlan(),
      },
    })

    const summaries = await makeService().listRecoverable()

    expect(summaries.map((s) => s.runId)).toEqual(["running-1"])
    expect(summaries[0]?.recovery).toEqual({ kind: "automatic" })
  })

  it("includes a terminal-status run whose finalization never completed", async () => {
    await seedRun("stuck-terminalizing", {
      status: "terminalizing",
      finalization: {
        finalizationId: "f1",
        desiredStatus: "completed",
        phase: "trace_upserted",
        outcome: "end_turn",
        stopReason: "end_turn",
        endedAt: 2,
        trace: trace("stuck-terminalizing"),
        traceHash: canonicalHash(trace("stuck-terminalizing") as unknown as CanonicalJson),
        resourceReleasePlan: releasePlan(),
      },
    })
    const summaries = await makeService().listRecoverable()
    expect(summaries.map((s) => s.runId)).toEqual(["stuck-terminalizing"])
  })

  it("persists a disposition change discovered during the scan", async () => {
    await seedRun("narrowed-1", { status: "waiting_approval" })
    const service = makeService({
      buildClassifierInput: async () => ({
        currentAuthority: {
          schemaVersion: 1,
          principal: { kind: "x", actor: "background" },
          capabilities: [],
          tools: [],
          integrityHash: "h",
        },
        now: 100,
      }),
    })
    const summaries = await service.listRecoverable()
    expect(summaries[0]?.recovery).toEqual({ kind: "blocked", reason: "authority-revoked" })

    const stored = await runStore.load("narrowed-1")
    if (!stored.ok) throw new Error("expected ok")
    expect(stored.checkpoint.recovery).toEqual({ kind: "blocked", reason: "authority-revoked" })
  })
})

describe("agentRunRecoveryService.resume — idempotent no-ops", () => {
  it("does nothing for an already-running run", async () => {
    await seedRun("r1", { status: "running" })
    await makeService().resume("r1")
    const loaded = await runStore.load("r1")
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.revision).toBe(1)
  })

  it("does nothing for an already-terminal run", async () => {
    await seedRun("r1", { status: "completed" })
    await makeService().resume("r1")
    const loaded = await runStore.load("r1")
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.revision).toBe(1)
  })
})

describe("agentRunRecoveryService.resume — automatic disposition", () => {
  it("clears waiting_approval back to running", async () => {
    await seedRun("r1", { status: "waiting_approval" })
    await makeService().resume("r1")
    const loaded = await runStore.load("r1")
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.status).toBe("running")
    expect(loaded.checkpoint.recovery).toEqual({ kind: "automatic" })
  })

  it("migrates a legacy background deadline before classification and blocks it when expired", async () => {
    const legacy = baseCheckpoint("background-expired")
    await runStore.create(
      sealCheckpointIntegrity({
        ...legacy,
        identity: { ...legacy.identity, origin: "background-agent" },
        createdAt: 1,
        updatedAt: 1,
        config: {
          ...legacy.config,
          backgroundExecution: { maxToolCallsPerRun: 2, timeoutMs: 10 },
        },
      })
    )

    const summaries = await makeService().listRecoverable()

    expect(summaries).toContainEqual(
      expect.objectContaining({
        runId: "background-expired",
        recovery: { kind: "blocked", reason: "deadline-expired" },
      })
    )
    const loaded = await runStore.load("background-expired")
    expect(loaded.ok && loaded.checkpoint.config.deadlineAt).toBe(11)
    expect(loaded.ok && loaded.checkpoint.backgroundExecutionLedger).toEqual({
      toolCallsConsumed: 0,
    })
    await expect(makeService().resume("background-expired")).rejects.toMatchObject({
      reason: "deadline-expired",
    })
  })
})

describe("agentRunRecoveryService.resume — blocked disposition", () => {
  it("throws RecoveryBlockedError and never mutates status", async () => {
    await seedRun("r1", { status: "waiting_approval" })
    const service = makeService({
      buildClassifierInput: async () => ({
        currentAuthority: {
          schemaVersion: 1,
          principal: { kind: "x", actor: "background" },
          capabilities: [],
          tools: [],
          integrityHash: "h",
        },
        now: 100,
      }),
    })
    await expect(service.resume("r1")).rejects.toThrow(RecoveryBlockedError)
    const loaded = await runStore.load("r1")
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.status).toBe("waiting_approval")
  })

  it("reclassifies an already-running legacy background checkpoint before allowing continuation", async () => {
    const legacy = baseCheckpoint("background-legacy")
    await runStore.create(
      sealCheckpointIntegrity({
        ...legacy,
        identity: { ...legacy.identity, origin: "background-agent" },
      })
    )

    await expect(makeService().resume("background-legacy")).rejects.toMatchObject({
      reason: "background-execution-policy-missing",
    })
    const loaded = await runStore.load("background-legacy")
    expect(loaded.ok && loaded.checkpoint.status).toBe("running")
    expect(loaded.ok && loaded.checkpoint.recovery).toEqual({
      kind: "blocked",
      reason: "background-execution-policy-missing",
    })
  })
})

describe("agentRunRecoveryService.resume — requires_review", () => {
  it("throws RecoveryDecisionRequiredError when no decision is supplied", async () => {
    await seedRun("r1", {
      status: "suspended_unknown_tool_outcome",
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "c1",
          calls: [unresolvedCall("unknown")],
        },
      ],
    })
    await expect(makeService().resume("r1")).rejects.toThrow(RecoveryDecisionRequiredError)
  })

  it("always requires abandon for conversation-conflict, even with a decision", async () => {
    await seedRun("r1", { status: "suspended_conversation_conflict" })
    await expect(makeService().resume("r1", { kind: "retry" })).rejects.toThrow(
      ConversationConflictUnresumableError
    )
  })

  it("records Retry on a running requires-review checkpoint without a running transition", async () => {
    await seedRun("r-running-review", { status: "running" })
    const service = makeService({
      buildClassifierInput: neverDriftingClassifierInput({
        currentWorkspaceRootSetHash: "changed",
      }),
    })

    await service.resume("r-running-review", { kind: "retry" })

    const loaded = await runStore.load("r-running-review")
    expect(loaded.ok && loaded.checkpoint.status).toBe("running")
    expect(loaded.ok && loaded.checkpoint.recovery).toEqual({ kind: "automatic" })
    expect(loaded.ok && loaded.checkpoint.revision).toBe(3)
  })

  it("records Mark failed on a running unknown-outcome review and resolves the call", async () => {
    await seedRun("r-running-unknown", {
      status: "running",
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "c1",
          calls: [unresolvedCall("unknown")],
        },
      ],
    })

    await makeService().resume("r-running-unknown", { kind: "mark_failed" })

    const loaded = await runStore.load("r-running-unknown")
    expect(loaded.ok && loaded.checkpoint.status).toBe("running")
    expect(loaded.ok && loaded.checkpoint.recovery).toEqual({ kind: "automatic" })
    expect(loaded.ok && loaded.checkpoint.toolBatches[0]?.calls[0]?.resolution).toMatchObject({
      reason: "user-marked-failed",
    })
  })

  it("mark_failed resolves the stuck call and clears the run back to running", async () => {
    await seedRun("r1", {
      status: "suspended_unknown_tool_outcome",
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "c1",
          calls: [unresolvedCall("unknown")],
        },
      ],
    })
    await makeService().resume("r1", { kind: "mark_failed" })

    const loaded = await runStore.load("r1")
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.status).toBe("running")
    const call = loaded.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.resolution).toMatchObject({ status: "resolved", reason: "user-marked-failed" })
  })

  it("retry clears the run back to running without touching the stuck call's ledger state", async () => {
    await seedRun("r1", {
      status: "suspended_unknown_tool_outcome",
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "c1",
          calls: [unresolvedCall("unknown")],
        },
      ],
    })
    await makeService().resume("r1", { kind: "retry" })

    const loaded = await runStore.load("r1")
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.status).toBe("running")
    const call = loaded.checkpoint.toolBatches[0]!.calls[0]!
    // Left exactly as-is: a fresh advanceToolBatch call is what actually
    // starts a new attempt, now that the run is unblocked.
    expect(call.resolution).toEqual({ status: "unresolved" })
    expect(call.attempts).toHaveLength(1)
    expect(call.attempts[0]?.state.status).toBe("unknown")
  })
})

describe("agentRunRecoveryService.abandon", () => {
  it("reconciles external run-scoped resources before isolating corrupt checkpoint evidence", async () => {
    const runId = "corrupt-r1"
    await fs.mkdir(join(dir, "runs", runId), { recursive: true })
    await fs.writeFile(join(dir, "runs", runId, "checkpoint.json"), "{broken", "utf-8")
    const reconciled: string[] = []

    await makeService({
      reconcileCorruptRun: async (id) => {
        reconciled.push(id)
      },
    }).abandon(runId)

    expect(reconciled).toEqual([runId])
    await expect(fs.access(join(dir, "runs", runId))).rejects.toThrow()
    const evidence = await fs.readdir(join(dir, "runs", ".abandoned"))
    expect(evidence).toHaveLength(1)
  })

  it("is a no-op for an already-terminal run", async () => {
    await seedRun("r1", { status: "cancelled" })
    const buildAbandonTrace = vi.fn(() => trace("r1"))
    await makeService({ buildAbandonTrace }).abandon("r1")
    expect(buildAbandonTrace).not.toHaveBeenCalled()
  })

  it("drives a fresh run to cancelled through the finalizer", async () => {
    await seedRun("r1", { status: "running" })
    await makeService().abandon("r1")
    const loaded = await runStore.load("r1")
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.status).toBe("cancelled")
    expect(loaded.checkpoint.finalization?.desiredStatus).toBe("cancelled")
    expect(loaded.checkpoint.finalization?.phase).toBe("complete")
  })

  it("continues an in-flight finalization using its own recorded desiredStatus, never inventing a new one", async () => {
    const abandonedTrace = trace("r1", { outcome: "error" })
    await seedRun("r1", {
      status: "terminalizing",
      finalization: {
        finalizationId: "f-existing",
        desiredStatus: "failed",
        phase: "trace_upserted",
        outcome: "error",
        stopReason: "provider-error",
        endedAt: 2,
        trace: abandonedTrace,
        // Must match what finalizeRun/upsertRunTrace would compute for this
        // exact trace, or a retry looks like a genuine hash mismatch.
        traceHash: canonicalHash(abandonedTrace as unknown as CanonicalJson),
        resourceReleasePlan: releasePlan(),
      },
    })

    const buildAbandonTrace = vi.fn(() => trace("r1"))
    await makeService({ buildAbandonTrace }).abandon("r1")

    expect(buildAbandonTrace).not.toHaveBeenCalled()
    const loaded = await runStore.load("r1")
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.status).toBe("failed")
  })
})
