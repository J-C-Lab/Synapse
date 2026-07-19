import type { AgentRunEvent } from "@synapse/agent-protocol"
import type {
  ChatProvider,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolSchema,
} from "../providers/types"
import type { FrozenToolAuthority } from "./authority-snapshot"
import type { AgentRunCheckpointV1, SkillActivationSnapshot } from "./checkpoint-schema"
import type { ModelStepDeps, ModelStepFaultPoint } from "./model-step-runner"
import type { RunEventEmitter } from "./run-event-emitter"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ArtifactStore } from "../artifacts/artifact-store"
import {
  createRootBudgetLedger,
  freeBalance,
  reserveChildAccount,
  ROOT_ACCOUNT_ID,
  RootBudgetLedgerStore,
} from "../budget/root-budget-ledger"
import { buildActiveSkillInstructionContextText } from "../skills/skill-activation"
import { ACTIVATE_SKILL_FQ, LIST_SKILLS_FQ } from "../skills/skill-tool-source"
import { AgentRunStore } from "./agent-run-store"
import { canonicalHash } from "./canonical-json"
import { sealCheckpointIntegrity } from "./checkpoint-schema"
import { advanceModelStep, InsufficientEstimateError } from "./model-step-runner"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let artifactStore: ArtifactStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-model-step-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  artifactStore = new ArtifactStore(join(dir, "artifacts"))
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
        skillCatalog: [],
        skillCatalogHash: "h",
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

/** A live provider tool schema paired with the exact frozen authority entry
 *  that matches it (modelSchemaHash computed the same way
 *  authority-snapshot.ts's freezeToolAuthority does) — for tests that need
 *  frozenModelTools to actually keep a tool rather than filter it out. */
function toolFixture(
  fqName: string,
  safeName: string
): { schema: ProviderToolSchema; authority: FrozenToolAuthority } {
  const schema: ProviderToolSchema = {
    name: safeName,
    description: `does ${safeName}`,
    inputSchema: { type: "object" },
  }
  const authority: FrozenToolAuthority = {
    fqName,
    safeName,
    provenance: "host",
    ownerId: "synapse-host",
    ownerVersion: "0.2.0",
    modelSchemaHash: canonicalHash(schema as unknown as Parameters<typeof canonicalHash>[0]),
    annotationsHash: "h",
    invocationAdapterId: "host-tool",
    invocationAdapterVersion: "1",
    replayGuarantee: "none",
  }
  return { schema, authority }
}

function fixtureSkillActivation(
  overrides: Partial<SkillActivationSnapshot> = {}
): SkillActivationSnapshot {
  return {
    activationId: "act-1",
    skillId: "user:my-skill",
    packageHash: "p".repeat(64),
    instructionsHash: "h".repeat(64),
    trust: "user-authored",
    effectiveToolNames: [],
    packageLeaseId: "lease-1",
    instructionsArtifact: {
      uri: "artifact://run/run-skill/art-1",
      kind: "skill-instructions",
      mediaType: "text/markdown; charset=utf-8",
      capturedBytes: 10,
      complete: true,
    },
    activatedAt: 1,
    ...overrides,
  }
}

/** Captures real bytes into `artifactStore` under `runId` and returns a
 *  `SkillActivationSnapshot` whose `instructionsArtifact` genuinely resolves
 *  — for tests that exercise the real `buildActiveSkillInstructionContextText`
 *  (not a fake `activeSkillInstructions` stub), since that's the function
 *  the crash-resume nonce-stability bug lives in. */
