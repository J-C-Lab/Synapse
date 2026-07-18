import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { describe, expect, it } from "vitest"
import { canonicalHash } from "./canonical-json"
import { sealCheckpointIntegrity, validateCheckpoint } from "./checkpoint-schema"

function minimalCheckpoint(): AgentRunCheckpointV1 {
  return sealCheckpointIntegrity({
    schemaVersion: 1,
    revision: 1,
    identity: {
      runId: "run-1",
      rootRunId: "run-1",
      origin: "interactive",
    },
    status: "created",
    recovery: { kind: "automatic" },
    createdAt: 1,
    updatedAt: 1,
    config: {
      schemaVersion: 1,
      providerId: "anthropic",
      model: "claude",
      resolvedProfile: {
        profileId: "p1",
        providerId: "anthropic",
        modelPattern: "claude*",
        contextWindowTokens: 200_000,
        defaultMaxOutputTokens: 4096,
        supportsPromptCaching: true,
        supportsParallelToolCalls: true,
        supportsReasoningStream: false,
        tokenBudgeting: {
          upperBoundEstimatorId: "est-1",
          upperBoundEstimatorVersion: "1",
          providerFramingReserveTokens: 100,
        },
        contextPolicy: {
          summarizeAtFraction: 0.8,
          keepRecentFraction: 0.5,
          hardReserveTokens: 1000,
        },
      },
      maxOutputTokens: 4096,
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
        baseSystemPrompt: { normalizedText: "base", sha256: "h" },
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
    nextStep: 0,
    modelSteps: [],
    toolBatches: [],
    activatedSkills: [],
  })
}

describe("validateCheckpoint", () => {
  it("accepts a well-formed schemaVersion 1 checkpoint", () => {
    const result = validateCheckpoint(minimalCheckpoint())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.checkpoint.identity.runId).toBe("run-1")
  })

  it("classifies a non-record value as malformed", () => {
    expect(validateCheckpoint(null)).toEqual({ ok: false, reason: "malformed" })
    expect(validateCheckpoint("string")).toEqual({ ok: false, reason: "malformed" })
    expect(validateCheckpoint([])).toEqual({ ok: false, reason: "malformed" })
  })

  it("classifies an unknown schema version as blocked, never coerced to current defaults", () => {
    const bad = { ...minimalCheckpoint(), schemaVersion: 2 }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "unsupported-schema-version" })
  })

  it("classifies a missing schemaVersion as unsupported rather than defaulting to 1", () => {
    const { schemaVersion: _drop, ...rest } = minimalCheckpoint()
    expect(validateCheckpoint(rest)).toEqual({ ok: false, reason: "unsupported-schema-version" })
  })

  it("rejects a checkpoint missing a required top-level field as malformed", () => {
    const { identity: _drop, ...rest } = minimalCheckpoint()
    expect(validateCheckpoint(rest)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a checkpoint with a wrong-typed required field as malformed", () => {
    const bad = { ...minimalCheckpoint(), revision: "1" }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects forged artifact pointers before projection/finalization can consume them", () => {
    const checkpoint = minimalCheckpoint()
    const fullRef = {
      uri: "artifact://run/run-1/art-1" as const,
      runId: "run-1",
      artifactId: "art-1",
      kind: "tool-result" as const,
      mediaType: "text/plain",
      capturedBytes: 12,
      sourceBytes: 12,
      complete: true,
      sha256: "a".repeat(64),
      createdAt: 1,
    }
    const withArtifact = sealCheckpointIntegrity({
      ...checkpoint,
      messages: [
        {
          messageId: "m1",
          message: {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "t1", content: "preview", artifact: fullRef },
            ],
          },
        },
      ],
    })
    expect(validateCheckpoint(withArtifact).ok).toBe(true)
    const forged = sealCheckpointIntegrity({
      ...withArtifact,
      messages: [
        {
          ...withArtifact.messages[0]!,
          message: {
            ...withArtifact.messages[0]!.message,
            content: [
              {
                type: "tool_result",
                toolUseId: "t1",
                content: "preview",
                artifact: { ...fullRef, sha256: "not-a-digest" },
              },
            ],
          },
        },
      ],
    } as AgentRunCheckpointV1)
    expect(validateCheckpoint(forged)).toEqual({ ok: false, reason: "malformed" })
  })

  it("requires a resolved tool artifact summary and full ref to appear together", () => {
    const checkpoint = minimalCheckpoint()
    const fullRef = {
      uri: "artifact://run/run-1/art-1" as const,
      runId: "run-1",
      artifactId: "art-1",
      kind: "tool-result" as const,
      mediaType: "text/plain",
      capturedBytes: 12,
      sourceBytes: 12,
      complete: true,
      sha256: "a".repeat(64),
      createdAt: 1,
    }
    const summary = {
      uri: fullRef.uri,
      kind: fullRef.kind,
      mediaType: fullRef.mediaType,
      capturedBytes: fullRef.capturedBytes,
      complete: fullRef.complete,
    }
    const paired = sealCheckpointIntegrity({
      ...checkpoint,
      messages: [
        {
          messageId: "a1",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "unknown", input: {} }],
          },
        },
      ],
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "r1",
          calls: [
            {
              ordinal: 0,
              toolUseId: "t1",
              safeName: "unknown",
              fqName: "unknown",
              input: {},
              annotations: {},
              replayGuarantee: "none",
              approval: { status: "not_required" },
              attempts: [],
              resolution: {
                status: "resolved",
                reason: "invalid-tool-call",
                result: { isError: true, preview: "missing", complete: false, artifact: summary },
                fullArtifact: fullRef,
              },
            },
          ],
        },
      ],
    })
    expect(validateCheckpoint(paired).ok).toBe(true)

    const pairedResolution = paired.toolBatches[0]!.calls[0]!.resolution
    if (pairedResolution.status !== "resolved") throw new Error("fixture must be resolved")

    const dangling = sealCheckpointIntegrity({
      ...paired,
      toolBatches: [
        {
          ...paired.toolBatches[0]!,
          calls: [
            {
              ...paired.toolBatches[0]!.calls[0]!,
              resolution: {
                ...pairedResolution,
                fullArtifact: undefined,
              },
            },
          ],
        },
      ],
    })
    expect(validateCheckpoint(dangling)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects authority or frozen context whose digest no longer matches its payload", () => {
    const checkpoint = minimalCheckpoint()
    expect(
      validateCheckpoint({
        ...checkpoint,
        config: {
          ...checkpoint.config,
          authority: { ...checkpoint.config.authority, integrityHash: "0".repeat(64) },
        },
      })
    ).toEqual({ ok: false, reason: "malformed" })
    expect(
      validateCheckpoint({
        ...checkpoint,
        config: {
          ...checkpoint.config,
          context: {
            ...checkpoint.config.context,
            baseSystemPrompt: {
              ...checkpoint.config.context.baseSystemPrompt,
              normalizedText: "tampered after setup",
            },
          },
        },
      })
    ).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects dangling ledger references and a finalization ledger inconsistent with status", () => {
    const checkpoint = minimalCheckpoint()
    expect(
      validateCheckpoint({
        ...checkpoint,
        modelSteps: [{ step: 0, acceptedAttemptId: "missing", attempts: [] }],
      })
    ).toEqual({ ok: false, reason: "malformed" })
    expect(
      validateCheckpoint({
        ...checkpoint,
        status: "completed",
        finalization: {
          finalizationId: "f1",
          desiredStatus: "failed",
          phase: "complete",
          outcome: "error",
          stopReason: "error",
          endedAt: 1,
          trace: {
            runId: "different-run",
            origin: "interactive",
            startedAt: 1,
            endedAt: 1,
            outcome: "error",
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
    ).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects an unrecognized status value as malformed", () => {
    const bad = { ...minimalCheckpoint(), status: "not-a-real-status" }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects non-array ledger fields as malformed", () => {
    const bad = { ...minimalCheckpoint(), modelSteps: {} }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects an unrecognized run origin", () => {
    const checkpoint = minimalCheckpoint()
    const bad = { ...checkpoint, identity: { ...checkpoint.identity, origin: "not-a-real-origin" } }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a recovery disposition with an unrecognized review reason", () => {
    const bad = {
      ...minimalCheckpoint(),
      recovery: { kind: "requires_review", reason: "not-a-real-reason" },
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a recovery disposition with an unrecognized blocked reason", () => {
    const bad = { ...minimalCheckpoint(), recovery: { kind: "blocked", reason: "made-up" } }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("accepts every real recovery disposition shape", () => {
    expect(validateCheckpoint({ ...minimalCheckpoint(), recovery: { kind: "automatic" } }).ok).toBe(
      true
    )
    expect(
      validateCheckpoint({
        ...minimalCheckpoint(),
        recovery: { kind: "requires_review", reason: "authority-narrowed" },
      }).ok
    ).toBe(true)
    expect(
      validateCheckpoint({
        ...minimalCheckpoint(),
        recovery: { kind: "blocked", reason: "deadline-expired" },
      }).ok
    ).toBe(true)
  })

  it("validates durable accepted recovery decisions", () => {
    expect(
      validateCheckpoint({
        ...minimalCheckpoint(),
        acceptedRecoveryDecision: {
          decisionId: "decision-1",
          kind: "retry",
          reason: "workspace-binding-changed",
          basisHash: "basis-1",
          acceptedAt: 1,
        },
      }).ok
    ).toBe(true)
    expect(
      validateCheckpoint({
        ...minimalCheckpoint(),
        acceptedRecoveryDecision: {
          decisionId: "decision-1",
          kind: "retry",
          reason: "not-a-recovery-reason",
          basisHash: "basis-1",
          acceptedAt: 1,
        },
      }).ok
    ).toBe(false)
  })

  it("rejects a context-compression fraction outside 0..1", () => {
    const checkpoint = minimalCheckpoint()
    const bad = {
      ...checkpoint,
      config: {
        ...checkpoint.config,
        contextCompression: { ...checkpoint.config.contextCompression, keepRecentFraction: 1.5 },
      },
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a negative token count in the frozen resolved profile", () => {
    const checkpoint = minimalCheckpoint()
    const bad = {
      ...checkpoint,
      config: {
        ...checkpoint.config,
        resolvedProfile: { ...checkpoint.config.resolvedProfile, contextWindowTokens: -1 },
      },
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a forged tool authority entry with an unrecognized provenance", () => {
    const checkpoint = minimalCheckpoint()
    const bad = {
      ...checkpoint,
      config: {
        ...checkpoint.config,
        authority: {
          ...checkpoint.config.authority,
          tools: [
            {
              fqName: "x",
              safeName: "x",
              provenance: "forged",
              ownerId: "o",
              ownerVersion: "1",
              modelSchemaHash: "h",
              annotationsHash: "h",
              invocationAdapterId: "a",
              invocationAdapterVersion: "1",
              replayGuarantee: "none",
            },
          ],
        },
      },
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a context snapshot missing its aggregate hash", () => {
    const checkpoint = minimalCheckpoint()
    const { aggregateHash: _drop, ...contextWithoutHash } = checkpoint.config.context
    const bad = {
      ...checkpoint,
      config: { ...checkpoint.config, context: contextWithoutHash },
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a context snapshot missing its skill catalog", () => {
    const checkpoint = minimalCheckpoint()
    const { skillCatalog: _drop, ...contextWithoutSkillCatalog } = checkpoint.config.context
    const bad = {
      ...checkpoint,
      config: { ...checkpoint.config, context: contextWithoutSkillCatalog },
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a skill catalog entry with an unrecognized source or trust value", () => {
    const checkpoint = minimalCheckpoint()
    const entry = {
      id: "user:a",
      name: "a",
      description: "desc",
      source: "user",
      trust: "user-authored",
    }
    expect(
      validateCheckpoint({
        ...checkpoint,
        config: {
          ...checkpoint.config,
          context: {
            ...checkpoint.config.context,
            skillCatalog: [{ ...entry, source: "not-a-real-source" }],
          },
        },
      })
    ).toEqual({ ok: false, reason: "malformed" })
    expect(
      validateCheckpoint({
        ...checkpoint,
        config: {
          ...checkpoint.config,
          context: {
            ...checkpoint.config.context,
            skillCatalog: [{ ...entry, trust: "not-a-real-trust" }],
          },
        },
      })
    ).toEqual({ ok: false, reason: "malformed" })
  })

  it("accepts a well-formed skill catalog entry", () => {
    const checkpoint = minimalCheckpoint()
    const good = {
      ...checkpoint,
      config: {
        ...checkpoint.config,
        context: {
          ...checkpoint.config.context,
          skillCatalog: [
            {
              id: "user:a",
              name: "a",
              description: "desc",
              source: "user" as const,
              trust: "user-authored" as const,
            },
          ],
        },
      },
    }
    // Real integrity requires re-sealing since skillCatalog content changed.
    expect(validateCheckpoint(sealCheckpointIntegrity(good)).ok).toBe(true)
  })

  it("rejects a durable message with an unrecognized role", () => {
    const bad = {
      ...minimalCheckpoint(),
      messages: [{ messageId: "m1", message: { role: "system", content: [] } }],
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a tool batch whose ordinals are not exactly 0..n-1 in order", () => {
    const bad = {
      ...minimalCheckpoint(),
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "r1",
          calls: [
            {
              ordinal: 1,
              toolUseId: "t1",
              safeName: "x",
              fqName: "x",
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
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a model attempt with an unrecognized budget-admission state", () => {
    const bad = {
      ...minimalCheckpoint(),
      modelSteps: [
        {
          step: 0,
          attempts: [
            {
              attemptId: "a1",
              requestHash: "h1",
              state: "prepared",
              admission: {
                operationId: "op1",
                accountId: "root",
                estimatorId: "e",
                estimatorVersion: "1",
                inputUpperBoundTokens: 0,
                maxOutputTokens: 0,
                heldTokens: 0,
                state: "not-a-real-state",
              },
            },
          ],
        },
      ],
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects a finalization ledger with an unrecognized phase", () => {
    const bad = {
      ...minimalCheckpoint(),
      finalization: {
        finalizationId: "f1",
        desiredStatus: "completed",
        phase: "not-a-real-phase",
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
        traceHash: canonicalHash({
          runId: "run-1",
          origin: "interactive",
          startedAt: 1,
          endedAt: 1,
          outcome: "end_turn",
          toolCalls: [],
        }),
        resourceReleasePlan: {
          budgetOperationIds: [],
          skillPackageLeaseIds: [],
          releaseArtifactRunPin: false,
          adoptionLeaseIds: [],
        },
      },
    }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("accepts a well-formed finalization ledger", () => {
    const good = {
      ...minimalCheckpoint(),
      status: "completed",
      finalization: {
        finalizationId: "f1",
        desiredStatus: "completed",
        phase: "complete",
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
        traceHash: canonicalHash({
          runId: "run-1",
          origin: "interactive",
          startedAt: 1,
          endedAt: 1,
          outcome: "end_turn",
          toolCalls: [],
        }),
        resourceReleasePlan: {
          budgetOperationIds: [],
          skillPackageLeaseIds: [],
          releaseArtifactRunPin: false,
          adoptionLeaseIds: [],
        },
        conversationReceipt: { status: "skipped", reason: "no-conversation" },
      },
    }
    expect(validateCheckpoint(good).ok).toBe(true)
  })
})
