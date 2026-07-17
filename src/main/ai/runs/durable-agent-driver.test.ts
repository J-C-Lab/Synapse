import type { AgentArtifactStore, ArtifactCaller } from "../artifacts/artifact-types"
import type {
  ChatMessage,
  ChatProvider,
  ProviderRequest,
  ProviderStreamEvent,
} from "../providers/types"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { DurableChatMessage } from "./durable-messages"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Logger } from "../../logging"
import { ArtifactQuotaExceededError } from "../artifacts/artifact-quota"
import { ArtifactStore } from "../artifacts/artifact-store"
import {
  createRootBudgetLedger,
  ROOT_ACCOUNT_ID,
  RootBudgetLedgerStore,
} from "../budget/root-budget-ledger"
import { AgentRunStore } from "./agent-run-store"
import { sealCheckpointIntegrity } from "./checkpoint-schema"
import { advanceDurableRun, HistoryCompressionError } from "./durable-agent-driver"

let dir: string
let runStore: AgentRunStore
let budgetStore: RootBudgetLedgerStore
let artifactStore: AgentArtifactStore

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-durable-driver-"))
  runStore = new AgentRunStore(join(dir, "runs"))
  budgetStore = new RootBudgetLedgerStore(join(dir, "budget"))
  artifactStore = new ArtifactStore(join(dir, "artifacts"), { statDiskSpace: ampleDisk })
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

interface ContextCompressionOverride {
  enabled: boolean
  thresholdTokens: number
  keepRecentFraction?: number
  hardReserveTokens?: number
}

interface CheckpointForCompressionOverrides {
  /** Overrides the frozen base system prompt text — used to force the
   *  `older.length === 0` hardTrim branch (a large-relative-to-threshold
   *  system prompt, not the messages themselves, is what pushes the total
   *  estimate over threshold in that scenario). */
  systemPrompt?: string
  /** Seeds an already-active compaction, simulating "a prior compression
   *  round already happened" without actually running one. */
  contextCompaction?: AgentRunCheckpointV1["contextCompaction"]
}

function checkpointForCompression(
  runId: string,
  messages: DurableChatMessage[],
  contextCompression: ContextCompressionOverride,
  maxSteps = 10,
  overrides: CheckpointForCompressionOverrides = {}
): AgentRunCheckpointV1 {
  const base = minimalCheckpoint(runId, maxSteps)
  return sealCheckpointIntegrity({
    ...base,
    config: {
      ...base.config,
      contextCompression: {
        enabled: contextCompression.enabled,
        thresholdTokens: contextCompression.thresholdTokens,
        keepRecentFraction: contextCompression.keepRecentFraction ?? 0.5,
        hardReserveTokens: contextCompression.hardReserveTokens ?? 0,
      },
      context: overrides.systemPrompt
        ? {
            ...base.config.context,
            baseSystemPrompt: {
              ...base.config.context.baseSystemPrompt,
              normalizedText: overrides.systemPrompt,
            },
          }
        : base.config.context,
    },
    messages,
    contextCompaction: overrides.contextCompaction,
  })
}

function longText(prefix: string, repeats: number): string {
  return `${prefix} `.repeat(repeats)
}

function userMsg(id: string, text: string): DurableChatMessage {
  return { messageId: id, message: { role: "user", content: [{ type: "text", text }] } }
}

function assistantMsg(id: string, text: string): DurableChatMessage {
  return { messageId: id, message: { role: "assistant", content: [{ type: "text", text }] } }
}

function toolUseMsg(id: string, toolUseId: string): DurableChatMessage {
  return {
    messageId: id,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "n", input: {} }],
    },
  }
}

function toolResultMsg(id: string, toolUseId: string, content: string): DurableChatMessage {
  return {
    messageId: id,
    message: {
      role: "user",
      content: [{ type: "tool_result", toolUseId, content, isError: false }],
    },
  }
}

const SUMMARIZE_SYSTEM_PREFIX = "Summarize the following conversation excerpt"

