import type { AgentArtifactRef, ArtifactCaller } from "../artifacts/artifact-types"
import type { DurableChatMessage } from "../runs/durable-messages"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ArtifactQuotaExceededError } from "../artifacts/artifact-quota"
import { ArtifactStore, estimateManifestReserveBytes } from "../artifacts/artifact-store"
import { isSummaryMessage, SUMMARY_PREFIX } from "./context-compressor"
import {
  buildCompactionRecord,
  buildCompactionSummaryText,
  captureHistorySlice,
  ContextCompactionCorruptionError,
  deriveHistoryArtifactOwner,
  durableTailAfterCompaction,
  projectCompactedMessages,
} from "./history-artifact"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-history-artifact-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function owner() {
  return {
    runId: "run-1",
    rootRunId: "run-1",
    principal: { kind: "local-user" as const },
  }
}

function caller(overrides: Partial<ArtifactCaller> = {}): ArtifactCaller {
  return {
    runId: "run-1",
    rootRunId: "run-1",
    principal: { kind: "local-user" },
    ...overrides,
  }
}

function durable(
  messageId: string,
  text: string,
  role: "user" | "assistant" = "user"
): DurableChatMessage {
  return { messageId, message: { role, content: [{ type: "text", text }] } }
}

describe("captureHistorySlice", () => {
  it("captures the evicted durable slice as a history-kind artifact, full fidelity", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const evicted = [durable("m1", "hello"), durable("m2", "world", "assistant")]

    const ref = await captureHistorySlice(store, owner(), "run-1", evicted)

    expect(ref.kind).toBe("history")
    expect(ref.complete).toBe(true)
    expect(ref.mediaType).toContain("application/json")

    const bytes = await store.read(ref, { start: 0 }, caller())
    const roundtripped = JSON.parse(Buffer.from(bytes).toString("utf-8"))
    expect(roundtripped).toEqual(evicted)
  })

  it("round-trips Unicode content exactly (emoji, CJK, combining marks)", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const unicodeText = "héllo 🎉🚀 世界 — naïve café, Zürich, Ω≈ç√∫ end-to-end"
    const evicted = [durable("m1", unicodeText)]

    const ref = await captureHistorySlice(store, owner(), "run-1", evicted)
    const bytes = await store.read(ref, { start: 0 }, caller())
    const roundtripped = JSON.parse(Buffer.from(bytes).toString("utf-8")) as DurableChatMessage[]

    expect(roundtripped[0]!.message.content[0]).toEqual({ type: "text", text: unicodeText })
  })

  it("propagates a hard quota-exhaustion failure instead of swallowing it", async () => {
    const evicted = [durable("m1", "0123456789")]
    const manifestReserve = estimateManifestReserveBytes({
      runId: "run-1",
      owner: owner(),
      kind: "history",
      mediaType: "application/json; charset=utf-8",
    })
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      quotaLimits: {
        perArtifactBytes: 1000,
        // Deliberately less than even one manifest needs — true exhaustion,
        // the store rejects the capture outright rather than truncating.
        perRunBytes: manifestReserve - 1,
        globalBytes: 1_000_000,
        minFreeBytes: 0,
        minFreeFraction: 0,
        manifestReserveBytes: 0,
      },
    })

    await expect(captureHistorySlice(store, owner(), "run-1", evicted)).rejects.toBeInstanceOf(
      ArtifactQuotaExceededError
    )
  })
})

describe("buildCompactionSummaryText / buildCompactionRecord", () => {
  function fakeRef(overrides: Partial<AgentArtifactRef> = {}): AgentArtifactRef {
    return {
      uri: "artifact://run/run-1/artifact-1",
      runId: "run-1",
      artifactId: "artifact-1",
      kind: "history",
      mediaType: "application/json; charset=utf-8",
      capturedBytes: 42,
      complete: true,
      sha256: "deadbeef",
      createdAt: 1000,
      ...overrides,
    }
  }

  it("embeds the SUMMARY_PREFIX, the artifact uri, sha256, and archived count in the summary text", () => {
    const text = buildCompactionSummaryText("the recap", fakeRef(), 3)
    expect(text.startsWith(SUMMARY_PREFIX)).toBe(true)
    expect(text).toContain("the recap")
    expect(text).toContain("artifact://run/run-1/artifact-1")
    expect(text).toContain("deadbeef")
    expect(text).toContain("archivedMessages=3")
    expect(isSummaryMessage({ role: "user", content: [{ type: "text", text }] })).toBe(true)
  })

  it("still names the artifact when no summarizer text was produced this round", () => {
    const text = buildCompactionSummaryText(undefined, fakeRef(), 5)
    expect(text.startsWith(SUMMARY_PREFIX)).toBe(true)
    expect(text).toContain("artifact://run/run-1/artifact-1")
    expect(text.toLowerCase()).toContain("unavailable")
  })

  it("reports an incomplete artifact honestly rather than claiming full recovery", () => {
    const text = buildCompactionSummaryText(
      "recap",
      fakeRef({ complete: false, truncationReason: "run-limit" }),
      2
    )
    expect(text).toContain("incomplete")
    expect(text).toContain("run-limit")
  })

  it("buildCompactionRecord composes the full durable record", () => {
    const ref = fakeRef()
    const record = buildCompactionRecord({
      compactionId: "c1",
      evictedThroughMessageId: "m2",
      rawSummaryText: "recap",
      summarizerTokens: 7,
      artifact: ref,
      archivedMessageCount: 2,
      now: 12345,
    })
    expect(record.compactionId).toBe("c1")
    expect(record.evictedThroughMessageId).toBe("m2")
    expect(record.summarizerTokens).toBe(7)
    expect(record.createdAt).toBe(12345)
    expect(record.artifact.uri).toBe(ref.uri)
    expect(record.fullArtifact).toEqual(ref)
    expect(record.summaryText).toContain("recap")
  })
})

