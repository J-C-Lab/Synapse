import type { RecoveryDecision } from "../ai/runs/agent-run-recovery-service"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ArtifactStore } from "../ai/artifacts/artifact-store"
import {
  ConversationConflictUnresumableError,
  RecoveryBlockedError,
  RecoveryDecisionRequiredError,
} from "../ai/runs/agent-run-recovery-service"
import { AgentRunStore } from "../ai/runs/agent-run-store"
import { sealCheckpointIntegrity } from "../ai/runs/checkpoint-schema"
import { RunEventStore } from "../ai/runs/run-event-store"
import {
  getArtifactStatus,
  normalizeArtifactPreviewQuery,
  normalizeArtifactUri,
  normalizeEventsSinceQuery,
  normalizeResumeQuery,
  normalizeRunListQuery,
  normalizeRunTraceForRenderer,
  readArtifactPreview,
  registerRunsIpc,
  toRunSummary,
} from "./runs"

function validRawTrace(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: "r1",
    origin: "interactive",
    outcome: "end_turn",
    startedAt: 1000,
    endedAt: 2000,
    conversationId: "c1",
    principal: { kind: "internal-agent" },
    toolCalls: [{ name: "probe", startedAt: 1100, ms: 40, ok: true }],
    ...overrides,
  }
}

describe("normalizeRunTraceForRenderer", () => {
  it("round-trips a well-formed trace with every field intact", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace())
    expect(result).toEqual({
      runId: "r1",
      origin: "interactive",
      outcome: "end_turn",
      startedAt: 1000,
      endedAt: 2000,
      conversationId: "c1",
      invocationId: undefined,
      parentRunId: undefined,
      workspaceId: undefined,
      triggerInstanceId: undefined,
      principal: { kind: "internal-agent" },
      toolCalls: [{ name: "probe", startedAt: 1100, ms: 40, ok: true }],
    })
  })

  it("normalizes toolCalls: null to an empty array instead of throwing", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace({ toolCalls: null }))
    expect(result?.toolCalls).toEqual([])
  })

  it("resolves undefined for an unrecognized origin or outcome", () => {
    expect(normalizeRunTraceForRenderer(validRawTrace({ origin: "bogus" }))).toBeUndefined()
    expect(normalizeRunTraceForRenderer(validRawTrace({ outcome: "bogus" }))).toBeUndefined()
  })

  it("drops an unrecognized top-level field instead of passing it through", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace({ secretField: "leak" }))
    expect(result).toBeDefined()
    expect(result).not.toHaveProperty("secretField")
  })

  it("drops one malformed toolCalls entry among valid ones, keeps the rest", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [
          { name: "good", startedAt: 1, ms: 1, ok: true },
          { name: "bad" },
          { name: "good2", startedAt: 2, ms: 2, ok: false },
        ],
      })
    )
    expect(result?.toolCalls.map((c) => c.name)).toEqual(["good", "good2"])
  })

  it("maps a toolCalls error outside the four-item allowlist to legacy-error", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [{ name: "t", startedAt: 1, ms: 1, ok: false, error: "ENOENT: /etc/passwd" }],
      })
    )
    expect(result?.toolCalls[0]?.error).toBe("legacy-error")
  })

  it("keeps an allowed error category unchanged", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({ toolCalls: [{ name: "t", startedAt: 1, ms: 1, ok: false, error: "denied" }] })
    )
    expect(result?.toolCalls[0]?.error).toBe("denied")
  })

  it("caps a plan step's title at 500 characters", () => {
    const longTitle = "x".repeat(1000)
    const result = normalizeRunTraceForRenderer(
      validRawTrace({ plan: [{ title: longTitle, status: "pending" }] })
    )
    expect(result?.plan?.[0]?.title.length).toBe(500)
  })

  it("drops a plan step with an unrecognized status", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        plan: [
          { title: "ok", status: "pending" },
          { title: "bad", status: "bogus" },
        ],
      })
    )
    expect(result?.plan?.map((s) => s.title)).toEqual(["ok"])
  })

  it("resolves undefined for a non-object value", () => {
    expect(normalizeRunTraceForRenderer(null)).toBeUndefined()
    expect(normalizeRunTraceForRenderer("a string")).toBeUndefined()
    expect(normalizeRunTraceForRenderer(42)).toBeUndefined()
  })

  it("resolves undefined when a required field is missing or wrongly typed", () => {
    expect(normalizeRunTraceForRenderer(validRawTrace({ runId: 123 }))).toBeUndefined()
    expect(
      normalizeRunTraceForRenderer(validRawTrace({ startedAt: "not a number" }))
    ).toBeUndefined()
  })
})

