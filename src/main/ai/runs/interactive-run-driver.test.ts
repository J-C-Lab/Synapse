import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ChatProvider, ProviderRequest, ProviderStreamEvent } from "../providers/types"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRootBudgetLedger, RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import { upsertRunTrace } from "../run-trace-store"
import { AiToolRegistry } from "../tool-registry"
import { AgentRunStore } from "./agent-run-store"
import { freezeToolAuthority } from "./authority-snapshot"
import { sealCheckpointIntegrity } from "./checkpoint-schema"
import { runInteractiveTurn } from "./interactive-run-driver"
import { finalizeRun } from "./run-finalizer"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let tracesDir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-interactive-driver-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  tracesDir = join(dir, "traces")
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function minimalCheckpoint(
  runId: string,
  maxSteps = 10,
  runBudgetTokens: number | undefined = 10_000,
  authorityTools: AgentRunCheckpointV1["config"]["authority"]["tools"] = []
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
      runBudgetTokens,
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
        tools: authorityTools,
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

function fakeProvider(replies: Array<ProviderStreamEvent & { type: "message" }>): ChatProvider & {
  calls: ProviderRequest[]
} {
  const calls: ProviderRequest[] = []
  let index = 0
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
      const reply = replies[Math.min(index, replies.length - 1)]!
      index++
      yield reply
    },
  }
}

function usage(inputTokens = 5, outputTokens = 5) {
  return { inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
}

function toolDescriptor(name: string): RegisteredToolDescriptor {
  return {
    fqName: name,
    pluginId: "host",
    provenance: "host",
    manifestTool: {
      name,
      description: `desc ${name}`,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  }
}

function fakeRegistry(
  handlers: Record<string, (input: unknown) => Promise<unknown> | unknown>
): AiToolRegistry {
  const descriptors = Object.keys(handlers).map((name) => toolDescriptor(name))
  const registry = new AiToolRegistry({
    listTools: () => descriptors,
    invokeTool: async (fqName: string, input: unknown, _options: ToolInvocationOptions) => ({
      content: [{ type: "text" as const, text: String(await handlers[fqName]!(input)) }],
    }),
  })
  registry.list()
  return registry
}

function frozenTools(
  registry: AiToolRegistry
): AgentRunCheckpointV1["config"]["authority"]["tools"] {
  return registry
    .listWithDescriptors()
    .map(({ descriptor, schema }) =>
      freezeToolAuthority({ descriptor, safeName: schema.name, modelSchema: schema })
    )
}

async function seedRun(
  runId: string,
  options: {
    maxSteps?: number
    runBudgetTokens?: number | undefined
    authorityTools?: AgentRunCheckpointV1["config"]["authority"]["tools"]
  } = {}
): Promise<void> {
  await runStore.create(
    minimalCheckpoint(
      runId,
      options.maxSteps ?? 10,
      options.runBudgetTokens ?? 10_000,
      options.authorityTools
    )
  )
  await budgetStore.create(createRootBudgetLedger(runId, options.runBudgetTokens ?? 10_000))
}

function makeDeps(
  provider: ChatProvider,
  registry: AiToolRegistry,
  overrides: Partial<Parameters<typeof runInteractiveTurn>[0]> = {}
): Parameters<typeof runInteractiveTurn>[0] {
  return {
    model: { runStore, budgetStore, provider, tools: () => [], now: () => 1000, maxSteps: 10 },
    toolBatch: {
      tools: registry,
      caller: { kind: "agent" },
      requestApproval: async () => ({ allowed: true, remember: "once" }),
      now: () => 1000,
    },
    finalize: (runId, input) =>
      finalizeRun(
        {
          runStore,
          upsertTrace: (i) => upsertRunTrace(tracesDir, i),
          releaseResources: async () => {},
          now: () => 2000,
        },
        runId,
        input
      ),
    buildResourceReleasePlan: () => ({
      budgetOperationIds: [],
      skillPackageLeaseIds: [],
      releaseArtifactRunPin: false,
      adoptionLeaseIds: [],
    }),
    ...overrides,
  }
}

describe("runInteractiveTurn — happy paths", () => {
  it("drives a no-tool turn straight to end_turn and finalizes the run as completed", async () => {
    const runId = "run-1"
    await seedRun(runId)
    const provider = fakeProvider([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        usage: usage(),
        stopReason: "end_turn",
      },
    ])

    const outcome = await runInteractiveTurn(makeDeps(provider, fakeRegistry({})), runId)

    expect(outcome.kind).toBe("finalized")
    if (outcome.kind !== "finalized") throw new Error("expected finalized")
    expect(outcome.stopReason).toBe("end_turn")
    expect(outcome.checkpoint.status).toBe("completed")
    expect(outcome.checkpoint.finalization?.phase).toBe("complete")
  })

  it("drives a tool-call turn through the batch, then a second model step to end_turn", async () => {
    const runId = "run-2"
    const registry = fakeRegistry({ read_file: () => "contents" })
    await seedRun(runId, { authorityTools: frozenTools(registry) })
    const provider = fakeProvider([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }],
        },
        usage: usage(),
        stopReason: "tool_use",
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "all done" }] },
        usage: usage(),
        stopReason: "end_turn",
      },
    ])
    const outcome = await runInteractiveTurn(makeDeps(provider, registry), runId)

    expect(outcome.kind).toBe("finalized")
    if (outcome.kind !== "finalized") throw new Error("expected finalized")
    expect(outcome.stopReason).toBe("end_turn")
    expect(provider.calls).toHaveLength(2)
    expect(outcome.checkpoint.toolBatches).toHaveLength(1)
    expect(outcome.checkpoint.toolBatches[0]?.materializedAtRevision).toBeDefined()
  })

  it("reaches max_steps and still finalizes as completed", async () => {
    const runId = "run-3"
    await seedRun(runId, { maxSteps: 0 })
    const provider = fakeProvider([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "unreachable" }] },
        usage: usage(),
        stopReason: "end_turn",
      },
    ])

    const deps = makeDeps(provider, fakeRegistry({}))
    const outcome = await runInteractiveTurn(
      { ...deps, model: { ...deps.model, maxSteps: 0 } },
      runId
    )

    expect(outcome.kind).toBe("finalized")
    if (outcome.kind !== "finalized") throw new Error("expected finalized")
    expect(outcome.stopReason).toBe("max_steps")
    expect(provider.calls).toHaveLength(0)
  })
})

