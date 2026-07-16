import type { ChatProvider, ProviderRequest, ProviderStreamEvent } from "../providers/types"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRootBudgetLedger, RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { AgentRunStore } from "./agent-run-store"
import { sealCheckpointIntegrity } from "./checkpoint-schema"
import { advanceDurableRun } from "./durable-agent-driver"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-durable-driver-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function minimalCheckpoint(runId: string, maxSteps = 10): AgentRunCheckpointV1 {
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
      maxSteps,
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
      { messageId: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    nextStep: 0,
    modelSteps: [],
    toolBatches: [],
    activatedSkills: [],
  })
}

function fakeProvider(reply: ProviderStreamEvent & { type: "message" }): ChatProvider & {
  calls: ProviderRequest[]
} {
  const calls: ProviderRequest[] = []
  return {
    id: "fake",
    calls,
    descriptor: { providerId: "fake", estimatorId: "byte-upper-bound", estimatorVersion: "1" },
    estimateRequestUpperBound: () => ({
      estimatorId: "byte-upper-bound",
      estimatorVersion: "1",
      inputUpperBoundTokens: 50,
      maxOutputTokens: 256,
    }),
    async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      calls.push(req)
      yield reply
    },
  }
}

async function seedRun(runId: string, maxSteps = 10): Promise<void> {
  await runStore.create(minimalCheckpoint(runId, maxSteps))
  await budgetStore.create(createRootBudgetLedger(runId, 10_000))
}

describe("advanceDurableRun", () => {
  it("returns end_turn and advances nextStep when the model calls no tools", async () => {
    const runId = "run-1"
    await seedRun(runId)
    const provider = fakeProvider({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      stopReason: "end_turn",
    })

    const outcome = await advanceDurableRun(
      { runStore, budgetStore, provider, tools: () => [], now: () => 1000, maxSteps: 10 },
      runId
    )

    expect(outcome.kind).toBe("end_turn")
    expect(outcome.checkpoint.nextStep).toBe(1)
  })

  it("returns tool_batch_required with the requested calls when the model uses tools", async () => {
    const runId = "run-2"
    await seedRun(runId)
    const provider = fakeProvider({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }],
      },
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      stopReason: "tool_use",
    })

    const outcome = await advanceDurableRun(
      { runStore, budgetStore, provider, tools: () => [], now: () => 1000, maxSteps: 10 },
      runId
    )

    expect(outcome.kind).toBe("tool_batch_required")
    if (outcome.kind !== "tool_batch_required") throw new Error("expected tool_batch_required")
    expect(outcome.toolCalls).toEqual([{ id: "t1", name: "read_file", input: { path: "a.txt" } }])
    expect(outcome.checkpoint.nextStep).toBe(1)
  })

  it("returns max_steps without calling the provider once the step budget is exhausted", async () => {
    const runId = "run-3"
    await seedRun(runId, 0) // maxSteps: 0 — already exhausted
    const provider = fakeProvider({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "unreachable" }] },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      stopReason: "end_turn",
    })

    const outcome = await advanceDurableRun(
      { runStore, budgetStore, provider, tools: () => [], now: () => 1000, maxSteps: 0 },
      runId
    )

    expect(outcome.kind).toBe("max_steps")
    expect(provider.calls).toHaveLength(0)
  })

  it("resuming after a crash mid-model-step still reaches end_turn without duplicating the model call", async () => {
    const runId = "run-4"
    await seedRun(runId)
    const provider = fakeProvider({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      stopReason: "end_turn",
    })

    await expect(
      advanceDurableRun(
        {
          runStore,
          budgetStore,
          provider,
          tools: () => [],
          now: () => 1000,
          maxSteps: 10,
          fault: (point) => {
            if (point === "after_dispatch_checkpoint") throw new Error("simulated crash")
          },
        },
        runId
      )
    ).rejects.toThrow("simulated crash")
    expect(provider.calls).toHaveLength(0)

    const outcome = await advanceDurableRun(
      { runStore, budgetStore, provider, tools: () => [], now: () => 1000, maxSteps: 10 },
      runId
    )
    expect(outcome.kind).toBe("end_turn")
    expect(provider.calls).toHaveLength(1)
  })
})
