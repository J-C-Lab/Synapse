import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { ToolBatchDeps, ToolBatchFaultPoint } from "./tool-batch-runner"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AiToolRegistry } from "../tool-registry"
import { AgentRunStore } from "./agent-run-store"
import { advanceToolBatch } from "./tool-batch-runner"

let dir: string
let runStore: AgentRunStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-tool-batch-"))
  runStore = new AgentRunStore(join(dir, "runs"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

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

function checkpointWithAssistantToolCalls(
  runId: string,
  calls: Array<{ id: string; name: string; input: unknown }>
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
  }
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
  calls: Array<{ id: string; name: string; input: unknown }>
): Promise<void> {
  await runStore.create(checkpointWithAssistantToolCalls(runId, calls))
}

describe("advanceToolBatch — happy path", () => {
  it("creates the whole ledger up front, resolves an auto-allowed read-only call, and materializes one ordered result message", async () => {
    const runId = "run-1"
    const { registry, invoke } = makeRegistry(["read_file"], { read_file: () => "contents" })
    await seed(runId, [{ id: "t1", name: "read_file", input: { path: "a.txt" } }])

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
    await seed(runId, [
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
    await seed(runId, [
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
    await seed(runId, [{ id: "t1", name: "a", input: {} }])
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
    await seed(runId, [
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
    await seed("run-audit-1", [{ id: "t1", name: "read_file", input: {} }])

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
    await seed("run-audit-2", [{ id: "t1", name: "ask_me", input: {} }])

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
    await seed("run-signal-1", [{ id: "t1", name: "read_file", input: {} }])
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
    await seed(runId, [{ id: "t1", name: "dangerous", input: {} }])

    const outcome = await advanceToolBatch(baseDeps(registry, { resolver: () => "deny" }), runId, 0)

    expect(outcome.kind).toBe("materialized")
    const call = outcome.checkpoint.toolBatches[0]!.calls[0]!
    expect(call.resolution).toMatchObject({ status: "resolved", reason: "policy-denied" })
    expect(call.attempts).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("resolves a human-denied call synthetically with no execution attempt", async () => {
    const runId = "run-4"
    await seed(runId, [{ id: "t1", name: "writeish", input: {} }])
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
    await seed(runId, [{ id: "t1", name: "ask_me", input: {} }])

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
      await seed(runId, [
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
    await seed(runId, [{ id: "t1", name: "flaky", input: {} }])

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
