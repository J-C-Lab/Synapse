import type { NormalizedCapability } from "@synapse/plugin-manifest"
import type { RegisteredToolDescriptor } from "../../plugins/types"
import type { ProviderToolSchema } from "../providers/types"
import type { FrozenAuthoritySnapshotV1 } from "./authority-snapshot"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { FrozenContextSnapshotV1 } from "./context-snapshot"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { freezeAuthoritySnapshot } from "./authority-snapshot"
import { skillCatalogHash } from "./context-snapshot"
import { classifyRunRecovery } from "./recovery-classifier"

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function schemaFor(name: string): ProviderToolSchema {
  return { name, description: `desc for ${name}`, inputSchema: { type: "object" } }
}

function hostDescriptor(
  name: string,
  overrides: Partial<RegisteredToolDescriptor> = {}
): RegisteredToolDescriptor {
  return {
    fqName: name,
    pluginId: "host",
    provenance: "host",
    manifestTool: { name, description: `desc ${name}`, inputSchema: { type: "object" } },
    ...overrides,
  }
}

function authoritySnapshot(input: {
  capabilities?: NormalizedCapability[]
  tools?: RegisteredToolDescriptor[]
  actor?: "user" | "background"
}): FrozenAuthoritySnapshotV1 {
  return freezeAuthoritySnapshot({
    principal: { kind: "interactive", actor: input.actor ?? "user" },
    capabilities: input.capabilities ?? [],
    tools: (input.tools ?? []).map((descriptor) => ({
      descriptor,
      safeName: descriptor.manifestTool.name,
      modelSchema: schemaFor(descriptor.manifestTool.name),
    })),
  })
}

function contextSnapshot(): FrozenContextSnapshotV1 {
  const baseSystemPrompt = {
    normalizedText: "You are helpful.",
    sha256: sha256("You are helpful."),
  }
  const workspaceInstructions = [
    {
      rootId: "root-1",
      sourcePath: "workspace:root-1/AGENTS.md",
      sourceKind: "workspace-instruction" as const,
      trust: "untrusted-workspace-instruction" as const,
      normalizedText: "do the thing",
      sha256: sha256("do the thing"),
    },
  ]
  const skillCatalog: FrozenContextSnapshotV1["skillCatalog"] = []
  const skillCatalogHashValue = skillCatalogHash(skillCatalog)
  const aggregateHash = sha256(
    [
      baseSystemPrompt.sha256,
      ...workspaceInstructions.map((i) => i.sha256),
      skillCatalogHashValue,
    ].join("|")
  )
  return {
    schemaVersion: 1,
    baseSystemPrompt,
    workspaceInstructions,
    skillCatalog,
    skillCatalogHash: skillCatalogHashValue,
    aggregateHash,
  }
}

function baseCheckpoint(overrides: Partial<AgentRunCheckpointV1> = {}): AgentRunCheckpointV1 {
  return {
    schemaVersion: 1,
    revision: 1,
    identity: { runId: "run-1", rootRunId: "run-1", origin: "interactive" },
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
      maxSteps: 10,
      contextCompression: {
        enabled: false,
        thresholdTokens: 0,
        keepRecentFraction: 0.5,
        hardReserveTokens: 0,
      },
      workspaceBinding: { bindingRevision: 0, rootIds: ["root-1"], rootSetHash: "root-set-hash-1" },
      authority: authoritySnapshot({}),
      context: contextSnapshot(),
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

describe("classifyRunRecovery — happy path", () => {
  it("returns automatic when nothing has drifted", () => {
    const authority = authoritySnapshot({ tools: [hostDescriptor("read_file")] })
    const checkpoint = baseCheckpoint({ config: { ...baseCheckpoint().config, authority } })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority: authority, now: 100 })
    expect(disposition).toEqual({ kind: "automatic" })
  })
})

describe("classifyRunRecovery — suspended_conversation_conflict short-circuits everything", () => {
  it("always classifies as requires_review/conversation-conflict regardless of other state", () => {
    const checkpoint = baseCheckpoint({ status: "suspended_conversation_conflict" })
    const disposition = classifyRunRecovery(checkpoint, {
      currentAuthority: authoritySnapshot({}),
      now: 100,
    })
    expect(disposition).toEqual({ kind: "requires_review", reason: "conversation-conflict" })
  })
})