/** A fake provider whose `stream()` recognizes a summarizer request (by its
 *  distinctive system prompt) and answers with `summaryText`, while any
 *  other request gets `reply` — so one fake can drive both a real model
 *  step and durable-agent-driver.ts's compression step in the same test. */
function fakeProviderWithSummarizer(
  reply: ProviderStreamEvent & { type: "message" },
  summaryText = "SUMMARY"
): ChatProvider & { calls: ProviderRequest[] } {
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
      if (req.system.startsWith(SUMMARIZE_SYSTEM_PREFIX)) {
        yield {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: summaryText }] },
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          stopReason: "end_turn",
        }
        return
      }
      yield reply
    },
  }
}

function artifactCaller(runId: string): ArtifactCaller {
  return { runId, rootRunId: runId, principal: { kind: "local-user" } }
}

async function readArtifactText(uri: string, runId: string): Promise<string> {
  const artifactId = uri.split("/").pop()!
  const ref = await artifactStore.resolve(runId, artifactId, artifactCaller(runId))
  const bytes = await artifactStore.read(ref, { start: 0 }, artifactCaller(runId))
  return Buffer.from(bytes).toString("utf-8")
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

describe("advanceDurableRun — context compression (Task 20)", () => {
  const modelReply: ProviderStreamEvent & { type: "message" } = {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "unreachable" }] },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    stopReason: "end_turn",
  }

  it("compresses instead of running a model step when the projection exceeds the threshold, without advancing nextStep", async () => {
    const runId = "compress-1"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")

    const outcome = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider,
        tools: () => [],
        now: () => 1000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )

    expect(outcome.kind).toBe("compressed")
    expect(outcome.checkpoint.nextStep).toBe(0)
    expect(outcome.checkpoint.contextCompaction).toBeDefined()
    expect(outcome.checkpoint.contextCompaction!.evictedThroughMessageId).toBe("m2")
    // Only the summarizer request was dispatched — the model-step reply
    // provider path was never reached this call.
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.system.startsWith(SUMMARIZE_SYSTEM_PREFIX)).toBe(true)
  })

  it("never mutates checkpoint.messages — the full V2 conversation stays canonical", async () => {
    const runId = "compress-2"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply)

    const outcome = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider,
        tools: () => [],
        now: () => 1000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )

    expect(outcome.checkpoint.messages).toHaveLength(3)
    expect(outcome.checkpoint.messages.map((m) => m.messageId)).toEqual(["m1", "m2", "m3"])
    expect(outcome.checkpoint.messages[0]).toEqual(messages[0])
    expect(outcome.checkpoint.messages[1]).toEqual(messages[1])
  })

  it("captures the evicted slice as a readable history artifact and embeds its uri in the summary text", async () => {
    const runId = "compress-3"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")

    const outcome = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider,
        tools: () => [],
        now: () => 1000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )
    const record = outcome.checkpoint.contextCompaction!
    expect(record.summaryText).toContain(record.artifact.uri)
    expect(record.summaryText).toContain("SUMMARY")

    const archivedJson = await readArtifactText(record.artifact.uri, runId)
    const archived = JSON.parse(archivedJson) as DurableChatMessage[]
    expect(archived).toEqual([messages[0], messages[1]])
  })

  it("keeps a tool_use/tool_result pair together across the projection instead of splitting it", async () => {
    const runId = "compress-4"
    const messages = [
      userMsg("m1", longText("old", 60)),
      toolUseMsg("m2", "t1"),
      toolResultMsg("m3", "t1", "r"),
      userMsg("m4", "tail-recent"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")

    const outcome = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider,
        tools: () => [],
        now: () => 1000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )
    expect(outcome.kind).toBe("compressed")

    const projected = projectFromCheckpoint(outcome.checkpoint)
    const toolUseIds = new Set(
      projected.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id))
    )
    const resultToolUseIds = projected.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result").map((b) => b.toolUseId)
    )
    for (const id of resultToolUseIds) expect(toolUseIds.has(id)).toBe(true)
  })

  it("second compression round supersedes the first with a fresh artifact and an advanced cutoff", async () => {
    const runId = "compress-5"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY-1")

    const first = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider,
        tools: () => [],
        now: () => 1000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )
    expect(first.kind).toBe("compressed")
    const firstRecord = first.checkpoint.contextCompaction!

    // Grow the conversation past the threshold again, directly via the run
    // store (standing in for further model/tool-batch steps that would
    // normally append messages between compression rounds).
    const grown = await runStore.mutate(runId, first.checkpoint.revision, (cp) => ({
      ...cp,
      messages: [
        ...cp.messages,
        assistantMsg("m4", longText("more", 200)),
        userMsg("m5", "even more recent"),
      ],
    }))
    expect(grown.messages).toHaveLength(5)

    const provider2 = fakeProviderWithSummarizer(modelReply, "SUMMARY-2")
    const second = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider: provider2,
        tools: () => [],
        now: () => 2000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )
    expect(second.kind).toBe("compressed")
    const secondRecord = second.checkpoint.contextCompaction!

    expect(secondRecord.compactionId).not.toBe(firstRecord.compactionId)
    expect(secondRecord.artifact.uri).not.toBe(firstRecord.artifact.uri)
    // The cutoff must have moved forward, past the first round's cutoff.
    expect(secondRecord.evictedThroughMessageId).not.toBe(firstRecord.evictedThroughMessageId)
    expect(second.checkpoint.messages.map((m) => m.messageId)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ])

    // The second artifact captures only newly-evicted real durable content
    // (m3, the tail after round 1's cutoff, plus m4) — never re-serializing
    // the ephemeral round-1 summary text.
    const archivedJson = await readArtifactText(secondRecord.artifact.uri, runId)
    const archivedIds = (JSON.parse(archivedJson) as DurableChatMessage[]).map((m) => m.messageId)
    expect(archivedIds).toEqual(["m3", "m4"])

    // The first artifact is still on disk and independently readable —
    // Task 20 never deletes a superseded artifact (retention is Task 21).
    await expect(readArtifactText(firstRecord.artifact.uri, runId)).resolves.toContain("old")
  })

  it("throws HistoryCompressionError, and evicts nothing, when compression is needed but no artifact store is configured", async () => {
    const runId = "compress-6"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")

    await expect(
      advanceDurableRun(
        { runStore, budgetStore, provider, tools: () => [], now: () => 1000, maxSteps: 10 },
        runId
      )
    ).rejects.toBeInstanceOf(HistoryCompressionError)

    const reloaded = await runStore.load(runId)
    if (!reloaded.ok) throw new Error("expected ok checkpoint")
    expect(reloaded.checkpoint.contextCompaction).toBeUndefined()
    expect(reloaded.checkpoint.messages).toHaveLength(3)
  })

  it("fails BEFORE spending any summarizer budget when no artifact store is configured (Issue 2 fix) — checked right after the enabled gate, not after a real charge", async () => {
    const runId = "compress-13"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")

    await expect(
      advanceDurableRun(
        { runStore, budgetStore, provider, tools: () => [], now: () => 1000, maxSteps: 10 },
        runId
      )
    ).rejects.toBeInstanceOf(HistoryCompressionError)

    // The summarizer was never dispatched — the missing-store check fired
    // before compressor.compress() was ever called, not after a wasted
    // real provider call.
    expect(provider.calls).toHaveLength(0)

    // No budget operation of any kind was recorded — nothing held,
    // nothing consumed, no compressionAttempt ever started.
    const ledger = await budgetStore.load(runId)
    expect(Object.keys(ledger.operations)).toHaveLength(0)
    expect(ledger.accounts[ROOT_ACCOUNT_ID]!.heldTokens).toBe(0)
    expect(ledger.accounts[ROOT_ACCOUNT_ID]!.consumedTokens).toBe(0)

    const reloaded = await runStore.load(runId)
    if (!reloaded.ok) throw new Error("expected ok checkpoint")
    expect(reloaded.checkpoint.compressionAttempt).toBeUndefined()
    expect(reloaded.checkpoint.contextCompaction).toBeUndefined()
  })

  it("propagates a hard quota-exhaustion failure from the artifact store instead of silently discarding the slice", async () => {
    const runId = "compress-7"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")
    const starvedArtifactStore = new ArtifactStore(join(dir, "artifacts-starved"), {
      statDiskSpace: ampleDisk,
      quotaLimits: {
        perArtifactBytes: 1000,
        perRunBytes: 1, // far too small even for a manifest — true exhaustion
        globalBytes: 1_000_000,
        minFreeBytes: 0,
        minFreeFraction: 0,
        manifestReserveBytes: 0,
      },
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
          artifactStore: starvedArtifactStore,
        },
        runId
      )
    ).rejects.toBeInstanceOf(ArtifactQuotaExceededError)

    const reloaded = await runStore.load(runId)
    if (!reloaded.ok) throw new Error("expected ok checkpoint")
    expect(reloaded.checkpoint.contextCompaction).toBeUndefined()
  })

  it("crash after history capture but before the checkpoint commit orphans the artifact harmlessly; the next call captures fresh and succeeds", async () => {
    const runId = "compress-8"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")

    await expect(
      advanceDurableRun(
        {
          runStore,
          budgetStore,
          provider,
          tools: () => [],
          now: () => 1000,
          maxSteps: 10,
          artifactStore,
          fault: (point) => {
            if (point === "after_history_capture") throw new Error("simulated crash")
          },
        },
        runId
      )
    ).rejects.toThrow("simulated crash")

    const reloaded = await runStore.load(runId)
    if (!reloaded.ok) throw new Error("expected ok checkpoint")
    expect(reloaded.checkpoint.contextCompaction).toBeUndefined()

    const retryProvider = fakeProviderWithSummarizer(modelReply, "SUMMARY")
    const outcome = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider: retryProvider,
        tools: () => [],
        now: () => 2000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )
    expect(outcome.kind).toBe("compressed")
    const record = outcome.checkpoint.contextCompaction!
    await expect(readArtifactText(record.artifact.uri, runId)).resolves.toContain("old")
  })

  it("never replaces a real prior-round summary with the placeholder when a large system prompt forces the older.length===0/summary-preserved branch", async () => {
    const runId = "compress-9"
    // m1/m2 stand in for whatever was archived by "round 1" — irrelevant to
    // this round now that the cutoff has already moved past them.
    const messages = [
      userMsg("m1", "long since archived"),
      assistantMsg("m2", "long since archived too"),
      assistantMsg("m3", longText("mid", 20)),
      userMsg("m4", "recent-tail"),
    ]
    const realPriorSummaryText = "[Earlier conversation summary]\nreal recap from round 1"
    const seededCompaction: NonNullable<AgentRunCheckpointV1["contextCompaction"]> = {
      compactionId: "round-1-compaction",
      evictedThroughMessageId: "m2",
      summaryText: realPriorSummaryText,
      summarizerTokens: 5,
      artifact: {
        uri: "artifact://run/compress-9/round-1-artifact",
        kind: "history",
        mediaType: "application/json; charset=utf-8",
        capturedBytes: 42,
        complete: true,
      },
      createdAt: 1,
    }

    await runStore.create(
      checkpointForCompression(
        runId,
        messages,
        { enabled: true, thresholdTokens: 100 },
        10,
        // A large system prompt — not the messages — is what pushes the
        // total estimate over threshold here, forcing recentStartIndex to
        // walk all the way back to 0 (everything fits the keep-budget) and
        // routing into the older.length===0 branch, which hardTrims the
        // *entire* projection including the already-summarized message at
        // the front (see context-compressor.test.ts's identical repro).
        { systemPrompt: "S".repeat(400), contextCompaction: seededCompaction }
      )
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SHOULD-NOT-BE-USED")
    // durable-agent-driver.ts logs through `logger.child("context-compression")`
    // — a distinct Logger *instance*, not the `logger` facade object itself
    // — so spying on the facade's own `warn` (the pattern
    // mcp-client-manager.test.ts uses for a direct `logger.warn(...)` call)
    // would never see it. Spying on the shared `Logger.prototype.warn`
    // intercepts every instance, including child-scoped ones.
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {})

    try {
      const outcome = await advanceDurableRun(
        {
          runStore,
          budgetStore,
          provider,
          tools: () => [],
          now: () => 1000,
          maxSteps: 10,
          artifactStore,
        },
        runId
      )

      // Nothing was evicted this round, so compression is a no-op and the
      // driver proceeds straight to a real model step instead.
      expect(outcome.kind).not.toBe("compressed")
      // The committed compaction record is byte-for-byte the same one seeded
      // above — never replaced with a new compactionId or the generic
      // "(automatic summarization was unavailable...)" placeholder text.
      expect(outcome.checkpoint.contextCompaction).toEqual(seededCompaction)
      expect(outcome.checkpoint.contextCompaction!.summaryText).toBe(realPriorSummaryText)
      // The summarizer was never invoked — only the real model step's own
      // request was dispatched.
      expect(provider.calls).toHaveLength(1)
      expect(provider.calls[0]!.system.startsWith(SUMMARIZE_SYSTEM_PREFIX)).toBe(false)

      // Observability fix (review round 3): this "detected over-threshold
      // but couldn't represent the eviction, declined silently" path must
      // not actually be silent — it logs a warning naming the run so an
      // operator can tell "nothing to do" apart from "wanted to compress
      // but couldn't." Filtered (rather than asserting total call count)
      // so this doesn't become fragile against unrelated incidental warns
      // from other Logger instances sharing the same spied prototype
      // method.
      const relevantCalls = warnSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("could not represent")
      )
      expect(relevantCalls).toHaveLength(1)
      const [message, fields] = relevantCalls[0]!
      expect(message).toMatch(/could not represent.*leading-prefix eviction/)
      expect(fields).toMatchObject({ runId })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("a compression budget hold left stuck 'held' by a crash before settle is conservatively forfeited on the next call, and the budget becomes available again (Issue 2 fix)", async () => {
    const runId = "compress-11"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")

    // Crash right after the ledger hold is durably confirmed ("held") but
    // before the provider is ever dispatched or the hold is settled.
    await expect(
      advanceDurableRun(
        {
          runStore,
          budgetStore,
          provider,
          tools: () => [],
          now: () => 1000,
          maxSteps: 10,
          artifactStore,
          fault: (point) => {
            if (point === "after_compression_hold") throw new Error("simulated crash")
          },
        },
        runId
      )
    ).rejects.toThrow("simulated crash")

    // The hold is durably stuck: the checkpoint records it "held", and the
    // ledger genuinely has the tokens held (not a phantom).
    const stuckCheckpoint = await runStore.load(runId)
    if (!stuckCheckpoint.ok) throw new Error("expected ok checkpoint")
    expect(stuckCheckpoint.checkpoint.compressionAttempt?.admission.state).toBe("held")
    const stuckHeldTokens = stuckCheckpoint.checkpoint.compressionAttempt!.admission.heldTokens
    expect(stuckHeldTokens).toBeGreaterThan(0)

    const midLedger = await budgetStore.load(runId)
    expect(midLedger.accounts[ROOT_ACCOUNT_ID]!.heldTokens).toBe(stuckHeldTokens)
    expect(midLedger.accounts[ROOT_ACCOUNT_ID]!.consumedTokens).toBe(0)

    // The very next call must detect and forfeit the stuck hold before
    // attempting anything else — never leak it, never blindly retry it.
    const retryProvider = fakeProviderWithSummarizer(modelReply, "SUMMARY")
    const outcome = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider: retryProvider,
        tools: () => [],
        now: () => 2000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )
    expect(outcome.kind).toBe("compressed")

    // The stuck hold is gone from the ledger (released, conservatively
    // charged as consumed — never left as a permanent hold), and the fresh
    // attempt's own settlement is also fully accounted for.
    const finalLedger = await budgetStore.load(runId)
    const finalAccount = finalLedger.accounts[ROOT_ACCOUNT_ID]!
    expect(finalAccount.heldTokens).toBe(0)
    expect(finalAccount.consumedTokens).toBeGreaterThanOrEqual(stuckHeldTokens)

    // The committed compaction reflects a real, fresh compression round —
    // not the crashed one.
    expect(outcome.checkpoint.compressionAttempt?.admission.state).toBe("settled")
    expect(outcome.checkpoint.contextCompaction).toBeDefined()
  })

  it("a compression budget hold left stuck 'planned' by a crash before the ledger admit resumes safely in place, never double-charging", async () => {
    const runId = "compress-12"
    const messages = [
      userMsg("m1", longText("old", 200)),
      assistantMsg("m2", longText("old2", 200)),
      userMsg("m3", "recent question"),
    ]
    await runStore.create(
      checkpointForCompression(runId, messages, { enabled: true, thresholdTokens: 100 })
    )
    await budgetStore.create(createRootBudgetLedger(runId, 10_000))
    const provider = fakeProviderWithSummarizer(modelReply, "SUMMARY")

    // Crash right after the "planned" record is durably written but before
    // the ledger is ever touched.
    await expect(
      advanceDurableRun(
        {
          runStore,
          budgetStore,
          provider,
          tools: () => [],
          now: () => 1000,
          maxSteps: 10,
          artifactStore,
          fault: (point) => {
            if (point === "after_compression_prepared") throw new Error("simulated crash")
          },
        },
        runId
      )
    ).rejects.toThrow("simulated crash")

    const stuckCheckpoint = await runStore.load(runId)
    if (!stuckCheckpoint.ok) throw new Error("expected ok checkpoint")
    expect(stuckCheckpoint.checkpoint.compressionAttempt?.admission.state).toBe("planned")
    const plannedOperationId = stuckCheckpoint.checkpoint.compressionAttempt!.admission.operationId
    const plannedAttemptId = stuckCheckpoint.checkpoint.compressionAttempt!.attemptId

    const midLedger = await budgetStore.load(runId)
    expect(midLedger.accounts[ROOT_ACCOUNT_ID]!.heldTokens).toBe(0)
    expect(midLedger.operations[plannedOperationId]).toBeUndefined()

    const retryProvider = fakeProviderWithSummarizer(modelReply, "SUMMARY")
    const outcome = await advanceDurableRun(
      {
        runStore,
        budgetStore,
        provider: retryProvider,
        tools: () => [],
        now: () => 2000,
        maxSteps: 10,
        artifactStore,
      },
      runId
    )
    expect(outcome.kind).toBe("compressed")

    // The SAME attempt/operation id was resumed in place — never a fresh
    // one minted for a merely-"planned" (never ledger-touched) record.
    expect(outcome.checkpoint.compressionAttempt?.attemptId).toBe(plannedAttemptId)
    expect(outcome.checkpoint.compressionAttempt?.admission.operationId).toBe(plannedOperationId)
    expect(outcome.checkpoint.compressionAttempt?.admission.state).toBe("settled")

    const finalLedger = await budgetStore.load(runId)
    expect(finalLedger.accounts[ROOT_ACCOUNT_ID]!.heldTokens).toBe(0)
    expect(finalLedger.operations[plannedOperationId]).toBeDefined()
  })
})

/** Reconstructs the model-facing projection from a checkpoint the same way
 *  model-step-runner.ts's outgoingRequestContext would (minus untrusted-
 *  context injection, irrelevant here) — re-derived locally rather than
 *  imported so this test file doesn't reach into model-step-runner.ts's
 *  internals for a two-line projection it already exercises indirectly via
 *  `outcome.checkpoint.contextCompaction`. */
function projectFromCheckpoint(checkpoint: AgentRunCheckpointV1): ChatMessage[] {
  const compaction = checkpoint.contextCompaction
  if (!compaction) return checkpoint.messages.map((m) => m.message)
  const cutoff = checkpoint.messages.findIndex(
    (m) => m.messageId === compaction.evictedThroughMessageId
  )
  const tail = checkpoint.messages.slice(cutoff + 1).map((m) => m.message)
  return [{ role: "user", content: [{ type: "text", text: compaction.summaryText }] }, ...tail]
}