describe("toRunSummary", () => {
  it("maps every RendererRunTrace field and computes tool-call counts", () => {
    const trace = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [
          { name: "a", startedAt: 1, ms: 1, ok: true },
          { name: "b", startedAt: 2, ms: 1, ok: false },
          { name: "c", startedAt: 3, ms: 1, ok: false },
        ],
      })
    )!
    const summary = toRunSummary(trace)
    expect(summary.runId).toBe("r1")
    expect(summary.toolCallCount).toBe(3)
    expect(summary.failedToolCallCount).toBe(2)
    expect(summary.hasPlan).toBe(false)
  })

  it("hasPlan is true only for a non-empty plan", () => {
    const withPlan = normalizeRunTraceForRenderer(
      validRawTrace({ plan: [{ title: "step", status: "pending" }] })
    )!
    expect(toRunSummary(withPlan).hasPlan).toBe(true)
    const withEmptyPlan = normalizeRunTraceForRenderer(validRawTrace({ plan: [] }))!
    expect(toRunSummary(withEmptyPlan).hasPlan).toBe(false)
  })
})

describe("normalizeRunListQuery", () => {
  it("accepts undefined and an empty object, returning {}", () => {
    expect(normalizeRunListQuery(undefined)).toEqual({})
    expect(normalizeRunListQuery({})).toEqual({})
  })

  it("accepts a well-formed parentRunId", () => {
    expect(normalizeRunListQuery({ parentRunId: "r1" })).toEqual({ parentRunId: "r1" })
  })

  it("trims a parentRunId", () => {
    expect(normalizeRunListQuery({ parentRunId: "  r1  " })).toEqual({ parentRunId: "r1" })
  })

  it("rejects a non-string, blank, or over-200-char parentRunId", () => {
    expect(() => normalizeRunListQuery({ parentRunId: 123 })).toThrow()
    expect(() => normalizeRunListQuery({ parentRunId: "   " })).toThrow()
    expect(() => normalizeRunListQuery({ parentRunId: "x".repeat(201) })).toThrow()
  })

  it("rejects a non-object payload", () => {
    expect(() => normalizeRunListQuery("not an object")).toThrow("payload must be an object")
    expect(() => normalizeRunListQuery(42)).toThrow()
  })

  it("rejects an array", () => {
    expect(() => normalizeRunListQuery([])).toThrow("payload must be an object")
  })

  it("rejects a payload with an unrecognized key instead of silently returning {}", () => {
    expect(() => normalizeRunListQuery({ parentRunID: "typo" })).toThrow("unexpected field")
  })
})

describe("registerRunsIpc", () => {
  function fakeIpcMain() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    return {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn)
      },
      handlers,
    }
  }

  it("rejects an untrusted sender on both channels", () => {
    const ipcMain = fakeIpcMain()
    registerRunsIpc(ipcMain as never, "/tmp/does-not-matter", {} as never, {
      isTrustedSender: () => false,
    })
    expect(() => ipcMain.handlers.get("runs:list")?.({})).toThrow()
    expect(() => ipcMain.handlers.get("runs:get")?.({}, "r1")).toThrow()
  })

  it("runs:get with a path-traversal-shaped runId resolves undefined, not a thrown error", async () => {
    const ipcMain = fakeIpcMain()
    registerRunsIpc(ipcMain as never, "/tmp/does-not-matter", {} as never, {
      isTrustedSender: () => true,
    })
    await expect(
      Promise.resolve(ipcMain.handlers.get("runs:get")?.({}, "../escape"))
    ).resolves.toBeUndefined()
  })
})

describe("normalizeEventsSinceQuery", () => {
  it("accepts a well-formed payload", () => {
    expect(normalizeEventsSinceQuery({ runId: "r1", afterSequence: 3 })).toEqual({
      runId: "r1",
      afterSequence: 3,
    })
  })

  it("rejects a negative or non-integer afterSequence", () => {
    expect(() => normalizeEventsSinceQuery({ runId: "r1", afterSequence: -1 })).toThrow()
    expect(() => normalizeEventsSinceQuery({ runId: "r1", afterSequence: 1.5 })).toThrow()
  })
})

