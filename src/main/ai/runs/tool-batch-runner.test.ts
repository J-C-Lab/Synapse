import type { AgentRunEvent } from "@synapse/agent-protocol"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { AgentArtifactRef, AgentArtifactStore } from "../artifacts/artifact-types"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { RunEventEmitter } from "./run-event-emitter"
import type { ToolBatchDeps, ToolBatchFaultPoint } from "./tool-batch-runner"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactStore } from "../artifacts/artifact-store"
import { AiToolRegistry, NON_STREAMING_EMERGENCY_CAP_CHARS } from "../tool-registry"
import { AgentRunStore } from "./agent-run-store"
import { freezeToolAuthority } from "./authority-snapshot"
import { sealCheckpointIntegrity } from "./checkpoint-schema"
import { advanceToolBatch } from "./tool-batch-runner"

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

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-tool-batch-"))
  runStore = new AgentRunStore(join(dir, "runs"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function makeArtifactStore(): ArtifactStore {
  return new ArtifactStore(join(dir, "artifacts"), { statDiskSpace: ampleDisk })
}

function toolDescriptor(
  name: string,
  overrides: Partial<RegisteredToolDescriptor> = {}
): RegisteredToolDescriptor {
  return {
    // provenance "host" sanitizes fqName -> safeName by replacing non-word
    // chars with "_" (see tool-registry.ts's sanitizeToolName); keeping
    // fqName identical to the plain name here keeps safeName === fqName ===
    // name, so the assistant tool_use blocks below (seeded with the plain
    // name) resolve through registry.describe() without a prefix mismatch.
    fqName: name,
    pluginId: "host",
    provenance: "host",
    manifestTool: {
      name,
      description: `desc ${name}`,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    ...overrides,
  }
}

/** Mirrors production authority-freezing (setupInteractiveRun et al.):
 *  every tool the registry currently reports becomes a frozen authority
 *  entry, derived through the exact same freezeToolAuthority the real
 *  dispatch/approval/invoke identity check (P1-5) compares against — so a
 *  test's checkpoint fixture and its live registry are guaranteed
 *  consistent unless the test deliberately swaps the registry afterward. */
function authorityToolsFor(registry: AiToolRegistry) {
  return registry
    .listWithDescriptors()
    .map(({ schema, descriptor }) =>
      freezeToolAuthority({ descriptor, safeName: schema.name, modelSchema: schema })
    )
}

function checkpointWithAssistantToolCalls(
  runId: string,
  calls: Array<{ id: string; name: string; input: unknown }>,
  registry: AiToolRegistry
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
        tools: authorityToolsFor(registry),
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
      {
        messageId: "a1",
        producedByRunId: runId,
        message: {
          role: "assistant",
          content: calls.map((c) => ({
            type: "tool_use" as const,
            id: c.id,
            name: c.name,
            input: c.input,
          })),
        },
      },
    ],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    nextStep: 1,
    modelSteps: [
      {
        step: 0,
        acceptedAttemptId: "attempt-1",
        attempts: [
          {
            attemptId: "attempt-1",
            requestHash: "h",
            state: "budget_settled",
            assistantMessageId: "a1",
            admission: {
              operationId: "op-1",
              accountId: "root",
              estimatorId: "byte-upper-bound",
              estimatorVersion: "1",
              inputUpperBoundTokens: 10,
              maxOutputTokens: 256,
              heldTokens: 0,
              state: "settled",
            },
          },
        ],
      },
    ],
    toolBatches: [],
    activatedSkills: [],
  })
}

function toolHost(handlers: Record<string, (input: unknown) => Promise<unknown> | unknown>) {
  const invoke = vi.fn(async (fqName: string, input: unknown, _options: ToolInvocationOptions) => {
    const handler = handlers[fqName]
    if (!handler) throw new Error(`no handler for ${fqName}`)
    const value = await handler(input)
    return { content: [{ type: "text" as const, text: String(value) }] }
  })
  return { invoke }
}

function makeRegistry(
  names: string[],
  handlers: Record<string, (input: unknown) => Promise<unknown> | unknown>,
  annotations: RegisteredToolDescriptor["manifestTool"]["annotations"] = { readOnlyHint: true }
) {
  const descriptors = names.map((name) =>
    toolDescriptor(name, {
      manifestTool: {
        name,
        description: `desc ${name}`,
        inputSchema: { type: "object" },
        annotations,
      },
    })
  )
  const host = toolHost(handlers)
  const registry = new AiToolRegistry({
    listTools: () => descriptors,
    invokeTool: (fqName, input, options) => host.invoke(fqName, input, options),
  })
  registry.list() // populate the safeName map
  return { registry, invoke: host.invoke }
}