describe("durableTailAfterCompaction", () => {
  const messages = [durable("m1", "a"), durable("m2", "b"), durable("m3", "c")]

  it("returns every message when there is no active compaction", () => {
    expect(durableTailAfterCompaction(messages, undefined)).toEqual(messages)
  })

  it("returns only the messages after the compaction cutoff (exclusive)", () => {
    const record = buildCompactionRecord({
      compactionId: "c1",
      evictedThroughMessageId: "m1",
      summarizerTokens: 0,
      artifact: {
        uri: "artifact://run/run-1/a1",
        runId: "run-1",
        artifactId: "a1",
        kind: "history",
        mediaType: "application/json",
        capturedBytes: 1,
        complete: true,
        sha256: "h",
        createdAt: 1,
      },
      archivedMessageCount: 1,
      now: 1,
    })
    expect(durableTailAfterCompaction(messages, record)).toEqual([messages[1], messages[2]])
  })

  it("throws ContextCompactionCorruptionError when the cutoff id no longer exists", () => {
    const record = buildCompactionRecord({
      compactionId: "c1",
      evictedThroughMessageId: "does-not-exist",
      summarizerTokens: 0,
      artifact: {
        uri: "artifact://run/run-1/a1",
        runId: "run-1",
        artifactId: "a1",
        kind: "history",
        mediaType: "application/json",
        capturedBytes: 1,
        complete: true,
        sha256: "h",
        createdAt: 1,
      },
      archivedMessageCount: 1,
      now: 1,
    })
    expect(() => durableTailAfterCompaction(messages, record)).toThrow(
      ContextCompactionCorruptionError
    )
  })
})

describe("projectCompactedMessages", () => {
  const messages = [durable("m1", "a"), durable("m2", "b"), durable("m3", "c")]

  it("projects the full conversation verbatim with no active compaction", () => {
    const projected = projectCompactedMessages(messages, undefined)
    expect(projected).toEqual(messages.map((m) => m.message))
  })

  it("replaces the evicted prefix with a single summary message, keeping the tail verbatim", () => {
    const record = buildCompactionRecord({
      compactionId: "c1",
      evictedThroughMessageId: "m1",
      rawSummaryText: "recap",
      summarizerTokens: 0,
      artifact: {
        uri: "artifact://run/run-1/a1",
        runId: "run-1",
        artifactId: "a1",
        kind: "history",
        mediaType: "application/json",
        capturedBytes: 1,
        complete: true,
        sha256: "h",
        createdAt: 1,
      },
      archivedMessageCount: 1,
      now: 1,
    })
    const projected = projectCompactedMessages(messages, record)
    expect(projected).toHaveLength(3)
    expect(isSummaryMessage(projected[0]!)).toBe(true)
    expect(projected[1]).toEqual(messages[1]!.message)
    expect(projected[2]).toEqual(messages[2]!.message)
  })
})

describe("deriveHistoryArtifactOwner", () => {
  it("maps actor 'user' to a local-user principal and preserves identity fields", () => {
    const owned = deriveHistoryArtifactOwner(
      {
        runId: "run-1",
        rootRunId: "root-1",
        parentRunId: "parent-1",
        conversationId: "conv-1",
        workspaceId: "ws-1",
      },
      "user"
    )
    expect(owned).toEqual({
      runId: "run-1",
      rootRunId: "root-1",
      parentRunId: "parent-1",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      principal: { kind: "local-user" },
    })
  })

  it("maps actor 'background' to an internal-agent principal", () => {
    const owned = deriveHistoryArtifactOwner({ runId: "run-1", rootRunId: "run-1" }, "background")
    expect(owned.principal).toEqual({ kind: "internal-agent" })
  })
})