describe("normalizeResumeQuery", () => {
  it("accepts a payload with no decision", () => {
    expect(normalizeResumeQuery({ runId: "r1" })).toEqual({ runId: "r1", decision: undefined })
  })

  it("accepts a valid decision kind", () => {
    expect(normalizeResumeQuery({ runId: "r1", decision: { kind: "retry" } })).toEqual({
      runId: "r1",
      decision: { kind: "retry" },
    })
  })

  it("rejects an unrecognized decision kind", () => {
    expect(() => normalizeResumeQuery({ runId: "r1", decision: { kind: "bogus" } })).toThrow()
  })
})

describe("registerRunsIpc — durable endpoints", () => {
  function fakeIpcMain() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    return {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn)
      },
      handlers,
    }
  }

  let dir: string
  let runStore: AgentRunStore
  let eventStore: RunEventStore

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "synapse-runs-ipc-"))
    runStore = new AgentRunStore(join(dir, "runs"))
    eventStore = new RunEventStore(join(dir, "events"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function minimalCheckpoint(runId: string) {
    return sealCheckpointIntegrity({
      schemaVersion: 1 as const,
      revision: 0,
      identity: { runId, rootRunId: runId, origin: "interactive" as const },
      status: "running" as const,
      recovery: { kind: "automatic" as const },
      createdAt: 1,
      updatedAt: 2,
      config: {
        schemaVersion: 1 as const,
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
          schemaVersion: 1 as const,
          principal: { kind: "interactive", actor: "user" as const },
          capabilities: [],
          tools: [],
          integrityHash: "h",
        },
        context: {
          schemaVersion: 1 as const,
          baseSystemPrompt: { normalizedText: "hi", sha256: "h" },
          workspaceInstructions: [],
          aggregateHash: "h",
        },
      },
      messages: [],
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
    })
  }

  function fakeRecovery(overrides: {
    listRecoverable?: () => Promise<unknown[]>
    resume?: (runId: string, decision?: RecoveryDecision) => Promise<void>
    abandon?: (runId: string) => Promise<void>
  }) {
    return {
      listRecoverable: overrides.listRecoverable ?? (async () => []),
      resume: overrides.resume ?? (async () => {}),
      abandon: overrides.abandon ?? (async () => {}),
    }
  }

  function register(recovery: ReturnType<typeof fakeRecovery>) {
    const ipcMain = fakeIpcMain()
    registerRunsIpc(
      ipcMain as never,
      "/tmp/does-not-matter",
      { runStore, eventStore, recovery: recovery as never },
      { isTrustedSender: () => true }
    )
    return ipcMain
  }

  it("runs:getSnapshot projects a real checkpoint and the journal's last sequence", async () => {
    await runStore.create(minimalCheckpoint("run-1"))
    await eventStore.append("run-1", {
      schemaVersion: 1,
      eventId: "e1",
      runId: "run-1",
      rootRunId: "run-1",
      sequence: 1,
      timestamp: 1000,
      persisted: true,
      type: "run_started",
      origin: "interactive",
    })

    const ipcMain = register(fakeRecovery({}))
    const snapshot = await ipcMain.handlers.get("runs:getSnapshot")?.({}, "run-1")
    expect(snapshot).toMatchObject({ status: "running", lastSequence: 1 })
  })

  it("runs:getSnapshot resolves undefined for a run that doesn't exist", async () => {
    const ipcMain = register(fakeRecovery({}))
    const snapshot = await ipcMain.handlers.get("runs:getSnapshot")?.({}, "missing")
    expect(snapshot).toBeUndefined()
  })

  it("runs:getEventsSince returns only events after the given sequence", async () => {
    await eventStore.append("run-1", {
      schemaVersion: 1,
      eventId: "e1",
      runId: "run-1",
      rootRunId: "run-1",
      sequence: 1,
      timestamp: 1000,
      persisted: true,
      type: "run_started",
      origin: "interactive",
    })
    await eventStore.append("run-1", {
      schemaVersion: 1,
      eventId: "e2",
      runId: "run-1",
      rootRunId: "run-1",
      sequence: 2,
      timestamp: 1001,
      persisted: true,
      type: "run_completed",
      outcome: "completed",
    })

    const ipcMain = register(fakeRecovery({}))
    const events = await ipcMain.handlers.get("runs:getEventsSince")?.(
      {},
      { runId: "run-1", afterSequence: 1 }
    )
    expect((events as { type: string }[]).map((e) => e.type)).toEqual(["run_completed"])
  })

  it("runs:listRecoverable delegates to the recovery service", async () => {
    const ipcMain = register(fakeRecovery({ listRecoverable: async () => [{ runId: "r1" }] }))
    const result = await ipcMain.handlers.get("runs:listRecoverable")?.({})
    expect(result).toEqual([{ runId: "r1" }])
  })

  it("runs:resume returns ok:true on success", async () => {
    const ipcMain = register(fakeRecovery({}))
    const result = await ipcMain.handlers.get("runs:resume")?.({}, { runId: "r1" })
    expect(result).toEqual({ ok: true })
  })

  it("runs:resume maps RecoveryBlockedError to a typed blocked result", async () => {
    const ipcMain = register(
      fakeRecovery({
        resume: async () => {
          throw new RecoveryBlockedError("deadline-expired")
        },
      })
    )
    const result = await ipcMain.handlers.get("runs:resume")?.({}, { runId: "r1" })
    expect(result).toEqual({ ok: false, reason: "blocked", blockedReason: "deadline-expired" })
  })

  it("runs:resume maps RecoveryDecisionRequiredError to a typed decision_required result", async () => {
    const ipcMain = register(
      fakeRecovery({
        resume: async () => {
          throw new RecoveryDecisionRequiredError("tool-removed-or-changed")
        },
      })
    )
    const result = await ipcMain.handlers.get("runs:resume")?.({}, { runId: "r1" })
    expect(result).toEqual({
      ok: false,
      reason: "decision_required",
      reviewReason: "tool-removed-or-changed",
    })
  })

  it("runs:resume maps ConversationConflictUnresumableError to a typed result", async () => {
    const ipcMain = register(
      fakeRecovery({
        resume: async () => {
          throw new ConversationConflictUnresumableError("r1")
        },
      })
    )
    const result = await ipcMain.handlers.get("runs:resume")?.({}, { runId: "r1" })
    expect(result).toEqual({ ok: false, reason: "conversation_conflict_unresumable" })
  })

  it("runs:resume rethrows an unrecognized error rather than swallowing it", async () => {
    const ipcMain = register(
      fakeRecovery({
        resume: async () => {
          throw new Error("boom")
        },
      })
    )
    await expect(ipcMain.handlers.get("runs:resume")?.({}, { runId: "r1" })).rejects.toThrow("boom")
  })

  it("runs:abandon delegates to the recovery service", async () => {
    let calledWith: string | undefined
    const ipcMain = register(
      fakeRecovery({
        abandon: async (runId) => {
          calledWith = runId
        },
      })
    )
    await ipcMain.handlers.get("runs:abandon")?.({}, "r1")
    expect(calledWith).toBe("r1")
  })

  it("does not register artifact channels when no artifact store is wired", () => {
    const ipcMain = register(fakeRecovery({}))
    expect(ipcMain.handlers.has("runs:getArtifactStatus")).toBe(false)
    expect(ipcMain.handlers.has("runs:readArtifactPreview")).toBe(false)
    expect(ipcMain.handlers.has("runs:collectArtifactGarbage")).toBe(false)
  })

  it("registers artifact channels when an artifact store is wired", async () => {
    const artifactStore = new ArtifactStore(join(dir, "artifacts"), {
      statDiskSpace: async () => ({ freeBytes: 1e12, totalBytes: 1e12 }),
    })
    const ipcMain = fakeIpcMain()
    registerRunsIpc(
      ipcMain as never,
      "/tmp/does-not-matter",
      { runStore, eventStore, recovery: fakeRecovery({}) as never, artifactStore },
      { isTrustedSender: () => true }
    )
    expect(ipcMain.handlers.has("runs:getArtifactStatus")).toBe(true)
    expect(ipcMain.handlers.has("runs:readArtifactPreview")).toBe(true)
    expect(ipcMain.handlers.has("runs:collectArtifactGarbage")).toBe(true)

    const status = await ipcMain.handlers.get("runs:getArtifactStatus")?.(
      {},
      "artifact://run/never-existed/never-existed"
    )
    expect(status).toEqual({ status: "unavailable", code: "artifact_missing" })

    const gc = await ipcMain.handlers.get("runs:collectArtifactGarbage")?.({})
    expect(gc).toMatchObject({ deletedArtifacts: 0 })
  })
})

