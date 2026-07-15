import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AgentRunStore,
  CheckpointCorruptionError,
  InvalidRunIdError,
  RunNotFoundError,
  StaleRevisionError,
} from "./agent-run-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-agent-run-store-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function checkpoint(runId: string): AgentRunCheckpointV1 {
  return {
    schemaVersion: 1,
    revision: 0, // create() always normalizes to 1 — proves it doesn't trust the caller's value
    identity: { runId, rootRunId: runId, origin: "interactive" },
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

describe("agentRunStore — create/load", () => {
  it("creates a run, always starting at revision 1", async () => {
    const store = new AgentRunStore(dir)
    const created = await store.create(checkpoint("run-1"))
    expect(created.revision).toBe(1)
    const result = await store.load("run-1")
    expect(result).toEqual({ ok: true, checkpoint: created })
  })

  it("refuses to create a run id that already exists", async () => {
    const store = new AgentRunStore(dir)
    await store.create(checkpoint("run-1"))
    await expect(store.create(checkpoint("run-1"))).rejects.toThrow(/already exists/)
  })

  it("throws RunNotFoundError for a missing run", async () => {
    const store = new AgentRunStore(dir)
    await expect(store.load("nope")).rejects.toThrow(RunNotFoundError)
  })
})

describe("agentRunStore — path traversal safety", () => {
  it("rejects traversal-shaped run ids before any path is constructed", async () => {
    const store = new AgentRunStore(dir)
    for (const badId of ["../escape", "a/b", "a\\b", "..", "."]) {
      await expect(store.load(badId)).rejects.toThrow(InvalidRunIdError)
      await expect(store.create(checkpoint(badId))).rejects.toThrow(InvalidRunIdError)
    }
    // No file escaped the run store directory.
    const entries = await fs.readdir(dir)
    expect(entries).toEqual([])
  })
})

describe("agentRunStore — expectedRevision CAS", () => {
  it("mutates successfully under the correct expectedRevision, bumping it by one", async () => {
    const store = new AgentRunStore(dir)
    const created = await store.create(checkpoint("run-1"))
    const mutated = await store.mutate(created.identity.runId, 1, (cp) => ({
      ...cp,
      status: "running",
    }))
    expect(mutated.revision).toBe(2)
    expect(mutated.status).toBe("running")
  })

  it("rejects a stale writer with a typed conflict and leaves the checkpoint unchanged", async () => {
    const store = new AgentRunStore(dir)
    const created = await store.create(checkpoint("run-1"))
    await store.mutate(created.identity.runId, 1, (cp) => ({ ...cp, status: "running" }))

    await expect(
      store.mutate(created.identity.runId, 1, (cp) => ({ ...cp, status: "failed" }))
    ).rejects.toThrow(StaleRevisionError)

    const current = await store.load("run-1")
    expect(current.ok && current.checkpoint.status).toBe("running")
    expect(current.ok && current.checkpoint.revision).toBe(2)
  })

  it("serializes two concurrent mutate calls so exactly one succeeds at each revision", async () => {
    const store = new AgentRunStore(dir)
    const created = await store.create(checkpoint("run-1"))
    const results = await Promise.allSettled([
      store.mutate(created.identity.runId, 1, (cp) => ({ ...cp, status: "running" })),
      store.mutate(created.identity.runId, 1, (cp) => ({ ...cp, status: "failed" })),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleRevisionError)
  })
})

describe("agentRunStore — corruption handling", () => {
  it("distinguishes a corrupt checkpoint file from a missing run", async () => {
    const store = new AgentRunStore(dir)
    await store.create(checkpoint("run-1"))
    await fs.writeFile(join(dir, "run-1", "checkpoint.json"), "{ not valid json", "utf-8")

    const result = await store.load("run-1")
    expect(result).toEqual({ ok: false, reason: "malformed" })
  })

  it("throws CheckpointCorruptionError from mutate() rather than silently repairing it", async () => {
    const store = new AgentRunStore(dir)
    await store.create(checkpoint("run-1"))
    await fs.writeFile(join(dir, "run-1", "checkpoint.json"), "{ not valid json", "utf-8")

    await expect(store.mutate("run-1", 1, (cp) => cp)).rejects.toThrow(CheckpointCorruptionError)
  })

  it("classifies an unsupported schema version as blocked without touching the file", async () => {
    const store = new AgentRunStore(dir)
    await store.create(checkpoint("run-1"))
    const raw = await fs.readFile(join(dir, "run-1", "checkpoint.json"), "utf-8")
    await fs.writeFile(
      join(dir, "run-1", "checkpoint.json"),
      JSON.stringify({ ...JSON.parse(raw), schemaVersion: 99 }),
      "utf-8"
    )

    const result = await store.load("run-1")
    expect(result).toEqual({ ok: false, reason: "unsupported-schema-version" })
    await expect(store.mutate("run-1", 1, (cp) => cp)).rejects.toThrow(CheckpointCorruptionError)
  })
})

describe("agentRunStore — scan", () => {
  it("scans every run without throwing on a corrupt one, and can filter to non-terminal runs", async () => {
    const store = new AgentRunStore(dir)
    await store.create(checkpoint("run-active"))
    const terminal = await store.create(checkpoint("run-done"))
    await store.mutate(terminal.identity.runId, 1, (cp) => ({ ...cp, status: "terminalizing" }))
    await store.mutate("run-done", 2, (cp) => ({ ...cp, status: "completed" }))
    await store.create(checkpoint("run-corrupt"))
    await fs.writeFile(join(dir, "run-corrupt", "checkpoint.json"), "{ nope", "utf-8")

    const all = await store.scan()
    expect(all.map((e) => e.runId).sort()).toEqual(["run-active", "run-corrupt", "run-done"])
    const corruptEntry = all.find((e) => e.runId === "run-corrupt")
    expect(corruptEntry?.result).toEqual({ ok: false, reason: "malformed" })

    const nonTerminal = await store.scan({ nonTerminalOnly: true })
    expect(nonTerminal.map((e) => e.runId).sort()).toEqual(["run-active", "run-corrupt"])
  })
})
