import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { describe, expect, it } from "vitest"
import { toAgentRunSnapshot, toAgentRunSummary } from "./run-projection"

function minimalCheckpoint(overrides: Partial<AgentRunCheckpointV1> = {}): AgentRunCheckpointV1 {
  return {
    schemaVersion: 1,
    revision: 3,
    identity: {
      runId: "run-1",
      rootRunId: "run-1",
      origin: "interactive",
      conversationId: "conv-1",
    },
    status: "running",
    recovery: { kind: "automatic" },
    createdAt: 100,
    updatedAt: 200,
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
    ...overrides,
  }
}

describe("toAgentRunSummary", () => {
  it("projects the identity/status/recovery/timestamps a run picker needs", () => {
    const checkpoint = minimalCheckpoint()
    expect(toAgentRunSummary(checkpoint)).toEqual({
      runId: "run-1",
      conversationId: "conv-1",
      rootRunId: "run-1",
      origin: "interactive",
      status: "running",
      recovery: { kind: "automatic" },
      createdAt: 100,
      updatedAt: 200,
    })
  })

  it("leaves conversationId undefined for a background run", () => {
    const checkpoint = minimalCheckpoint({
      identity: { runId: "bg-1", rootRunId: "bg-1", origin: "background-agent" },
    })
    expect(toAgentRunSummary(checkpoint).conversationId).toBeUndefined()
  })
})

describe("toAgentRunSnapshot", () => {
  it("projects identity/status/recovery/lastSequence/timestamps", () => {
    const checkpoint = minimalCheckpoint()
    const snapshot = toAgentRunSnapshot(checkpoint, 7)
    expect(snapshot.identity).toEqual(checkpoint.identity)
    expect(snapshot.status).toBe("running")
    expect(snapshot.recovery).toEqual({ kind: "automatic" })
    expect(snapshot.lastSequence).toBe(7)
    expect(snapshot.createdAt).toBe(100)
    expect(snapshot.updatedAt).toBe(200)
  })

  it("collects pending approval ids across every tool batch, in order", () => {
    const checkpoint = minimalCheckpoint({
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "r1",
          calls: [
            {
              ordinal: 0,
              toolUseId: "t1",
              safeName: "read_file",
              fqName: "read_file",
              input: {},
              annotations: {},
              replayGuarantee: "none",
              approval: { status: "pending", approvalId: "approval-1", requestedAt: 1 },
              attempts: [],
              resolution: { status: "unresolved" },
            },
            {
              ordinal: 1,
              toolUseId: "t2",
              safeName: "write_file",
              fqName: "write_file",
              input: {},
              annotations: {},
              replayGuarantee: "none",
              approval: { status: "not_required" },
              attempts: [],
              resolution: { status: "unresolved" },
            },
          ],
        },
      ],
    })
    expect(toAgentRunSnapshot(checkpoint, 0).pendingApprovalIds).toEqual(["approval-1"])
  })

  it("returns empty childTasks/artifacts (not owned until Checkpoints E/B)", () => {
    const snapshot = toAgentRunSnapshot(minimalCheckpoint(), 0)
    expect(snapshot.childTasks).toEqual([])
    expect(snapshot.artifacts).toEqual([])
  })

  it("passes through plan when the checkpoint has one", () => {
    const checkpoint = minimalCheckpoint({ plan: [{ title: "step 1", status: "pending" }] })
    expect(toAgentRunSnapshot(checkpoint, 0).plan).toEqual([{ title: "step 1", status: "pending" }])
  })
})