describe("normalizeArtifactUri", () => {
  it("requires a non-empty string", () => {
    expect(normalizeArtifactUri("artifact://run/r1/a1")).toBe("artifact://run/r1/a1")
    expect(() => normalizeArtifactUri(42)).toThrow()
  })
})

describe("normalizeArtifactPreviewQuery", () => {
  it("accepts a bare uri with no range", () => {
    expect(normalizeArtifactPreviewQuery({ uri: "artifact://run/r1/a1" })).toEqual({
      uri: "artifact://run/r1/a1",
    })
  })

  it("accepts an explicit start/end range", () => {
    expect(
      normalizeArtifactPreviewQuery({ uri: "artifact://run/r1/a1", range: { start: 0, end: 10 } })
    ).toEqual({ uri: "artifact://run/r1/a1", range: { start: 0, end: 10 } })
  })

  it("rejects a negative or non-integer range bound", () => {
    expect(() =>
      normalizeArtifactPreviewQuery({ uri: "artifact://run/r1/a1", range: { start: -1 } })
    ).toThrow(/non-negative integer/)
    expect(() =>
      normalizeArtifactPreviewQuery({ uri: "artifact://run/r1/a1", range: { end: 1.5 } })
    ).toThrow(/non-negative integer/)
  })

  it("rejects a non-object payload", () => {
    expect(() => normalizeArtifactPreviewQuery("nope")).toThrow(/payload must be an object/)
  })
})

