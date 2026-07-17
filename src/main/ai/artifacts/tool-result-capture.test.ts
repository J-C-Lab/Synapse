import type { AgentArtifactRef, ArtifactCaller, ArtifactOwnerContext } from "./artifact-types"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ArtifactStore } from "./artifact-store"
import {
  captureToolResultText,
  DEFAULT_CAPTURE_THRESHOLD_CHARS,
  EMERGENCY_INLINE_CAP_CHARS,
  toArtifactSummary,
} from "./tool-result-capture"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-tool-result-capture-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function owner(overrides: Partial<ArtifactOwnerContext> = {}): ArtifactOwnerContext {
  return {
    runId: "run-1",
    rootRunId: "run-1",
    principal: { kind: "internal-agent" },
    ...overrides,
  }
}

function caller(overrides: Partial<ArtifactCaller> = {}): ArtifactCaller {
  return {
    runId: "run-1",
    rootRunId: "run-1",
    principal: { kind: "internal-agent" },
    ...overrides,
  }
}

describe("captureToolResultText — below threshold", () => {
  it("returns the raw text unchanged, complete, with no artifact", async () => {
    const result = await captureToolResultText("hello world", undefined)
    expect(result).toEqual({ previewText: "hello world", complete: true, offloadFailed: false })
  })

  it("respects a custom captureThresholdChars", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const text = "x".repeat(100)
    const result = await captureToolResultText(
      text,
      { store, owner: owner() },
      { captureThresholdChars: 200 }
    )
    expect(result).toEqual({ previewText: text, complete: true, offloadFailed: false })
  })

  it("uses the default 24_000-char threshold when unspecified", async () => {
    const text = "x".repeat(DEFAULT_CAPTURE_THRESHOLD_CHARS)
    const result = await captureToolResultText(text, undefined)
    expect(result.previewText).toBe(text)
    expect(result.complete).toBe(true)
  })
})

describe("captureToolResultText — successful offload", () => {
  it("captures the full text as a tool-result artifact and returns a head+tail preview", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const head = "HEAD".repeat(50)
    const middle = "middle-content-not-in-preview ".repeat(200)
    const tail = "TAIL".repeat(50)
    const text = `${head}${middle}${tail}`

    const result = await captureToolResultText(
      text,
      { store, owner: owner() },
      { captureThresholdChars: 100, headPreviewChars: 200, tailPreviewChars: 200 }
    )

    expect(result.complete).toBe(true)
    expect(result.offloadFailed).toBe(false)
    expect(result.artifact).toBeDefined()
    expect(result.artifact?.kind).toBe("tool-result")
    expect(result.artifact?.mediaType).toBe("text/plain; charset=utf-8")
    expect(result.artifact?.complete).toBe(true)
    expect(result.fullArtifact).toBeDefined()
    expect(result.fullArtifact?.uri).toBe(result.artifact?.uri)
    expect(result.fullArtifact?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.fullArtifact?.capturedBytes).toBe(Buffer.byteLength(text, "utf-8"))

    expect(result.previewText).toContain(head.slice(0, 50))
    expect(result.previewText).toContain(tail.slice(-50))
    expect(result.previewText).not.toContain("middle-content-not-in-preview")
    expect(result.previewText).toContain(result.fullArtifact!.uri)
    expect(result.previewText).toContain(result.fullArtifact!.sha256)
    expect(result.previewText).toContain("read_artifact")

    // The artifact really is readable back through the store, independent
    // of this module — proves capture() was actually invoked, not stubbed.
    const readBack = await store.read(result.fullArtifact!, { start: 0 }, caller())
    expect(new TextDecoder().decode(readBack)).toBe(text)
  })

  it("projects the summary from the full ref via toArtifactSummary", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const text = "y".repeat(500)
    const result = await captureToolResultText(
      text,
      { store, owner: owner() },
      { captureThresholdChars: 10 }
    )
    expect(result.artifact).toEqual(toArtifactSummary(result.fullArtifact!))
  })

  it("surfaces a truncated capture (store's own limit) as incomplete with a visible reason", async () => {
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      quotaLimits: {
        perArtifactBytes: 50,
        perRunBytes: 10_000,
        globalBytes: 100_000,
        minFreeBytes: 0,
        minFreeFraction: 0,
        manifestReserveBytes: 4096,
      },
    })
    const text = "z".repeat(1000)

    const result = await captureToolResultText(
      text,
      { store, owner: owner() },
      { captureThresholdChars: 10, headPreviewChars: 20, tailPreviewChars: 20 }
    )

    expect(result.complete).toBe(false)
    expect(result.artifact?.complete).toBe(false)
    expect(result.artifact?.truncationReason).toBe("artifact-limit")
    expect(result.previewText).toContain("incomplete")
    expect(result.previewText).toContain("artifact-limit")
  })
})