function baseDeps(registry: AiToolRegistry, overrides: Partial<ToolBatchDeps> = {}): ToolBatchDeps {
  return {
    runStore,
    tools: registry,
    caller: { kind: "agent" },
    requestApproval: async () => ({ allowed: true, remember: "once" }),
    now: () => 1000,
    ...overrides,
  }
}

async function seed(
  runId: string,
  registry: AiToolRegistry,
  calls: Array<{ id: string; name: string; input: unknown }>
): Promise<void> {
  await runStore.create(checkpointWithAssistantToolCalls(runId, calls, registry))
}

describe("advanceToolBatch — happy path", () => {
  it("creates the whole ledger up front, resolves an auto-allowed read-only call, and materializes one ordered result message", async () => {
    const runId = "run-1"
    const { registry, invoke } = makeRegistry(["read_file"], { read_file: () => "contents" })
    await seed(runId, registry, [{ id: "t1", name: "read_file", input: { path: "a.txt" } }])

    const outcome = await advanceToolBatch(baseDeps(registry), runId, 0)

    expect(outcome.kind).toBe("materialized")
    const batch = outcome.checkpoint.toolBatches[0]!
    expect(batch.calls).toHaveLength(1)
    expect(batch.calls[0]?.resolution.status).toBe("resolved")
    expect(batch.materializedAtRevision).toBeDefined()
    expect(invoke).toHaveBeenCalledTimes(1)

    const resultMessage = outcome.checkpoint.messages.find(
      (m) => m.messageId === batch.resultCarrierMessageId
    )
    expect(resultMessage?.message.role).toBe("user")
    expect(resultMessage?.message.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "t1",
        content: expect.stringContaining("contents"),
        isError: false,
      },
    ])
  })

  it("processes three tools in provider order and materializes exactly one carrier message covering all three", async () => {
    const runId = "run-2"
    const { registry } = makeRegistry(["a", "b", "c"], { a: () => "A", b: () => "B", c: () => "C" })
    await seed(runId, registry, [
      { id: "t1", name: "a", input: {} },
      { id: "t2", name: "b", input: {} },
      { id: "t3", name: "c", input: {} },
    ])

    const outcome = await advanceToolBatch(baseDeps(registry), runId, 0)
    expect(outcome.kind).toBe("materialized")
    const batch = outcome.checkpoint.toolBatches[0]!
    expect(batch.calls.map((c) => c.ordinal)).toEqual([0, 1, 2])
    const resultMessage = outcome.checkpoint.messages.find(
      (m) => m.messageId === batch.resultCarrierMessageId
    )!
    expect(
      resultMessage.message.content.map((b) => (b as { toolUseId: string }).toolUseId)
    ).toEqual(["t1", "t2", "t3"])
  })
})

describe("advanceToolBatch — onToolCall/onToolResult event hooks", () => {
  it("fires onToolCall once per call in order right after batch creation", async () => {
    const runId = "run-events-1"
    const { registry } = makeRegistry(["a", "b"], { a: () => "A", b: () => "B" })
    await seed(runId, registry, [
      { id: "t1", name: "a", input: { x: 1 } },
      { id: "t2", name: "b", input: { y: 2 } },
    ])
    const calls: Array<{ id: string; name: string; input: unknown }> = []

    await advanceToolBatch(baseDeps(registry, { onToolCall: (c) => calls.push(c) }), runId, 0)

    expect(calls).toEqual([
      { id: "t1", name: "a", input: { x: 1 } },
      { id: "t2", name: "b", input: { y: 2 } },
    ])
  })

  it("does not re-fire onToolCall for an already-created batch on resume", async () => {
    const runId = "run-events-2"
    const { registry } = makeRegistry(["a"], { a: () => "A" })
    await seed(runId, registry, [{ id: "t1", name: "a", input: {} }])
    const calls: unknown[] = []

    await advanceToolBatch(baseDeps(registry, { onToolCall: (c) => calls.push(c) }), runId, 0)
    await advanceToolBatch(baseDeps(registry, { onToolCall: (c) => calls.push(c) }), runId, 0)

    expect(calls).toHaveLength(1)
  })

  it("fires onToolResult once per call as each resolves, whether executed or denied", async () => {
    const runId = "run-events-3"
    const { registry } = makeRegistry(["a", "denied"], {
      a: () => "A",
      denied: () => "should not run",
    })
    await seed(runId, registry, [
      { id: "t1", name: "a", input: {} },
      { id: "t2", name: "denied", input: {} },
    ])
    const results: Array<{ id: string; isError: boolean }> = []

    await advanceToolBatch(
      baseDeps(registry, {
        onToolResult: (r) => results.push(r),
        resolver: (input) => (input.safeName === "denied" ? "deny" : undefined),
      }),
      runId,
      0
    )

    expect(results).toEqual([
      { id: "t1", isError: false },
      { id: "t2", isError: true },
    ])
  })
})