async function fixtureSkillActivationWithRealArtifact(
  runId: string,
  text: string,
  overrides: Partial<SkillActivationSnapshot> = {}
): Promise<SkillActivationSnapshot> {
  const bytes = new TextEncoder().encode(text)
  const ref = await artifactStore.capture(
    bytes,
    {
      runId,
      owner: { runId, rootRunId: runId, principal: { kind: "local-user" } },
      kind: "skill-instructions",
      mediaType: "text/markdown; charset=utf-8",
      sourceBytes: bytes.byteLength,
    },
    { abort: () => {} }
  )
  return fixtureSkillActivation({
    instructionsArtifact: {
      uri: ref.uri,
      kind: ref.kind,
      mediaType: ref.mediaType,
      capturedBytes: ref.capturedBytes,
      complete: ref.complete,
    },
    ...overrides,
  })
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
      skillCatalog: [],
      skillCatalogHash: "h3",
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

describe("advanceModelStep — active-skill instruction injection (Task 25)", () => {
  it("resolves activeSkillInstructions once and folds it into the same untrusted envelope as workspace instructions", async () => {
    const runId = "run-skill-ctx-1"
    const checkpoint = minimalCheckpoint(runId, 10_000)
    checkpoint.activatedSkills = [fixtureSkillActivation()]
    await runStore.create(sealCheckpointIntegrity(checkpoint))
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))

    const resolvedFor: AgentRunCheckpointV1[] = []
    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })
    const deps: ModelStepDeps = {
      ...baseDeps(provider),
      activeSkillInstructions: async (cp) => {
        resolvedFor.push(cp)
        return "<untrusted-skill>do the skill workflow</untrusted-skill>"
      },
    }

    await advanceModelStep(deps, runId)

    expect(provider.calls).toHaveLength(1)
    const sentMessages = provider.calls[0]!.messages
    expect(sentMessages[0]?.content[0]).toEqual({
      type: "text",
      text: "<untrusted-skill>do the skill workflow</untrusted-skill>",
    })
    expect(sentMessages[0]?.content[1]).toEqual({ type: "text", text: "hi" })
    // Resolved exactly once for the whole step (prepare + dispatch share it),
    // not once per internal transition.
    expect(resolvedFor).toHaveLength(1)

    // Never persisted into the durable checkpoint.
    const stored = await runStore.load(runId)
    expect(stored.ok && stored.checkpoint.messages[0]?.message.content).toEqual([
      { type: "text", text: "hi" },
    ])
  })

  it("combines workspace-instruction text and skill-instruction text into one envelope block", async () => {
    const runId = "run-skill-ctx-2"
    const checkpoint = minimalCheckpoint(runId, 10_000)
    checkpoint.activatedSkills = [fixtureSkillActivation()]
    checkpoint.config.context = {
      schemaVersion: 1,
      baseSystemPrompt: { normalizedText: "You are helpful.", sha256: "h" },
      workspaceInstructions: [
        {
          rootId: "root-1",
          sourcePath: "workspace:root-1/AGENTS.md",
          sourceKind: "workspace-instruction",
          trust: "untrusted-workspace-instruction",
          normalizedText: "<untrusted>workspace guidance</untrusted>",
          sha256: "h2",
        },
      ],
      skillCatalog: [],
      skillCatalogHash: "h3",
      aggregateHash: "h3",
    }
    await runStore.create(sealCheckpointIntegrity(checkpoint))
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))

    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })
    const deps: ModelStepDeps = {
      ...baseDeps(provider),
      activeSkillInstructions: async () => "<untrusted-skill>skill guidance</untrusted-skill>",
    }
    await advanceModelStep(deps, runId)

    const firstBlock = provider.calls[0]!.messages[0]?.content[0]
    expect(firstBlock?.type).toBe("text")
    const text = firstBlock!.type === "text" ? firstBlock.text : ""
    expect(text).toContain("<untrusted>workspace guidance</untrusted>")
    expect(text).toContain("<untrusted-skill>skill guidance</untrusted-skill>")
  })

  it("never calls activeSkillInstructions when it is not wired", async () => {
    const runId = "run-skill-ctx-3"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })
    await advanceModelStep(baseDeps(provider), runId)
    expect(provider.calls[0]!.messages[0]?.content).toEqual([{ type: "text", text: "hi" }])
  })
})