describe("runInteractiveTurn — cancellation and budget", () => {
  it("finalizes as aborted immediately when the signal is already aborted, without calling the provider", async () => {
    const runId = "run-4"
    await seedRun(runId)
    const provider = fakeProvider([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "unreachable" }] },
        usage: usage(),
        stopReason: "end_turn",
      },
    ])
    const controller = new AbortController()
    controller.abort()

    const outcome = await runInteractiveTurn(
      makeDeps(provider, fakeRegistry({}), { signal: controller.signal }),
      runId
    )

    expect(outcome.kind).toBe("finalized")
    if (outcome.kind !== "finalized") throw new Error("expected finalized")
    expect(outcome.stopReason).toBe("aborted")
    expect(outcome.checkpoint.status).toBe("cancelled")
    expect(provider.calls).toHaveLength(0)
  })

  it("finalizes as budget_exceeded when the estimate exceeds the remaining finite budget", async () => {
    const runId = "run-5"
    await seedRun(runId, { runBudgetTokens: 10 }) // far below the ~50+ token estimate
    const provider = fakeProvider([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "unreachable" }] },
        usage: usage(),
        stopReason: "end_turn",
      },
    ])

    const outcome = await runInteractiveTurn(makeDeps(provider, fakeRegistry({})), runId)

    expect(outcome.kind).toBe("finalized")
    if (outcome.kind !== "finalized") throw new Error("expected finalized")
    expect(outcome.stopReason).toBe("budget_exceeded")
    expect(provider.calls).toHaveLength(0)
  })
})

describe("runInteractiveTurn — estimator incompatibility", () => {
  it("charges the settled response but terminalizes failed before any follow-on work", async () => {
    const runId = "run-estimator-incompatible"
    await seedRun(runId)
    const provider = fakeProvider([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "too expensive" }] },
        usage: usage(1000, 1000),
        stopReason: "end_turn",
      },
    ])

    const quarantinedProfiles: string[] = []
    const outcome = await runInteractiveTurn(
      makeDeps(provider, fakeRegistry({}), {
        quarantineEstimatorProfile: async (checkpoint) => {
          quarantinedProfiles.push(checkpoint.config.resolvedProfile.profileId)
        },
      }),
      runId
    )

    expect(outcome).toMatchObject({ kind: "finalized", stopReason: "error" })
    const loaded = await runStore.load(runId)
    expect(loaded.ok && loaded.checkpoint.status).toBe("failed")
    expect(provider.calls).toHaveLength(1)
    expect(quarantinedProfiles).toEqual(["p1"])
  })
})

describe("runInteractiveTurn — unknown tool outcome suspension", () => {
  it("returns suspended without finalizing when a tool's attempt can't be recovered", async () => {
    const runId = "run-6"
    const provider = fakeProvider([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "flaky", input: {} }],
        },
        usage: usage(),
        stopReason: "tool_use",
      },
    ])
    const registry = fakeRegistry({ flaky: () => "should not run during recovery" })
    await seedRun(runId, {
      authorityTools: registry
        .listWithDescriptors()
        .map(({ schema, descriptor }) =>
          freezeToolAuthority({ descriptor, safeName: schema.name, modelSchema: schema })
        ),
    })

    let crashedOnce = false
    const depsWithFault = makeDeps(provider, registry, {
      toolBatch: {
        tools: registry,
        caller: { kind: "agent" },
        requestApproval: async () => ({ allowed: true, remember: "once" }),
        now: () => 1000,
        fault: (point) => {
          if (!crashedOnce && point === "after_attempt_started") {
            crashedOnce = true
            throw new Error("simulated crash mid-tool-call")
          }
        },
      },
    })

    await expect(runInteractiveTurn(depsWithFault, runId)).rejects.toThrow(
      /simulated crash mid-tool-call/
    )

    const outcome = await runInteractiveTurn(makeDeps(provider, registry), runId)

    expect(outcome.kind).toBe("suspended_unknown_tool_outcome")
    const loaded = await runStore.load(runId)
    if (!loaded.ok) throw new Error("expected ok")
    expect(loaded.checkpoint.status).toBe("suspended_unknown_tool_outcome")
    expect(loaded.checkpoint.finalization).toBeUndefined()
  })
})