describe("getArtifactStatus / readArtifactPreview (Task 21)", () => {
  let artDir: string
  let artifactStore: ArtifactStore

  beforeEach(async () => {
    artDir = await fs.mkdtemp(join(tmpdir(), "synapse-runs-ipc-artifacts-"))
    artifactStore = new ArtifactStore(artDir, {
      statDiskSpace: async () => ({ freeBytes: 1e12, totalBytes: 1e12 }),
    })
  })

  afterEach(async () => {
    await fs.rm(artDir, { recursive: true, force: true })
  })

  async function captureText(text: string) {
    return artifactStore.capture(
      new TextEncoder().encode(text),
      {
        runId: "run-1",
        owner: { runId: "run-1", rootRunId: "run-1", principal: { kind: "internal-agent" } },
        kind: "tool-result",
        mediaType: "text/plain",
      },
      { abort: () => {} }
    )
  }

  it("reports artifact_missing for a malformed uri", async () => {
    expect(await getArtifactStatus(artifactStore, "not-a-uri")).toEqual({
      status: "unavailable",
      code: "artifact_missing",
    })
    expect(await readArtifactPreview(artifactStore, "not-a-uri")).toEqual({
      status: "unavailable",
      code: "artifact_missing",
    })
  })

  it("reports available with a bounded summary for a real artifact", async () => {
    const ref = await captureText("hello artifact")
    const status = await getArtifactStatus(artifactStore, ref.uri)
    expect(status).toEqual({
      status: "available",
      summary: {
        uri: ref.uri,
        kind: "tool-result",
        mediaType: "text/plain",
        capturedBytes: ref.capturedBytes,
        complete: true,
        truncationReason: undefined,
      },
    })
  })

  it("reads a bounded text preview, defaulting to the whole (short) artifact", async () => {
    const ref = await captureText("hello artifact")
    const preview = await readArtifactPreview(artifactStore, ref.uri)
    expect(preview).toEqual({
      status: "available",
      content: "hello artifact",
      encoding: "utf-8",
      range: { start: 0, end: ref.capturedBytes },
      rangeClamped: false,
    })
  })

  it("respects an explicit byte range", async () => {
    const ref = await captureText("0123456789")
    const preview = await readArtifactPreview(artifactStore, ref.uri, { start: 2, end: 5 })
    expect(preview).toMatchObject({ status: "available", content: "234" })
  })

  it("reports artifact_expired (never artifact_missing) once retention deletes the bytes", async () => {
    const ref = await captureText("goodbye")
    const referenced = new ArtifactStore(artDir, {
      statDiskSpace: async () => ({ freeBytes: 1e12, totalBytes: 1e12 }),
      isArtifactReferenced: async () => false,
    })
    await referenced.releaseRunPin("run-1", "fin-1")
    await referenced.collectEligible()

    expect(await getArtifactStatus(artifactStore, ref.uri)).toMatchObject({
      status: "unavailable",
      code: "artifact_expired",
    })
    expect(await readArtifactPreview(artifactStore, ref.uri)).toMatchObject({
      status: "unavailable",
      code: "artifact_expired",
    })
  })
})
