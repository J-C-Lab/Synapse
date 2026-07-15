import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { describe, expect, it } from "vitest"
import { validateCheckpoint } from "./checkpoint-schema"

function minimalCheckpoint(): AgentRunCheckpointV1 {
  return {
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
  }
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

  it("rejects an unrecognized status value as malformed", () => {
    const bad = { ...minimalCheckpoint(), status: "not-a-real-status" }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects non-array ledger fields as malformed", () => {
    const bad = { ...minimalCheckpoint(), modelSteps: {} }
    expect(validateCheckpoint(bad)).toEqual({ ok: false, reason: "malformed" })
  })
})
