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
        skillCatalog: [],
        skillCatalogHash: "h",
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

  it("returns empty childTasks (not owned until a later checkpoint) and empty artifacts when none exist", () => {
    const snapshot = toAgentRunSnapshot(minimalCheckpoint(), 0)
    expect(snapshot.childTasks).toEqual([])
    expect(snapshot.artifacts).toEqual([])
  })

  describe("artifacts (Task 21)", () => {
    function artifactSummary(
      uri: string
    ): AgentRunCheckpointV1["activatedSkills"][number]["instructionsArtifact"] {
      return {
        uri: uri as `artifact://run/${string}/${string}`,
        kind: "history",
        mediaType: "application/json",
        capturedBytes: 10,
        complete: true,
      }
    }

    it("collects a completed tool call's offloaded artifact", () => {
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
                safeName: "run_command",
                fqName: "run_command",
                input: {},
                annotations: {},
                replayGuarantee: "none",
                approval: { status: "not_required" },
                attempts: [],
                resolution: {
                  status: "resolved",
                  reason: "executed",
                  result: {
                    isError: false,
                    preview: "...",
                    complete: false,
                    artifact: artifactSummary("artifact://run/run-1/tool-1"),
                  },
                },
              },
            ],
          },
        ],
      })
      expect(toAgentRunSnapshot(checkpoint, 0).artifacts).toEqual([
        artifactSummary("artifact://run/run-1/tool-1"),
      ])
    })

    it("collects an activated skill's instructions artifact", () => {
      const checkpoint = minimalCheckpoint({
        activatedSkills: [
          {
            activationId: "act-1",
            skillId: "skill-1",
            packageHash: "h",
            instructionsHash: "h",
            trust: "host",
            effectiveToolNames: [],
            packageLeaseId: "lease-1",
            instructionsArtifact: artifactSummary("artifact://run/run-1/skill-1"),
            activatedAt: 1,
          },
        ],
      })
      expect(toAgentRunSnapshot(checkpoint, 0).artifacts).toEqual([
        artifactSummary("artifact://run/run-1/skill-1"),
      ])
    })

    it("collects the currently-active context-compaction artifact", () => {
      const checkpoint = minimalCheckpoint({
        messages: [
          { messageId: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        ],
        contextCompaction: {
          compactionId: "c1",
          evictedThroughMessageId: "u1",
          summaryText: "[Earlier conversation summary]\nsummary",
          summarizerTokens: 10,
          artifact: artifactSummary("artifact://run/run-1/history-1"),
          createdAt: 1,
        },
      })
      expect(toAgentRunSnapshot(checkpoint, 0).artifacts).toEqual([
        artifactSummary("artifact://run/run-1/history-1"),
      ])
    })

    it("dedupes when the same uri appears more than once", () => {
      const shared = artifactSummary("artifact://run/run-1/shared")
      const checkpoint = minimalCheckpoint({
        activatedSkills: [
          {
            activationId: "act-1",
            skillId: "skill-1",
            packageHash: "h",
            instructionsHash: "h",
            trust: "host",
            effectiveToolNames: [],
            packageLeaseId: "lease-1",
            instructionsArtifact: shared,
            activatedAt: 1,
          },
        ],
        messages: [
          { messageId: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        ],
        contextCompaction: {
          compactionId: "c1",
          evictedThroughMessageId: "u1",
          summaryText: "[Earlier conversation summary]\nsummary",
          summarizerTokens: 10,
          artifact: shared,
          createdAt: 1,
        },
      })
      expect(toAgentRunSnapshot(checkpoint, 0).artifacts).toEqual([shared])
    })
  })

  it("passes through plan when the checkpoint has one", () => {
    const checkpoint = minimalCheckpoint({ plan: [{ title: "step 1", status: "pending" }] })
    expect(toAgentRunSnapshot(checkpoint, 0).plan).toEqual([{ title: "step 1", status: "pending" }])
  })

  it("projects structural message correlation (id/role/ordinal), never content", () => {
    const checkpoint = minimalCheckpoint({
      messages: [
        { messageId: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        {
          messageId: "a1",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        },
      ],
    })
    expect(toAgentRunSnapshot(checkpoint, 0).messages).toMatchObject([
      { messageId: "u1", role: "user", ordinal: 0 },
      { messageId: "a1", role: "assistant", ordinal: 1 },
    ])
  })

  it("derives each tool call's status/preview from approval + resolution + latest attempt", () => {
    const checkpoint = minimalCheckpoint({
      toolBatches: [
        {
          modelStep: 2,
          assistantMessageId: "a1",
          resultCarrierMessageId: "r1",
          calls: [
            {
              ordinal: 0,
              toolUseId: "t1",
              safeName: "waiting",
              fqName: "waiting",
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
              safeName: "running_now",
              fqName: "running_now",
              input: {},
              annotations: {},
              replayGuarantee: "none",
              approval: { status: "not_required" },
              attempts: [
                {
                  attemptId: "a1",
                  invocationId: "i1",
                  invocationFingerprint: "f1",
                  state: { status: "started", startedAt: 1 },
                },
              ],
              resolution: { status: "unresolved" },
            },
            {
              ordinal: 2,
              toolUseId: "t3",
              safeName: "done_ok",
              fqName: "done_ok",
              input: {},
              annotations: {},
              replayGuarantee: "none",
              approval: { status: "not_required" },
              attempts: [],
              resolution: {
                status: "resolved",
                reason: "executed",
                result: { isError: false, preview: "42", complete: true },
              },
            },
            {
              ordinal: 3,
              toolUseId: "t4",
              safeName: "denied_one",
              fqName: "denied_one",
              input: {},
              annotations: {},
              replayGuarantee: "none",
              approval: { status: "resolved", allowed: false, remember: "once", resolvedAt: 1 },
              attempts: [],
              resolution: {
                status: "resolved",
                reason: "approval-denied",
                result: { isError: true, preview: "denied", complete: true },
              },
            },
          ],
        },
      ],
    })

    const toolCalls = toAgentRunSnapshot(checkpoint, 0).toolCalls
    expect(toolCalls).toMatchObject([
      {
        ordinal: 0,
        modelStep: 2,
        toolUseId: "t1",
        safeName: "waiting",
        fqName: "waiting",
        status: "pending_approval",
      },
      {
        ordinal: 1,
        modelStep: 2,
        toolUseId: "t2",
        safeName: "running_now",
        fqName: "running_now",
        status: "running",
      },
      {
        ordinal: 2,
        modelStep: 2,
        toolUseId: "t3",
        safeName: "done_ok",
        fqName: "done_ok",
        status: "completed",
        isError: false,
        resultPreview: "42",
      },
      {
        ordinal: 3,
        modelStep: 2,
        toolUseId: "t4",
        safeName: "denied_one",
        fqName: "denied_one",
        status: "denied",
        isError: true,
        resultPreview: "denied",
      },
    ])
  })

  it("surfaces the latest model step's latest attempt as currentModelStep", () => {
    const checkpoint = minimalCheckpoint({
      modelSteps: [
        {
          step: 0,
          acceptedAttemptId: "a1",
          attempts: [
            {
              attemptId: "a1",
              requestHash: "h1",
              state: "budget_settled",
              admission: {
                operationId: "op1",
                accountId: "root",
                estimatorId: "e",
                estimatorVersion: "1",
                inputUpperBoundTokens: 10,
                maxOutputTokens: 10,
                heldTokens: 0,
                state: "settled",
              },
            },
          ],
        },
        {
          step: 1,
          attempts: [
            {
              attemptId: "a2",
              requestHash: "h2",
              state: "dispatched",
              assistantMessageId: "a2-msg",
              admission: {
                operationId: "op2",
                accountId: "root",
                estimatorId: "e",
                estimatorVersion: "1",
                inputUpperBoundTokens: 10,
                maxOutputTokens: 10,
                heldTokens: 10,
                state: "held",
              },
            },
          ],
        },
      ],
    })
    expect(toAgentRunSnapshot(checkpoint, 0).currentModelStep).toEqual({
      step: 1,
      state: "dispatched",
      assistantMessageId: "a2-msg",
    })
  })

  it("is undefined for currentModelStep when no model step has started yet", () => {
    expect(toAgentRunSnapshot(minimalCheckpoint(), 0).currentModelStep).toBeUndefined()
  })

  it("passes through the finalization phase once finalization has started", () => {
    const checkpoint = minimalCheckpoint({
      finalization: {
        finalizationId: "f1",
        desiredStatus: "completed",
        phase: "trace_upserted",
        outcome: "end_turn",
        stopReason: "end_turn",
        endedAt: 1,
        trace: {
          runId: "run-1",
          origin: "interactive",
          startedAt: 1,
          endedAt: 1,
          outcome: "end_turn",
          toolCalls: [],
        },
        traceHash: "h",
        resourceReleasePlan: {
          budgetOperationIds: [],
          skillPackageLeaseIds: [],
          releaseArtifactRunPin: false,
          adoptionLeaseIds: [],
        },
      },
    })
    expect(toAgentRunSnapshot(checkpoint, 0).finalizationPhase).toBe("trace_upserted")
  })

  it("leaves finalizationPhase undefined before finalization starts", () => {
    expect(toAgentRunSnapshot(minimalCheckpoint(), 0).finalizationPhase).toBeUndefined()
  })
})
