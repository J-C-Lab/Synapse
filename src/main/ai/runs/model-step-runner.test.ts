import type { AgentRunEvent } from "@synapse/agent-protocol"
import type { ChatProvider, ProviderRequest, ProviderStreamEvent } from "../providers/types"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { ModelStepDeps, ModelStepFaultPoint } from "./model-step-runner"
import type { RunEventEmitter } from "./run-event-emitter"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createRootBudgetLedger,
  freeBalance,
  reserveChildAccount,
  ROOT_ACCOUNT_ID,
  RootBudgetLedgerStore,
} from "../budget/root-budget-ledger"
import { AgentRunStore } from "./agent-run-store"
import { sealCheckpointIntegrity } from "./checkpoint-schema"
import { advanceModelStep, InsufficientEstimateError } from "./model-step-runner"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-model-step-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function minimalCheckpoint(runId: string, runBudgetTokens?: number): AgentRunCheckpointV1 {
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
      runBudgetTokens,
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

function fakeProvider(usage: { inputTokens: number; outputTokens: number }): ChatProvider & {
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
      inputUpperBoundTokens: 100,
      maxOutputTokens: 256,
    }),
    async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      calls.push(req)
      yield {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hello back" }] },
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: "end_turn",
      }
    },
  }
}

async function seedRun(runId: string, runBudgetTokens?: number): Promise<void> {
  await runStore.create(minimalCheckpoint(runId, runBudgetTokens))
  await budgetStore.create(createRootBudgetLedger(runId, runBudgetTokens))
}

function baseDeps(
  provider: ChatProvider,
  fault?: (point: ModelStepFaultPoint) => void
): ModelStepDeps {
  return {
    runStore,
    budgetStore,
    provider,
    tools: () => [],
    now: () => 1000,
    fault,
  }
}

describe("advanceModelStep — happy path", () => {
  it("drives prepared -> held -> dispatched -> response_staged -> budget_settled and debits the ledger", async () => {
    const runId = "run-1"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })

    const result = await advanceModelStep(baseDeps(provider), runId)

    expect(result.kind).toBe("settled")
    expect(result.assistantMessage.content).toEqual([{ type: "text", text: "hello back" }])
    expect(provider.calls).toHaveLength(1)

    const checkpoint = result.checkpoint
    const ledger = checkpoint.modelSteps[0]!
    const attempt = ledger.attempts[0]!
    expect(attempt.state).toBe("budget_settled")
    expect(attempt.admission.state).toBe("settled")

    const budgetLedger = await budgetStore.load(runId)
    expect(budgetLedger.accounts[ROOT_ACCOUNT_ID]?.heldTokens).toBe(0)
    expect(budgetLedger.accounts[ROOT_ACCOUNT_ID]?.consumedTokens).toBe(30)
  })

  it("appends the assistant message to durable messages exactly once", async () => {
    const runId = "run-2"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })
    const result = await advanceModelStep(baseDeps(provider), runId)
    expect(result.checkpoint.messages).toHaveLength(2)
    expect(result.checkpoint.messages[1]?.message).toEqual(result.assistantMessage)
  })
})

describe("advanceModelStep — live text-delta streaming", () => {
  it("forwards every text delta via onTextDelta, in order, before the final message settles", async () => {
    const runId = "run-delta-1"
    await seedRun(runId, 10_000)
    const deltas: string[] = []
    const provider: ChatProvider = {
      id: "fake",
      descriptor: { providerId: "fake", estimatorId: "byte-upper-bound", estimatorVersion: "1" },
      estimateRequestUpperBound: () => ({
        estimatorId: "byte-upper-bound",
        estimatorVersion: "1",
        inputUpperBoundTokens: 100,
        maxOutputTokens: 256,
      }),
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "text", text: "Hel" }
        yield { type: "text", text: "lo " }
        yield { type: "text", text: "back" }
        yield {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Hello back" }] },
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          stopReason: "end_turn",
        }
      },
    }

    const result = await advanceModelStep(
      { ...baseDeps(provider), onTextDelta: (text) => deltas.push(text) },
      runId
    )

    expect(deltas).toEqual(["Hel", "lo ", "back"])
    expect(result.assistantMessage.content).toEqual([{ type: "text", text: "Hello back" }])
  })

  it("never throws when onTextDelta is omitted (every existing caller keeps working)", async () => {
    const runId = "run-delta-2"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })
    await expect(advanceModelStep(baseDeps(provider), runId)).resolves.toBeDefined()
  })
})