describe("advanceModelStep — active-skill instruction stability across crash-resume (bug fix)", () => {
  // Regression test for: labelUntrustedContent picking a fresh random nonce
  // on every advanceModelStep call meant the skill-instruction envelope's
  // bytes (and therefore requestHash) differed between the pre-crash
  // "prepare" call and the post-crash "dispatch" call for the exact same
  // step, tripping callProviderAndStage's frozen-tool-catalog drift check
  // (ToolCatalogDriftError) even though nothing about the tools or the
  // skill actually changed. Fixed by seeding labelUntrustedContent's nonce
  // deterministically from the activation's own (stable, durable)
  // activationId — see untrusted-content.ts's nonceSeed option and
  // skill-activation.ts's buildActiveSkillInstructionContextText.
  it("never throws ToolCatalogDriftError when resuming after a crash right after prepare with an active skill", async () => {
    const runId = "run-skill-crash-resume"
    const activation = await fixtureSkillActivationWithRealArtifact(
      runId,
      "do the skill workflow, step by step"
    )
    const checkpoint = minimalCheckpoint(runId, 10_000)
    checkpoint.activatedSkills = [activation]
    await runStore.create(sealCheckpointIntegrity(checkpoint))
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))

    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })
    const deps: ModelStepDeps = {
      ...baseDeps(provider, (point) => {
        if (point === "after_prepare") throw new Error("simulated crash right after prepare")
      }),
      activeSkillInstructions: (cp) => buildActiveSkillInstructionContextText(artifactStore, cp),
    }

    await expect(advanceModelStep(deps, runId)).rejects.toThrow("simulated crash")
    expect(provider.calls).toHaveLength(0)

    const midCheckpoint = await runStore.load(runId)
    const prepareRequestHash =
      midCheckpoint.ok && midCheckpoint.checkpoint.modelSteps[0]?.attempts[0]?.requestHash
    expect(prepareRequestHash).toBeTruthy()

    // Resume (simulating a fresh process) — activeSkillInstructions is
    // resolved fresh again here, exactly as it would be on a real restart.
    const resumeDeps: ModelStepDeps = {
      ...baseDeps(provider),
      activeSkillInstructions: (cp) => buildActiveSkillInstructionContextText(artifactStore, cp),
    }
    const result = await advanceModelStep(resumeDeps, runId)

    expect(result.kind).toBe("settled")
    expect(provider.calls).toHaveLength(1)
    // The exact same attempt (and its requestHash) carried through resume —
    // never re-prepared, and dispatch's own re-hash matched it (no
    // ToolCatalogDriftError was thrown along the way, or the assertion
    // above would already have failed).
    const finalAttempt = result.checkpoint.modelSteps[0]!.attempts[0]!
    expect(finalAttempt.requestHash).toBe(prepareRequestHash)
    expect(finalAttempt.state).toBe("budget_settled")
  })

  it("resolves activeSkillInstructions to byte-identical text before and after a simulated restart", async () => {
    const runId = "run-skill-crash-nonce"
    const activation = await fixtureSkillActivationWithRealArtifact(
      runId,
      "frozen instructions for the nonce-stability check"
    )
    const checkpoint = minimalCheckpoint(runId)
    checkpoint.activatedSkills = [activation]
    const sealed = sealCheckpointIntegrity(checkpoint)

    const before = await buildActiveSkillInstructionContextText(artifactStore, sealed)
    // A fresh call — as a resumed process would make, with no shared
    // in-memory state — must resolve to the exact same labeled text.
    const after = await buildActiveSkillInstructionContextText(artifactStore, sealed)
    expect(after).toBe(before)
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
  it("checks estimator quarantine at every finite-budget attempt admission", async () => {
    const runId = "run-quarantined"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 5, outputTokens: 5 })

    await expect(
      advanceModelStep(
        {
          ...baseDeps(provider),
          assertEstimatorAllowed: async () => {
            throw new Error("estimator profile quarantined")
          },
        },
        runId
      )
    ).rejects.toThrow("estimator profile quarantined")
    expect(provider.calls).toHaveLength(0)
    const checkpoint = await runStore.load(runId)
    expect(checkpoint.ok && checkpoint.checkpoint.modelSteps).toHaveLength(0)
  })

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