describe("advanceToolBatch — executionAuditDecision", () => {
  it("passes 'allow' for an auto-allowed (never-asked) call", async () => {
    const { registry, invoke } = makeRegistry(["read_file"], { read_file: () => "contents" })
    await seed("run-audit-1", registry, [{ id: "t1", name: "read_file", input: {} }])

    await advanceToolBatch(baseDeps(registry), "run-audit-1", 0)

    expect(invoke).toHaveBeenCalledWith(
      "read_file",
      {},
      expect.objectContaining({ executionAuditDecision: "allow" })
    )
  })

  it("passes 'approved' for a call that was actually asked and allowed", async () => {
    const descriptor = toolDescriptor("ask_me", {
      manifestTool: {
        name: "ask_me",
        description: "d",
        inputSchema: { type: "object" },
        annotations: {},
      },
    })
    const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
    const registry = new AiToolRegistry({ listTools: () => [descriptor], invokeTool: invoke })
    registry.list()
    await seed("run-audit-2", registry, [{ id: "t1", name: "ask_me", input: {} }])

    await advanceToolBatch(
      baseDeps(registry, { requestApproval: async () => ({ allowed: true, remember: "once" }) }),
      "run-audit-2",
      0
    )

    expect(invoke).toHaveBeenCalledWith(
      "ask_me",
      {},
      expect.objectContaining({ executionAuditDecision: "approved" })
    )
  })
})

describe("advanceToolBatch — cancellation", () => {
  it("forwards deps.signal into the tool invocation so a live cancel can interrupt it", async () => {
    const { registry, invoke } = makeRegistry(["read_file"], { read_file: () => "contents" })
    await seed("run-signal-1", registry, [{ id: "t1", name: "read_file", input: {} }])
    const controller = new AbortController()

    await advanceToolBatch(baseDeps(registry, { signal: controller.signal }), "run-signal-1", 0)

    expect(invoke).toHaveBeenCalledWith(
      "read_file",
      {},
      expect.objectContaining({ signal: controller.signal })
    )
  })
})