describe("advanceModelStep — workspace-instruction context injection", () => {
  it("injects the frozen workspace-instruction text onto the latest user text message sent to the provider, without persisting it into durable messages", async () => {
    const runId = "run-ctx-1"
    const checkpoint = minimalCheckpoint(runId, 10_000)
    checkpoint.config.context = {
      schemaVersion: 1,
      baseSystemPrompt: { normalizedText: "You are helpful.", sha256: "h" },
      workspaceInstructions: [
        {
          rootId: "root-1",
          sourcePath: "workspace:root-1/AGENTS.md",
          sourceKind: "workspace-instruction",
          trust: "untrusted-workspace-instruction",
          normalizedText: "<untrusted>do the thing</untrusted>",
          sha256: "h2",
        },
      ],
      aggregateHash: "h3",
    }
    await runStore.create(sealCheckpointIntegrity(checkpoint))
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))

    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })
    await advanceModelStep(baseDeps(provider), runId)

    expect(provider.calls).toHaveLength(1)
    const sentMessages = provider.calls[0]!.messages
    expect(sentMessages[0]?.content[0]).toEqual({
      type: "text",
      text: "<untrusted>do the thing</untrusted>",
    })
    // The original durable message text is still present, right after it.
    expect(sentMessages[0]?.content[1]).toEqual({ type: "text", text: "hi" })

    // Never persisted into the durable checkpoint's own message history.
    const stored = await runStore.load(runId)
    if (!stored.ok) throw new Error("expected ok")
    expect(stored.checkpoint.messages[0]?.message.content).toEqual([{ type: "text", text: "hi" }])
  })

  it("sends messages unchanged when there are no workspace instructions", async () => {
    const runId = "run-ctx-2"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })
    await advanceModelStep(baseDeps(provider), runId)
    expect(provider.calls[0]!.messages[0]?.content).toEqual([{ type: "text", text: "hi" }])
  })
})

describe("advanceModelStep — cancellation", () => {
  it("forwards deps.signal to the provider request so an external abort actually cancels the call", async () => {
    const runId = "run-cancel-1"
    await seedRun(runId, 10_000)
    const seenSignals: (AbortSignal | undefined)[] = []
    const provider: ChatProvider = {
      id: "fake",
      descriptor: { providerId: "fake", estimatorId: "byte-upper-bound", estimatorVersion: "1" },
      estimateRequestUpperBound: () => ({
        estimatorId: "byte-upper-bound",
        estimatorVersion: "1",
        inputUpperBoundTokens: 100,
        maxOutputTokens: 256,
      }),
      async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
        seenSignals.push(req.signal)
        // Mimics a real SDK client: several real fs writes happen between
        // advanceModelStep() starting and the provider actually being
        // called, so by the time we get here the caller's abort() below
        // (fired synchronously, right after kicking off the promise) has
        // almost certainly already landed — check .aborted directly rather
        // than relying solely on a future "abort" event that already fired.
        if (req.signal?.aborted) throw req.signal.reason
        await new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(req.signal!.reason))
        })
        yield { type: "text", text: "unreachable" } as ProviderStreamEvent
      },
    }
    const controller = new AbortController()

    const promise = advanceModelStep({ ...baseDeps(provider), signal: controller.signal }, runId)
    controller.abort(new Error("user cancelled"))

    await expect(promise).rejects.toThrow(/cancelled/)
    expect(seenSignals).toHaveLength(1)
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
  })
})