describe("captureToolResultText — no backend available", () => {
  it("falls back to a bounded inline head+tail preview, marked incomplete, no artifact", async () => {
    const text = "a".repeat(1000)
    const result = await captureToolResultText(text, undefined, {
      captureThresholdChars: 10,
      headPreviewChars: 20,
      tailPreviewChars: 20,
    })

    expect(result.complete).toBe(false)
    expect(result.offloadFailed).toBe(false)
    expect(result.artifact).toBeUndefined()
    expect(result.fullArtifact).toBeUndefined()
    expect(result.previewText).toContain("a".repeat(20))
    expect(result.previewText).toContain("no active run context")
    expect(result.previewText.length).toBeLessThan(text.length)
  })
})

describe("captureToolResultText — offload failure", () => {
  it("marks offloadFailed and keeps the inline result within the emergency cap when capture() throws", async () => {
    const throwingStore = {
      capture: async () => {
        throw new Error("disk exploded")
      },
      stat: async (ref: AgentArtifactRef) => ref,
      read: async () => new Uint8Array(0),
      releaseRunPin: async () => {},
      collectEligible: async () => ({
        reconciledReservations: 0,
        reclaimedReservedBytes: 0,
        orphanedTempFilesRemoved: 0,
        deletedArtifacts: 0,
        deletedBytes: 0,
      }),
    }
    const text = "b".repeat(1000)

    const result = await captureToolResultText(
      text,
      { store: throwingStore, owner: owner() },
      { captureThresholdChars: 10, headPreviewChars: 20, tailPreviewChars: 20 }
    )

    expect(result.complete).toBe(false)
    expect(result.offloadFailed).toBe(true)
    expect(result.artifact).toBeUndefined()
    expect(result.previewText).toContain("failed")
    expect(result.previewText.length).toBeLessThanOrEqual(EMERGENCY_INLINE_CAP_CHARS + 200)
  })

  it("never silently discards content — the failure is stated explicitly in the preview text", async () => {
    const throwingStore = {
      capture: async () => {
        throw new Error("boom")
      },
      stat: async (ref: AgentArtifactRef) => ref,
      read: async () => new Uint8Array(0),
      releaseRunPin: async () => {},
      collectEligible: async () => ({
        reconciledReservations: 0,
        reclaimedReservedBytes: 0,
        orphanedTempFilesRemoved: 0,
        deletedArtifacts: 0,
        deletedBytes: 0,
      }),
    }
    const result = await captureToolResultText(
      "c".repeat(500),
      { store: throwingStore, owner: owner() },
      {
        captureThresholdChars: 10,
      }
    )
    expect(result.previewText).toMatch(/failed|incomplete/i)
  })
})

describe("captureToolResultText — emergency cap", () => {
  it("bounds the composed preview even with an oversized configured head/tail split", async () => {
    const text = "d".repeat(1_000_000)
    const result = await captureToolResultText(text, undefined, {
      captureThresholdChars: 10,
      headPreviewChars: 500_000,
      tailPreviewChars: 500_000,
      emergencyCapChars: 1000,
    })
    expect(result.previewText.length).toBeLessThanOrEqual(1200)
  })
})