describe("advanceToolBatch — denial/policy without execution", () => {
  it("resolves a policy-denied call synthetically with no execution attempt", async () => {
    const runId = "run-3"
    const { registry, invoke } = makeRegistry(["dangerous"], { dangerous: () => "should not run" })
    await seed(runId, registry, [{ id: "t1", name: "dangerous", input: {} }])

    const outcome = await advanceToolBatch(baseDeps(registry, { resolver: () => "deny" }), runId, 0)

    expect(outcome.kind).toBe("materialized")
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.resolution).toMatchObject({ status: "resolved", reason: "policy-denied" })
    expect(call.attempts).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("resolves a human-denied call synthetically with no execution attempt", async () => {
    const runId = "run-4"
    const descriptor = toolDescriptor("writeish", {
      manifestTool: {
        name: "writeish",
        description: "d",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true },
      },
    })
    const invoke = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }))
    const registryWithDestructive = new AiToolRegistry({
      listTools: () => [descriptor],
      invokeTool: invoke,
    })
    registryWithDestructive.list()
    await seed(runId, registryWithDestructive, [{ id: "t1", name: "writeish", input: {} }])

    const outcome = await advanceToolBatch(
      baseDeps(registryWithDestructive, {
        requestApproval: async () => ({ allowed: false, remember: "once" }),
      }),
      runId,
      0
    )

    expect(outcome.kind).toBe("materialized")
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.resolution).toMatchObject({ status: "resolved", reason: "approval-denied" })
    expect(call.attempts).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("advanceToolBatch — approval persistence", () => {
  it("persists a stable approval id before prompting, reused verbatim if resumed while pending", async () => {
    const runId = "run-5"
    const descriptor = toolDescriptor("ask_me", {
      manifestTool: {
        name: "ask_me",
        description: "d",
        inputSchema: { type: "object" },
        annotations: {},
      },
    })
    const registry = new AiToolRegistry({
      listTools: () => [descriptor],
      invokeTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    })
    registry.list()
    await seed(runId, registry, [{ id: "t1", name: "ask_me", input: {} }])

    const seenApprovalIds: string[] = []
    await advanceToolBatch(
      baseDeps(registry, {
        requestApproval: async (approvalId) => {
          seenApprovalIds.push(approvalId)
          return { allowed: true, remember: "once" }
        },
        fault: (point: ToolBatchFaultPoint) => {
          if (point === "after_approval_pending")
            throw new Error("simulated crash before prompt resolves")
        },
      }),
      runId,
      0
    ).catch(() => {})

    const midCheckpoint = await runStore.load(runId)
    if (!midCheckpoint.ok) throw new Error("expected ok checkpoint")
    const pendingApproval = midCheckpoint.checkpoint.toolBatches[0]?.calls[0]?.approval
    expect(pendingApproval?.status).toBe("pending")
    const approvalId =
      pendingApproval && pendingApproval.status === "pending"
        ? pendingApproval.approvalId
        : undefined
    expect(approvalId).toBeDefined()

    // Resuming must re-emit the exact same approval id, not a new one.
    await advanceToolBatch(
      baseDeps(registry, {
        requestApproval: async (id) => {
          seenApprovalIds.push(id)
          return { allowed: true, remember: "once" }
        },
      }),
      runId,
      0
    )
    expect(seenApprovalIds).toEqual([approvalId])
  })
})

describe("advanceToolBatch — three-tool crash matrix", () => {
  const boundaries: ToolBatchFaultPoint[] = [
    "after_batch_created",
    "after_approval_resolved",
    "after_attempt_started",
    "after_attempt_completed",
    "after_materialized",
  ]

  for (const boundary of boundaries) {
    it(`resumes correctly after a crash at "${boundary}" without replaying a completed call`, async () => {
      const runId = `run-crash-${boundary}`
      const calls: string[] = []
      // Unannotated tools default to "ask" (see approval-gate.ts), so every
      // call in this matrix actually exercises the approval boundary too.
      const { registry } = makeRegistry(
        ["a", "b", "c"],
        {
          a: () => {
            calls.push("a")
            return "A"
          },
          b: () => {
            calls.push("b")
            return "B"
          },
          c: () => {
            calls.push("c")
            return "C"
          },
        },
        {}
      )
      await seed(runId, registry, [
        { id: "t1", name: "a", input: {} },
        { id: "t2", name: "b", input: {} },
        { id: "t3", name: "c", input: {} },
      ])

      let crashedOnce = false
      const deps = baseDeps(registry, {
        fault: (point) => {
          if (!crashedOnce && point === boundary) {
            crashedOnce = true
            throw new Error(`simulated crash at ${boundary}`)
          }
        },
      })

      await expect(advanceToolBatch(deps, runId, 0)).rejects.toThrow(/simulated crash/)

      // Resume with a fresh deps object (no more injected faults).
      const outcome = await advanceToolBatch(baseDeps(registry), runId, 0)

      if (boundary === "after_attempt_started") {
        // A "started, no completion" attempt with a "none"-guarantee adapter
        // (every current adapter) can never be safely resumed automatically
        // — the tool might already have run its side effects. The honestly
        // safe recovery is suspension, not a silent re-run (design §crash
        // recovery table: "tool started, no completion, any other case ...
        // Set suspended_unknown_tool_outcome").
        expect(outcome.kind).toBe("suspended_unknown_tool_outcome")
        // The interrupted call's tool adapter must never actually be
        // invoked during recovery — no execution happens at all.
        expect(calls).toEqual([])
        const batch = outcome.checkpoint.toolBatches[0]!
        expect(batch.calls[0]!.attempts[0]!.state.status).toBe("unknown")
        expect(outcome.checkpoint.status).toBe("suspended_unknown_tool_outcome")
        return
      }

      expect(outcome.kind).toBe("materialized")

      // Every tool that had already completed before the crash must never
      // run again; every tool must run at most once overall.
      const counts = calls.reduce<Record<string, number>>((acc, name) => {
        acc[name] = (acc[name] ?? 0) + 1
        return acc
      }, {})
      expect(Object.values(counts).every((n) => n === 1)).toBe(true)
      expect(new Set(calls)).toEqual(new Set(["a", "b", "c"]))

      if (outcome.kind !== "materialized") throw new Error("expected materialized")
      const batch = outcome.checkpoint.toolBatches[0]!
      expect(batch.calls.every((c) => c.resolution.status === "resolved")).toBe(true)
      expect(batch.materializedAtRevision).toBeDefined()
    })
  }
})