describe("advanceModelStep — admission failure closes before dispatch", () => {
  it("throws and never calls the provider when the estimate exceeds the finite budget", async () => {
    const runId = "run-3"
    await seedRun(runId, 50) // far below the ~100+ token estimate
    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })

    await expect(advanceModelStep(baseDeps(provider), runId)).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)

    const checkpoint = await runStore.load(runId)
    expect(checkpoint.ok && checkpoint.checkpoint.modelSteps[0]?.attempts[0]?.state).toBe(
      "prepared"
    )
  })

  it("fails closed for a finite-budget run whose provider cannot guarantee an upper bound", async () => {
    const runId = "run-4"
    await seedRun(runId, 10_000)
    const provider: ChatProvider = {
      id: "unverified",
      descriptor: { providerId: "unverified", estimatorId: "none", estimatorVersion: "0" },
      estimateRequestUpperBound: () => undefined,
      async *stream() {
        yield {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "x" }] },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          stopReason: "end_turn",
        }
      },
    }
    await expect(advanceModelStep(baseDeps(provider), runId)).rejects.toThrow(
      InsufficientEstimateError
    )
  })
})

describe("advanceModelStep — frozen tool catalog enforcement at dispatch (P1-5)", () => {
  it("never exposes a tool added to the live catalog after the run was frozen", async () => {
    const runId = "run-drift"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })

    // The run froze an empty authority. The second live catalog read adds a
    // tool, but the central frozen-catalog guard must remove it before both
    // hashing and dispatching.
    let callCount = 0
    const deps: ModelStepDeps = {
      ...baseDeps(provider),
      tools: () => {
        callCount += 1
        return callCount === 1
          ? []
          : [{ name: "new_tool", description: "d", inputSchema: { type: "object" as const } }]
      },
    }

    await expect(advanceModelStep(deps, runId)).resolves.toMatchObject({ kind: "settled" })
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.tools).toEqual([])
  })

  it("dispatches normally when the tool catalog is unchanged between prepare and dispatch", async () => {
    const runId = "run-no-drift"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })
    const stableTools = [
      { name: "read_file", description: "d", inputSchema: { type: "object" as const } },
    ]
    const deps: ModelStepDeps = { ...baseDeps(provider), tools: () => stableTools }

    const result = await advanceModelStep(deps, runId)

    expect(result.kind).toBe("settled")
    expect(provider.calls).toHaveLength(1)
  })
})