describe("classifyRunRecovery — blocked", () => {
  it("blocks on a deleted/tombstoned conversation", () => {
    const checkpoint = baseCheckpoint({
      identity: { runId: "run-1", rootRunId: "run-1", origin: "interactive", conversationId: "c1" },
    })
    const disposition = classifyRunRecovery(checkpoint, {
      currentAuthority: authoritySnapshot({}),
      conversationExists: false,
      now: 100,
    })
    expect(disposition).toEqual({ kind: "blocked", reason: "conversation-deleted-or-missing" })
  })

  it("does not block when conversationExists is true", () => {
    const checkpoint = baseCheckpoint({
      identity: { runId: "run-1", rootRunId: "run-1", origin: "interactive", conversationId: "c1" },
    })
    const disposition = classifyRunRecovery(checkpoint, {
      currentAuthority: authoritySnapshot({}),
      conversationExists: true,
      now: 100,
    })
    expect(disposition).toEqual({ kind: "automatic" })
  })

  it("blocks when the principal no longer matches", () => {
    const checkpoint = baseCheckpoint()
    const disposition = classifyRunRecovery(checkpoint, {
      currentAuthority: authoritySnapshot({ actor: "background" }),
      now: 100,
    })
    expect(disposition).toEqual({ kind: "blocked", reason: "authority-revoked" })
  })

  it("blocks when a granted capability was fully revoked", () => {
    const frozenAuthority = authoritySnapshot({
      capabilities: [{ id: "fs:read", scope: { paths: ["/workspace/**"] } }],
    })
    const currentAuthority = authoritySnapshot({}) // capability gone entirely
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority: frozenAuthority },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority, now: 100 })
    expect(disposition).toEqual({ kind: "blocked", reason: "authority-revoked" })
  })

  it("classifies frozen-context-corrupt when a stored hash no longer matches its text", () => {
    const corrupted: FrozenContextSnapshotV1 = {
      ...contextSnapshot(),
      baseSystemPrompt: { normalizedText: "You are helpful.", sha256: "tampered-hash" },
    }
    const authority = authoritySnapshot({})
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority, context: corrupted },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority: authority, now: 100 })
    expect(disposition).toEqual({ kind: "blocked", reason: "frozen-context-corrupt" })
  })

  it("blocks on an expired deadline", () => {
    const authority = authoritySnapshot({})
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority, deadlineAt: 500 },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority: authority, now: 501 })
    expect(disposition).toEqual({ kind: "blocked", reason: "deadline-expired" })
  })

  it("blocks an early v1 background run that lacks a durable execution policy", () => {
    const authority = authoritySnapshot({})
    const checkpoint = baseCheckpoint({
      identity: {
        runId: "background-legacy",
        rootRunId: "background-legacy",
        origin: "background-agent",
      },
      config: { ...baseCheckpoint().config, authority },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority: authority, now: 100 })
    expect(disposition).toEqual({ kind: "blocked", reason: "background-execution-policy-missing" })
  })

  it("blocks when now is exactly at the deadline", () => {
    const authority = authoritySnapshot({})
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority, deadlineAt: 500 },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority: authority, now: 500 })
    expect(disposition).toEqual({ kind: "blocked", reason: "deadline-expired" })
  })
})