describe("advanceToolBatch — unknown tool outcome suspension", () => {
  it("suspends the batch when recovery cannot determine a started attempt's outcome", async () => {
    const runId = "run-unknown"
    const descriptor = toolDescriptor("flaky")
    const registry = new AiToolRegistry({
      listTools: () => [descriptor],
      invokeTool: async () => {
        throw new Error("should not be called during recovery")
      },
    })
    registry.list()
    await seed(runId, registry, [{ id: "t1", name: "flaky", input: {} }])

    // Manually park the checkpoint in a "started, never completed" state to
    // simulate an interrupted attempt from a prior process.
    const loaded = await runStore.load(runId)
    if (!loaded.ok) throw new Error("expected ok checkpoint")
    await runStore.mutate(runId, loaded.checkpoint.revision, (cp) => ({
      ...cp,
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "carrier-1",
          calls: [
            {
              ordinal: 0,
              toolUseId: "t1",
              safeName: "flaky",
              fqName: "flaky",
              input: {},
              annotations: { readOnlyHint: true },
              replayGuarantee: "none",
              approval: { status: "resolved", allowed: true, remember: "once", resolvedAt: 1 },
              attempts: [
                {
                  attemptId: "attempt-x",
                  invocationId: "inv-x",
                  invocationFingerprint: "fp-x",
                  state: { status: "started", startedAt: 1 },
                },
              ],
              resolution: { status: "unresolved" },
            },
          ],
        },
      ],
    }))

    const outcome = await advanceToolBatch(baseDeps(registry), runId, 0)
    expect(outcome.kind).toBe("suspended_unknown_tool_outcome")
    if (outcome.kind !== "suspended_unknown_tool_outcome") throw new Error("expected suspension")
    expect(outcome.ordinal).toBe(0)
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.attempts[0]?.state.status).toBe("unknown")
    expect(call.resolution.status).toBe("unresolved")
  })
})

describe("advanceToolBatch — durable event emission", () => {
  it("emits tool_requested then tool_started/tool_completed for an auto-allowed call", async () => {
    const runId = "run-events-1"
    const { registry } = makeRegistry(["read_file"], { read_file: () => "contents" })
    await seed(runId, registry, [{ id: "t1", name: "read_file", input: { path: "a.txt" } }])
    const emitter = fakeEmitter()

    await advanceToolBatch(baseDeps(registry, { eventEmitter: emitter }), runId, 0)

    expect(emitter.events.map((e) => e.type)).toEqual([
      "tool_requested",
      "tool_started",
      "tool_completed",
    ])
    expect(emitter.events[0]).toMatchObject({
      type: "tool_requested",
      modelStep: 0,
      ordinal: 0,
      toolUseId: "t1",
      safeName: "read_file",
    })
    expect(emitter.events[2]).toMatchObject({
      type: "tool_completed",
      ordinal: 0,
      toolUseId: "t1",
      isError: false,
      complete: true,
    })
  })

  it("emits approval_pending then approval_resolved(allowed: false) for a denied confirmation-required call", async () => {
    const runId = "run-events-2"
    const { registry } = makeRegistry(
      ["write_file"],
      { write_file: () => "ok" },
      { requiresConfirmation: true }
    )
    await seed(runId, registry, [{ id: "t1", name: "write_file", input: {} }])
    const emitter = fakeEmitter()

    await advanceToolBatch(
      baseDeps(registry, {
        eventEmitter: emitter,
        requestApproval: async () => ({ allowed: false, remember: "once" }),
      }),
      runId,
      0
    )

    expect(emitter.events.map((e) => e.type)).toEqual([
      "tool_requested",
      "approval_pending",
      "approval_resolved",
    ])
    expect(emitter.events[2]).toMatchObject({
      type: "approval_resolved",
      allowed: false,
      remember: "once",
    })
    // Denied without ever executing — there's no attempt/attemptId to
    // report, so no tool_completed is emitted for this call.
    expect(emitter.events.some((e) => e.type === "tool_completed")).toBe(false)
  })

  it("never throws when eventEmitter is omitted (every existing caller keeps working)", async () => {
    const runId = "run-events-3"
    const { registry } = makeRegistry(["read_file"], { read_file: () => "contents" })
    await seed(runId, registry, [{ id: "t1", name: "read_file", input: {} }])
    const outcome = await advanceToolBatch(baseDeps(registry), runId, 0)
    expect(outcome.kind).toBe("materialized")
  })
})