describe("advanceModelStep — crash recovery via deterministic fault injection", () => {
  it("forfeits the full hold and retries with a new attempt when a crash is simulated right after the dispatch checkpoint", async () => {
    const runId = "run-5"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })

    await expect(
      advanceModelStep(
        baseDeps(provider, (point) => {
          if (point === "after_dispatch_checkpoint") throw new Error("simulated crash")
        }),
        runId
      )
    ).rejects.toThrow("simulated crash")

    // The provider was never actually called — the crash happened before dispatch.
    expect(provider.calls).toHaveLength(0)
    const midCheckpoint = await runStore.load(runId)
    expect(midCheckpoint.ok && midCheckpoint.checkpoint.modelSteps[0]?.attempts[0]?.state).toBe(
      "dispatched"
    )

    // A fresh call (simulating process restart) must forfeit the stuck hold and
    // succeed with a brand-new attempt — never reusing the "dispatched" one.
    const result = await advanceModelStep(baseDeps(provider), runId)
    expect(result.kind).toBe("settled")
    expect(provider.calls).toHaveLength(1)

    const attempts = result.checkpoint.modelSteps[0]!.attempts
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.state).toBe("unknown_response")
    expect(attempts[0]?.admission.state).toBe("forfeited")
    expect(attempts[1]?.state).toBe("budget_settled")

    // The forfeited hold was fully charged as consumed (overcounted, not lost),
    // plus the real settled attempt's actual usage.
    const budgetLedger = await budgetStore.load(runId)
    const forfeitedHeld = attempts[0]!.admission.heldTokens
    expect(budgetLedger.accounts[ROOT_ACCOUNT_ID]?.consumedTokens).toBe(forfeitedHeld + 30)
  })

  it("never double-calls the provider when resuming after a response was already staged", async () => {
    const runId = "run-6"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })

    await expect(
      advanceModelStep(
        baseDeps(provider, (point) => {
          if (point === "after_response_staged") throw new Error("simulated crash")
        }),
        runId
      )
    ).rejects.toThrow("simulated crash")
    expect(provider.calls).toHaveLength(1)

    const result = await advanceModelStep(baseDeps(provider), runId)
    expect(result.kind).toBe("settled")
    // Resuming from response_staged only needs to settle — never re-dispatch.
    expect(provider.calls).toHaveLength(1)
  })

  it("does not write a partial checkpoint when the ledger hold succeeds but the checkpoint write is interrupted", async () => {
    const runId = "run-7"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })

    await expect(
      advanceModelStep(
        baseDeps(provider, (point) => {
          if (point === "after_hold_ledger") throw new Error("simulated crash")
        }),
        runId
      )
    ).rejects.toThrow("simulated crash")

    const checkpoint = await runStore.load(runId)
    expect(checkpoint.ok && checkpoint.checkpoint.modelSteps[0]?.attempts[0]?.state).toBe(
      "prepared"
    )
    // The ledger hold DID land (that's the point being recovered from) —
    // resuming must reuse it correctly rather than double-holding.
    const ledgerAfterCrash = await budgetStore.load(runId)
    expect(freeBalance(ledgerAfterCrash.accounts[ROOT_ACCOUNT_ID]!)).toBeLessThan(10_000)

    const result = await advanceModelStep(baseDeps(provider), runId)
    expect(result.kind).toBe("settled")
    const budgetLedger = await budgetStore.load(runId)
    expect(budgetLedger.accounts[ROOT_ACCOUNT_ID]?.consumedTokens).toBe(30)
  })
})

describe("advanceModelStep — provider stream deadlines", () => {
  it("treats a headers-deadline failure as an ordinary recoverable dispatch failure", async () => {
    const runId = "run-9"
    await seedRun(runId, 10_000)
    const neverResolves: ChatProvider = {
      id: "slow",
      descriptor: { providerId: "slow", estimatorId: "byte-upper-bound", estimatorVersion: "1" },
      estimateRequestUpperBound: () => ({
        estimatorId: "byte-upper-bound",
        estimatorVersion: "1",
        inputUpperBoundTokens: 100,
        maxOutputTokens: 256,
      }),
      async *stream(req: ProviderRequest) {
        // Mimics a real SDK: the underlying request rejects once the
        // combined abort signal fires (streamWithDeadlines aborts it when
        // the headers deadline elapses).
        await new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(req.signal!.reason))
        })
        yield { type: "text", text: "unreachable" } as ProviderStreamEvent
      },
    }

    await expect(
      advanceModelStep(
        {
          ...baseDeps(neverResolves),
          providerStreamDeadlines: { headersDeadlineMs: 20 },
        },
        runId
      )
    ).rejects.toThrow(/deadline/)

    const midCheckpoint = await runStore.load(runId)
    expect(midCheckpoint.ok && midCheckpoint.checkpoint.modelSteps[0]?.attempts[0]?.state).toBe(
      "dispatched"
    )

    // A working provider on the next call must forfeit the stuck hold and succeed.
    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })
    const result = await advanceModelStep(baseDeps(provider), runId)
    expect(result.kind).toBe("settled")
  })
})

describe("advanceModelStep — unlimited interactive runs are never blocked", () => {
  it("succeeds even when the provider's estimate is huge, on an unlimited ledger", async () => {
    const runId = "run-8"
    await seedRun(runId, undefined)
    const provider = fakeProvider({ inputTokens: 500_000, outputTokens: 500_000 })
    const result = await advanceModelStep(baseDeps(provider), runId)
    expect(result.kind).toBe("settled")
  })
})