describe("classifyRunRecovery — requires_review", () => {
  it("flags a narrowed fs:read capability scope", () => {
    const frozenAuthority = authoritySnapshot({
      capabilities: [{ id: "fs:read", scope: { paths: ["/workspace/**"] } }],
    })
    const currentAuthority = authoritySnapshot({
      capabilities: [{ id: "fs:read", scope: { paths: ["/workspace/sub/**"] } }],
    })
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority: frozenAuthority },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority, now: 100 })
    expect(disposition).toEqual({ kind: "requires_review", reason: "authority-narrowed" })
  })

  it("flags a tool that no longer exists", () => {
    const frozenAuthority = authoritySnapshot({ tools: [hostDescriptor("read_file")] })
    const currentAuthority = authoritySnapshot({}) // tool gone
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority: frozenAuthority },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority, now: 100 })
    expect(disposition).toEqual({ kind: "requires_review", reason: "tool-removed-or-changed" })
  })

  it("flags a tool whose schema changed", () => {
    const frozenAuthority = authoritySnapshot({ tools: [hostDescriptor("read_file")] })
    const currentAuthority = freezeAuthoritySnapshot({
      principal: { kind: "interactive", actor: "user" },
      capabilities: [],
      tools: [
        {
          descriptor: hostDescriptor("read_file"),
          safeName: "read_file",
          modelSchema: {
            ...schemaFor("read_file"),
            description: "a totally different description",
          },
        },
      ],
    })
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority: frozenAuthority },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority, now: 100 })
    expect(disposition).toEqual({ kind: "requires_review", reason: "tool-removed-or-changed" })
  })

  it("flags a changed workspace root set hash", () => {
    const authority = authoritySnapshot({})
    const checkpoint = baseCheckpoint({ config: { ...baseCheckpoint().config, authority } })
    const disposition = classifyRunRecovery(checkpoint, {
      currentAuthority: authority,
      currentWorkspaceRootSetHash: "a-different-hash",
      now: 100,
    })
    expect(disposition).toEqual({ kind: "requires_review", reason: "workspace-binding-changed" })
  })

  it("does not flag workspace binding when the hash matches", () => {
    const authority = authoritySnapshot({})
    const checkpoint = baseCheckpoint({ config: { ...baseCheckpoint().config, authority } })
    const disposition = classifyRunRecovery(checkpoint, {
      currentAuthority: authority,
      currentWorkspaceRootSetHash: "root-set-hash-1",
      now: 100,
    })
    expect(disposition).toEqual({ kind: "automatic" })
  })

  it("flags a call with a started attempt and no resolution as unknown-tool-outcome", () => {
    const authority = authoritySnapshot({})
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority },
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "carrier-1",
          calls: [
            {
              ordinal: 0,
              toolUseId: "t1",
              safeName: "read_file",
              fqName: "read_file",
              input: {},
              annotations: {},
              replayGuarantee: "none",
              approval: { status: "not_required" },
              attempts: [
                {
                  attemptId: "attempt-1",
                  invocationId: "inv-1",
                  invocationFingerprint: "fp-1",
                  state: { status: "started", startedAt: 1 },
                },
              ],
              resolution: { status: "unresolved" },
            },
          ],
        },
      ],
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority: authority, now: 100 })
    expect(disposition).toEqual({ kind: "requires_review", reason: "unknown-tool-outcome" })
  })

  it("does not flag a resolved call even if its attempt is still marked unknown", () => {
    const authority = authoritySnapshot({})
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority },
      toolBatches: [
        {
          modelStep: 0,
          assistantMessageId: "a1",
          resultCarrierMessageId: "carrier-1",
          calls: [
            {
              ordinal: 0,
              toolUseId: "t1",
              safeName: "read_file",
              fqName: "read_file",
              input: {},
              annotations: {},
              replayGuarantee: "none",
              approval: { status: "not_required" },
              attempts: [
                {
                  attemptId: "attempt-1",
                  invocationId: "inv-1",
                  invocationFingerprint: "fp-1",
                  state: { status: "unknown", startedAt: 1, reason: "process-exit" },
                },
              ],
              resolution: {
                status: "resolved",
                reason: "user-marked-failed",
                result: { isError: true, preview: "failed", complete: true },
                attemptId: "attempt-1",
              },
            },
          ],
        },
      ],
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority: authority, now: 100 })
    expect(disposition).toEqual({ kind: "automatic" })
  })
})

describe("classifyRunRecovery — priority ordering", () => {
  it("blocked always wins over a simultaneous requires_review condition", () => {
    const frozenAuthority = authoritySnapshot({
      capabilities: [{ id: "fs:read", scope: { paths: ["/workspace/**"] } }],
      tools: [hostDescriptor("read_file")],
    })
    // Revoked principal (blocked) AND a removed tool (requires_review) at once.
    const currentAuthority = authoritySnapshot({ actor: "background" })
    const checkpoint = baseCheckpoint({
      config: { ...baseCheckpoint().config, authority: frozenAuthority },
    })
    const disposition = classifyRunRecovery(checkpoint, { currentAuthority, now: 100 })
    expect(disposition).toEqual({ kind: "blocked", reason: "authority-revoked" })
  })
})