describe("advanceToolBatch — frozen tool authority identity (P1-5)", () => {
  it("refuses to approve a call whose live tool identity no longer matches what the run's authority froze", async () => {
    const runId = "run-drift-approval"
    const { registry } = makeRegistry(["ask_me"], { ask_me: () => "ok" }, {})
    await seed(runId, registry, [{ id: "t1", name: "ask_me", input: {} }])

    // Simulates a plugin update landing between the model's tool call and
    // this call's approval/execution: same safeName, different schema —
    // the exact "live safeName now resolves to a different tool" case the
    // frozen-authority identity check exists to catch.
    const driftedRegistry = new AiToolRegistry({
      listTools: () => [
        toolDescriptor("ask_me", {
          manifestTool: {
            name: "ask_me",
            description: "a completely different tool now",
            inputSchema: { type: "object", properties: { extra: { type: "string" } } },
            annotations: {},
          },
        }),
      ],
      invokeTool: async () => ({ content: [{ type: "text" as const, text: "should not run" }] }),
    })
    driftedRegistry.list()

    const outcome = await advanceToolBatch(baseDeps(driftedRegistry), runId, 0)

    expect(outcome.kind).toBe("materialized")
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.resolution).toMatchObject({ status: "resolved", reason: "invalid-tool-call" })
    expect(call.attempts).toEqual([])
  })

  it("refuses to execute a call whose live tool identity no longer matches what the run's authority froze", async () => {
    const runId = "run-drift-execution"
    const { registry, invoke } = makeRegistry(
      ["read_file"],
      { read_file: () => "contents" },
      {
        readOnlyHint: true,
      }
    )
    await seed(runId, registry, [{ id: "t1", name: "read_file", input: {} }])

    const driftedRegistry = new AiToolRegistry({
      listTools: () => [
        toolDescriptor("read_file", {
          manifestTool: {
            name: "read_file",
            description: "desc read_file",
            inputSchema: { type: "object" },
            // Annotation drift alone (readOnlyHint dropped) is enough to
            // change the frozen identity hash.
            annotations: {},
          },
        }),
      ],
      invokeTool: invoke,
    })
    driftedRegistry.list()

    const outcome = await advanceToolBatch(baseDeps(driftedRegistry), runId, 0)

    expect(outcome.kind).toBe("materialized")
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.resolution).toMatchObject({ status: "resolved", reason: "invalid-tool-call" })
    expect(invoke).not.toHaveBeenCalled()
  })

  it("still executes normally when the live tool is byte-for-byte identical to what was frozen", async () => {
    const runId = "run-no-drift"
    const { registry, invoke } = makeRegistry(["read_file"], { read_file: () => "contents" })
    await seed(runId, registry, [{ id: "t1", name: "read_file", input: {} }])

    const outcome = await advanceToolBatch(baseDeps(registry), runId, 0)

    expect(outcome.kind).toBe("materialized")
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.resolution).toMatchObject({ status: "resolved", reason: "executed" })
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

describe("advanceToolBatch — artifact offload (Task 19)", () => {
  it("captures an oversized result as an artifact, persists the summary + full ref, and materializes the pointer", async () => {
    const runId = "run-artifact-1"
    const bigOutput = "line-content ".repeat(2000)
    const { registry } = makeRegistry(["big"], { big: () => bigOutput })
    await seed(runId, registry, [{ id: "t1", name: "big", input: {} }])
    const store = makeArtifactStore()

    const outcome = await advanceToolBatch(
      baseDeps(registry, {
        caller: { kind: "agent", runId },
        artifactCapture: { store, captureThresholdChars: 100 },
      }),
      runId,
      0
    )

    expect(outcome.kind).toBe("materialized")
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.resolution.status).toBe("resolved")
    if (call.resolution.status !== "resolved") throw new Error("expected resolved")
    expect(call.resolution.result.complete).toBe(true)
    expect(call.resolution.result.artifact).toBeDefined()
    expect(call.resolution.result.artifact?.kind).toBe("tool-result")
    expect(call.resolution.result.artifact?.complete).toBe(true)
    expect(call.resolution.fullArtifact).toBeDefined()
    expect(call.resolution.fullArtifact?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(call.resolution.fullArtifact?.uri).toBe(call.resolution.result.artifact?.uri)
    // The preview handed to the model is bounded, not the full 26,000-char
    // output — proves the artifact path actually replaced the naive slice.
    expect(call.resolution.result.preview.length).toBeLessThan(bigOutput.length)

    const batch = outcome.checkpoint.toolBatches[0]!
    const resultMessage = outcome.checkpoint.messages.find(
      (m) => m.messageId === batch.resultCarrierMessageId
    )!
    const block = resultMessage.message.content[0] as { artifact?: AgentArtifactRef }
    expect(block.artifact?.uri).toBe(call.resolution.fullArtifact?.uri)
    expect(block.artifact?.sha256).toBe(call.resolution.fullArtifact?.sha256)

    // Independently readable back through the store — proves this is a
    // real capture, not a stubbed-out ref.
    const readBack = await store.read(
      call.resolution.fullArtifact!,
      { start: 0 },
      {
        runId,
        rootRunId: runId,
        principal: { kind: "internal-agent" },
      }
    )
    expect(new TextDecoder().decode(readBack)).toBe(bigOutput)
  })

  it("keeps a small result inline with no artifact even when artifactCapture is wired", async () => {
    const runId = "run-artifact-2"
    const { registry } = makeRegistry(["small"], { small: () => "tiny output" })
    await seed(runId, registry, [{ id: "t1", name: "small", input: {} }])
    const store = makeArtifactStore()

    const outcome = await advanceToolBatch(
      baseDeps(registry, {
        caller: { kind: "agent", runId },
        artifactCapture: { store },
      }),
      runId,
      0
    )

    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    if (call.resolution.status !== "resolved") throw new Error("expected resolved")
    expect(call.resolution.result.artifact).toBeUndefined()
    expect(call.resolution.fullArtifact).toBeUndefined()
    expect(call.resolution.result.complete).toBe(true)
    expect(call.resolution.result.preview).toContain("tiny output")
  })

  it("falls back to a bounded inline preview (no artifact) when the caller carries no runId", async () => {
    const runId = "run-artifact-3"
    const bigOutput = "no-run-context ".repeat(3000)
    const { registry } = makeRegistry(["big"], { big: () => bigOutput })
    await seed(runId, registry, [{ id: "t1", name: "big", input: {} }])
    const store = makeArtifactStore()

    const outcome = await advanceToolBatch(
      baseDeps(registry, {
        // No runId on the caller — mirrors execution-tool-host.ts's own
        // "no run to scope a durable artifact under" rule.
        caller: { kind: "agent" },
        artifactCapture: { store, captureThresholdChars: 100 },
      }),
      runId,
      0
    )

    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    if (call.resolution.status !== "resolved") throw new Error("expected resolved")
    expect(call.resolution.result.artifact).toBeUndefined()
    expect(call.resolution.fullArtifact).toBeUndefined()
    expect(call.resolution.result.complete).toBe(false)
    expect(call.resolution.result.preview.length).toBeLessThan(bigOutput.length)
  })

  it("falls back to captureThresholdChars derived from maxToolResultChars when artifactCapture doesn't set one", async () => {
    const runId = "run-artifact-4"
    const output = "x".repeat(500)
    const { registry } = makeRegistry(["mid"], { mid: () => output })
    await seed(runId, registry, [{ id: "t1", name: "mid", input: {} }])
    const store = makeArtifactStore()

    const outcome = await advanceToolBatch(
      baseDeps(registry, {
        caller: { kind: "agent", runId },
        artifactCapture: { store },
        maxToolResultChars: 100,
      }),
      runId,
      0
    )

    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    if (call.resolution.status !== "resolved") throw new Error("expected resolved")
    expect(call.resolution.result.artifact).toBeDefined()
  })

  it("captures the artifact before persisting the checkpoint mutation that references it", async () => {
    const runId = "run-artifact-order"
    const bigOutput = "ordered-content ".repeat(2000)
    const { registry } = makeRegistry(["big"], { big: () => bigOutput })
    await seed(runId, registry, [{ id: "t1", name: "big", input: {} }])

    const order: string[] = []
    const realStore = makeArtifactStore()
    const spyingStore: AgentArtifactStore = {
      capture: async (...args) => {
        const ref = await realStore.capture(...args)
        order.push("capture")
        return ref
      },
      stat: (...args) => realStore.stat(...args),
      read: (...args) => realStore.read(...args),
      resolve: (...args) => realStore.resolve(...args),
      releaseRunPin: (...args) => realStore.releaseRunPin(...args),
      collectEligible: (...args) => realStore.collectEligible(...args),
    }
    // AgentRunStore.mutate is a real method on a real instance — spy on it
    // to observe exactly when the resolved-executed checkpoint write lands
    // relative to the artifact capture recorded above.
    const originalMutate = runStore.mutate.bind(runStore)
    let recordedExecutedWrite = false
    vi.spyOn(runStore, "mutate").mockImplementation(async (rId, revision, mutator) => {
      const result = await originalMutate(rId, revision, mutator)
      const resolution = result.toolBatches[0]?.calls[0]?.resolution
      // Only the FIRST mutation that lands with this call already resolved
      // as "executed" is the write we're timing — a later mutation (e.g.
      // materializeBatch's own, which doesn't touch `calls` at all) would
      // still see the same already-resolved state and must not be double
      // -counted here.
      if (
        !recordedExecutedWrite &&
        resolution?.status === "resolved" &&
        resolution.reason === "executed"
      ) {
        recordedExecutedWrite = true
        order.push("checkpoint-executed-write")
      }
      return result
    })

    await advanceToolBatch(
      baseDeps(registry, {
        caller: { kind: "agent", runId },
        artifactCapture: { store: spyingStore, captureThresholdChars: 100 },
      }),
      runId,
      0
    )

    expect(order).toEqual(["capture", "checkpoint-executed-write"])
  })

  it("never reports complete: true for a result the non-streaming emergency cap already truncated, even though the (already-capped) text offloads successfully in full", async () => {
    const runId = "run-emergency-cap-chain"
    // Larger than tool-registry.ts's NON_STREAMING_EMERGENCY_CAP_CHARS
    // (2_000_000) — AiToolRegistry.invoke() truncates this BEFORE
    // tool-batch-runner.ts ever sees it, exactly like a runaway
    // plugin/MCP adapter would produce.
    const oversized = "e".repeat(NON_STREAMING_EMERGENCY_CAP_CHARS + 1000)
    const { registry } = makeRegistry(["huge"], { huge: () => oversized })
    await seed(runId, registry, [{ id: "t1", name: "huge", input: {} }])
    const store = makeArtifactStore()

    const outcome = await advanceToolBatch(
      baseDeps(registry, {
        caller: { kind: "agent", runId },
        // A low threshold so the (already emergency-capped) text still
        // gets offloaded to a real artifact, well within the store's ~64
        // MiB per-artifact ceiling — the whole point of this test is that
        // a fully successful offload of the truncated text must NOT be
        // allowed to launder it back into `complete: true`.
        artifactCapture: { store, captureThresholdChars: 100 },
      }),
      runId,
      0
    )

    expect(outcome.kind).toBe("materialized")
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    if (call.resolution.status !== "resolved") throw new Error("expected resolved")
    expect(call.resolution.result.isError).toBe(true)
    expect(call.resolution.result.complete).toBe(false)
    expect(call.resolution.result.preview).toMatch(/non-streaming buffering cap/)

    const batch = outcome.checkpoint.toolBatches[0]!
    const resultMessage = outcome.checkpoint.messages.find(
      (m) => m.messageId === batch.resultCarrierMessageId
    )!
    const block = resultMessage.message.content[0] as { isError?: boolean }
    expect(block.isError).toBe(true)
  })
})