describe("advanceModelStep — child budget accounts (subagent runs)", () => {
  it("admits against its own child account, not the root, when identity.runId differs from rootRunId", async () => {
    const rootRunId = "parent-root"
    const childRunId = "child-1"

    await runStore.create(
      (() => {
        const cp = minimalCheckpoint(childRunId, undefined)
        return { ...cp, identity: { ...cp.identity, rootRunId, parentRunId: rootRunId } }
      })()
    )
    await budgetStore.create(createRootBudgetLedger(rootRunId, 10_000))
    const seeded = await budgetStore.load(rootRunId)
    const { ledger: reserved } = reserveChildAccount(seeded, {
      operationId: "reserve-child-1",
      accountId: childRunId,
      taskId: childRunId,
      totalTokens: 500,
    })
    await budgetStore.mutate(rootRunId, seeded.revision, () => reserved)

    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })
    const result = await advanceModelStep(baseDeps(provider), childRunId)

    expect(result.kind).toBe("settled")
    const budgetLedger = await budgetStore.load(rootRunId)
    expect(budgetLedger.accounts[ROOT_ACCOUNT_ID]?.heldTokens).toBe(0)
    expect(budgetLedger.accounts[ROOT_ACCOUNT_ID]?.consumedTokens).toBe(0)
    expect(budgetLedger.accounts[ROOT_ACCOUNT_ID]?.reservedTokens).toBe(500)
    expect(budgetLedger.accounts[childRunId]?.consumedTokens).toBe(30)
  })
})

function fakeEmitter(): RunEventEmitter & { events: AgentRunEvent[] } {
  const events: AgentRunEvent[] = []
  return {
    events,
    async emit(input) {
      events.push({ ...input } as AgentRunEvent)
    },
  }
}

describe("advanceModelStep — durable event emission", () => {
  it("emits budget_admission_updated(held) then budget_admission_updated(settled) and model_completed on a normal settle", async () => {
    const runId = "run-events-1"
    await seedRun(runId, 10_000)
    const emitter = fakeEmitter()
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })

    await advanceModelStep({ ...baseDeps(provider), eventEmitter: emitter }, runId)

    expect(emitter.events.map((e) => [e.type, "state" in e ? e.state : undefined])).toEqual([
      ["budget_admission_updated", "held"],
      ["budget_admission_updated", "settled"],
      ["model_completed", undefined],
    ])
    const settled = emitter.events[1]
    expect(settled).toMatchObject({ type: "budget_admission_updated", consumedTokens: 30 })
    const completed = emitter.events[2]
    expect(completed).toMatchObject({
      type: "model_completed",
      step: 0,
      inputTokens: 20,
      outputTokens: 10,
    })
    expect(
      completed && "assistantMessageId" in completed && typeof completed.assistantMessageId
    ).toBe("string")
  })

  it("emits budget_admission_updated(forfeited) when a crash is simulated right after the dispatch checkpoint", async () => {
    const runId = "run-events-2"
    await seedRun(runId, 10_000)
    const emitter = fakeEmitter()
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })

    await expect(
      advanceModelStep(
        {
          ...baseDeps(provider, (point) => {
            if (point === "after_dispatch_checkpoint") throw new Error("simulated crash")
          }),
          eventEmitter: emitter,
        },
        runId
      )
    ).rejects.toThrow("simulated crash")

    // Resume: the next call forfeits the interrupted hold before preparing fresh.
    await advanceModelStep(
      { ...baseDeps(fakeProvider({ inputTokens: 5, outputTokens: 5 })), eventEmitter: emitter },
      runId
    )

    const forfeited = emitter.events.find(
      (e) => e.type === "budget_admission_updated" && e.state === "forfeited"
    )
    expect(forfeited).toBeDefined()
  })

  it("never throws when eventEmitter is omitted (every existing caller keeps working)", async () => {
    const runId = "run-events-3"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })
    await expect(advanceModelStep(baseDeps(provider), runId)).resolves.toMatchObject({
      kind: "settled",
    })
  })
})