describe("advanceModelStep — active-skill tool narrowing (Task 25)", () => {
  it("narrows the dispatched tool set to an active skill's effectiveToolNames", async () => {
    const runId = "run-skill-narrow-1"
    const toolA = toolFixture("execution:core/tool_a", "tool_a")
    const toolB = toolFixture("execution:core/tool_b", "tool_b")
    const checkpoint = minimalCheckpoint(runId, 10_000)
    checkpoint.config.authority.tools = [toolA.authority, toolB.authority]
    checkpoint.activatedSkills = [
      fixtureSkillActivation({ effectiveToolNames: ["execution:core/tool_a"] }),
    ]
    await runStore.create(sealCheckpointIntegrity(checkpoint))
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))

    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })
    const deps: ModelStepDeps = {
      ...baseDeps(provider),
      tools: () => [toolA.schema, toolB.schema],
    }

    await advanceModelStep(deps, runId)

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.tools.map((t) => t.name)).toEqual(["tool_a"])
  })

  it("never adds a tool an active skill names that was not already run-visible", async () => {
    const runId = "run-skill-narrow-2"
    const toolA = toolFixture("execution:core/tool_a", "tool_a")
    const checkpoint = minimalCheckpoint(runId, 10_000)
    // Only tool_a is frozen into this run's authority — tool_never_visible
    // was never part of it, even though the (fabricated, as if a corrupted
    // or forged checkpoint) activation below names it.
    checkpoint.config.authority.tools = [toolA.authority]
    checkpoint.activatedSkills = [
      fixtureSkillActivation({
        effectiveToolNames: ["execution:core/tool_a", "execution:core/tool_never_visible"],
      }),
    ]
    await runStore.create(sealCheckpointIntegrity(checkpoint))
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))

    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })
    const deps: ModelStepDeps = { ...baseDeps(provider), tools: () => [toolA.schema] }

    await advanceModelStep(deps, runId)

    expect(provider.calls[0]!.tools.map((t) => t.name)).toEqual(["tool_a"])
  })

  it("applies no narrowing at all when no skill is active", async () => {
    const runId = "run-skill-narrow-3"
    const toolA = toolFixture("execution:core/tool_a", "tool_a")
    const toolB = toolFixture("execution:core/tool_b", "tool_b")
    const checkpoint = minimalCheckpoint(runId, 10_000)
    checkpoint.config.authority.tools = [toolA.authority, toolB.authority]
    await runStore.create(sealCheckpointIntegrity(checkpoint))
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))

    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })
    const deps: ModelStepDeps = {
      ...baseDeps(provider),
      tools: () => [toolA.schema, toolB.schema],
    }

    await advanceModelStep(deps, runId)

    expect(provider.calls[0]!.tools.map((t) => t.name).sort()).toEqual(["tool_a", "tool_b"])
  })

  it("never narrows away skill:core/list_skills or skill:core/activate_skill, even when the active skill's allowedTools doesn't name them (review fix)", async () => {
    const runId = "run-skill-narrow-meta"
    const toolA = toolFixture("execution:core/tool_a", "tool_a")
    const listSkills = toolFixture(LIST_SKILLS_FQ, "list_skills")
    const activateSkillTool = toolFixture(ACTIVATE_SKILL_FQ, "activate_skill")
    const checkpoint = minimalCheckpoint(runId, 10_000)
    checkpoint.config.authority.tools = [
      toolA.authority,
      listSkills.authority,
      activateSkillTool.authority,
    ]
    // A tightly-scoped skill whose own allowed-tools names only its own
    // domain tool — never skill:core/list_skills or skill:core/
    // activate_skill, since nothing requires a skill author to think of
    // that. Without the exemption this would strand the run: no way to
    // list or activate any other skill for the rest of it.
    checkpoint.activatedSkills = [
      fixtureSkillActivation({ effectiveToolNames: ["execution:core/tool_a"] }),
    ]
    await runStore.create(sealCheckpointIntegrity(checkpoint))
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))

    const provider = fakeProvider({ inputTokens: 20, outputTokens: 10 })
    const deps: ModelStepDeps = {
      ...baseDeps(provider),
      tools: () => [toolA.schema, listSkills.schema, activateSkillTool.schema],
    }

    await advanceModelStep(deps, runId)

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.tools.map((t) => t.name).sort()).toEqual(
      ["activate_skill", "list_skills", "tool_a"].sort()
    )
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

  it("preserves an incompatible estimator verdict written before an after_settle crash", async () => {
    const runId = "run-incompatible-after-settle"
    await seedRun(runId, 10_000)
    const provider = fakeProvider({ inputTokens: 400, outputTokens: 10 })

    await expect(
      advanceModelStep(
        baseDeps(provider, (point) => {
          if (point === "after_settle") throw new Error("simulated crash")
        }),
        runId
      )
    ).rejects.toThrow("simulated crash")

    const settled = await runStore.load(runId)
    expect(
      settled.ok && settled.checkpoint.modelSteps[0]?.attempts[0]?.admission.estimatorIncompatible
    ).toBe(true)

    const resumed = await advanceModelStep(baseDeps(provider), runId)
    expect(resumed.estimatorIncompatible).toBe(true)
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
