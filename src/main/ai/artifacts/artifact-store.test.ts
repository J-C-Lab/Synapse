import type { ArtifactCaller, ArtifactMetadata, ArtifactOwnerContext } from "./artifact-types"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ArtifactQuotaStore } from "./artifact-quota"
import { artifactsRoot, ArtifactStore } from "./artifact-store"
import { ArtifactReadError } from "./artifact-types"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-artifact-store-"))
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

function metadata(overrides: Partial<ArtifactMetadata> = {}): ArtifactMetadata {
  return {
    runId: "run-1",
    owner: owner(),
    kind: "tool-result",
    mediaType: "text/plain",
    ...overrides,
  }
}

function noopProducer() {
  const aborts: string[] = []
  return {
    abort: (reason: string) => {
      aborts.push(reason)
    },
    aborts,
  }
}

async function* gen(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe("artifactsRoot", () => {
  it("nests under an artifacts/ subdirectory of userData", () => {
    expect(artifactsRoot("/user/data")).toBe(join("/user/data", "artifacts"))
  })
})

describe("artifactStore.capture / stat / read — happy path", () => {
  it("round-trips content hash, length, and bytes exactly", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const content = bytesOf("hello, artifact store")
    const producer = noopProducer()
    const ref = await store.capture(content, metadata(), producer)

    expect(ref.complete).toBe(true)
    expect(ref.truncationReason).toBeUndefined()
    expect(ref.capturedBytes).toBe(content.length)
    expect(ref.sha256).toBe(createHash("sha256").update(content).digest("hex"))
    expect(ref.uri).toBe(`artifact://run/run-1/${ref.artifactId}`)
    expect(producer.aborts).toEqual([])

    const statted = await store.stat(ref, caller())
    expect(statted).toEqual(ref)

    const read = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("hello, artifact store")
  })

  it("captures from an AsyncIterable across multiple chunks", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const chunks = [bytesOf("chunk-one "), bytesOf("chunk-two "), bytesOf("chunk-three")]
    const ref = await store.capture(gen(chunks), metadata(), noopProducer())
    const read = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("chunk-one chunk-two chunk-three")
    expect(ref.complete).toBe(true)
  })

  it("round-trips arbitrary binary content, not just UTF-8 text", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const binary = new Uint8Array([0, 1, 2, 255, 254, 253, 0x80, 0x81, 10, 13, 0])
    const ref = await store.capture(
      binary,
      metadata({ mediaType: "application/octet-stream" }),
      noopProducer()
    )
    const read = await store.read(ref, { start: 0 }, caller())
    expect(Array.from(read)).toEqual(Array.from(binary))
  })

  it("round-trips multi-byte Unicode content", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const text = "héllo wörld 你好 🎉"
    const ref = await store.capture(bytesOf(text), metadata(), noopProducer())
    const read = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe(text)
  })
})

describe("artifactStore.read — ranges", () => {
  it("reads a byte sub-range", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    const read = await store.read(ref, { start: 2, end: 5 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("234")
  })

  it("reads from start to end of captured bytes when end is omitted", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    const read = await store.read(ref, { start: 7 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("789")
  })

  it("returns an empty read at exactly capturedBytes", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    const read = await store.read(ref, { start: 10 }, caller())
    expect(read.length).toBe(0)
  })

  it("rejects a start beyond capturedBytes as range_invalid", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    await expect(store.read(ref, { start: 11 }, caller())).rejects.toMatchObject({
      code: "range_invalid",
    })
  })

  it("rejects a negative start as range_invalid", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    await expect(store.read(ref, { start: -1 }, caller())).rejects.toMatchObject({
      code: "range_invalid",
    })
  })

  it("rejects end before start as range_invalid", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    await expect(store.read(ref, { start: 5, end: 2 }, caller())).rejects.toMatchObject({
      code: "range_invalid",
    })
  })

  it("clamps an end beyond capturedBytes rather than erroring", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    const read = await store.read(ref, { start: 5, end: 1000 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("56789")
  })
})

describe("artifactStore.capture — truncation and allocation limits", () => {
  it("truncates at the per-artifact ceiling and records artifact-limit", async () => {
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      quotaLimits: {
        perArtifactBytes: 5,
        perRunBytes: 1000,
        globalBytes: 10_000,
        minFreeBytes: 0,
        minFreeFraction: 0,
      },
    })
    const producer = noopProducer()
    const ref = await store.capture(bytesOf("0123456789"), metadata(), producer)
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("artifact-limit")
    expect(ref.capturedBytes).toBe(5)
    expect(producer.aborts).toEqual(["artifact-limit"])

    const read = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("01234")
    // A truncated artifact's hash still covers exactly its captured bytes.
    expect(ref.sha256).toBe(createHash("sha256").update(bytesOf("01234")).digest("hex"))
  })

  it("truncates at the per-run ceiling and records run-limit", async () => {
    const limits = {
      perArtifactBytes: 1000,
      perRunBytes: 5,
      globalBytes: 10_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("run-limit")
    expect(ref.capturedBytes).toBe(5)
  })

  it("throws ArtifactQuotaExceededError semantics through a fully-denied reservation (zero bytes, still checkpointed)", async () => {
    const limits = {
      perArtifactBytes: 1000,
      perRunBytes: 10,
      globalBytes: 10_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    await store.capture(bytesOf("0123456789"), metadata(), noopProducer()) // consumes the whole 10-byte run budget
    const producer = noopProducer()
    const ref = await store.capture(
      bytesOf("more data"),
      metadata({ runId: "run-1", owner: owner() }),
      producer
    )
    expect(ref.complete).toBe(false)
    expect(ref.capturedBytes).toBe(0)
    expect(ref.truncationReason).toBe("run-limit")
    expect(producer.aborts).toEqual(["run-limit"])
    // Still checkpointed and readable, even though nothing was captured.
    const read = await store.read(ref, { start: 0 }, caller())
    expect(read.length).toBe(0)
  })

  it("truncates at the global ceiling across two different runs and records global-limit", async () => {
    const limits = {
      perArtifactBytes: 1000,
      perRunBytes: 1000,
      globalBytes: 8,
      minFreeBytes: 0,
      minFreeFraction: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    await store.capture(
      bytesOf("12345"),
      metadata({ runId: "run-a", owner: owner({ runId: "run-a", rootRunId: "run-a" }) }),
      noopProducer()
    )
    const ref = await store.capture(
      bytesOf("0123456789"),
      metadata({ runId: "run-b", owner: owner({ runId: "run-b", rootRunId: "run-b" }) }),
      noopProducer()
    )
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("global-limit")
    expect(ref.capturedBytes).toBe(3)
  })

  it("denies the reservation outright when free disk space is already below the watermark", async () => {
    const lowDisk = async () => ({ freeBytes: 10, totalBytes: 1_000_000 })
    const store = new ArtifactStore(dir, {
      statDiskSpace: lowDisk,
      quotaLimits: {
        perArtifactBytes: 1000,
        perRunBytes: 1000,
        globalBytes: 1_000_000,
        minFreeBytes: 50,
        minFreeFraction: 0,
      },
    })
    const producer = noopProducer()
    const ref = await store.capture(bytesOf("0123456789"), metadata(), producer)
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("disk-reserve")
    expect(ref.capturedBytes).toBe(0)
    expect(producer.aborts).toEqual(["disk-reserve"])
  })

  it("truncates mid-stream once a periodic watermark re-check finds free space has dropped", async () => {
    let free = 1000
    const shrinkingDisk = async () => ({ freeBytes: free, totalBytes: 1_000_000 })
    const store = new ArtifactStore(dir, {
      statDiskSpace: shrinkingDisk,
      quotaLimits: {
        perArtifactBytes: 1_000_000,
        perRunBytes: 1_000_000,
        globalBytes: 1_000_000,
        minFreeBytes: 500,
        minFreeFraction: 0,
      },
      // Re-check after every byte so the test doesn't need an 8MiB payload.
      diskRecheckIntervalBytes: 1,
    })
    async function* input(): AsyncIterable<Uint8Array> {
      yield bytesOf("a")
      free = 100 // drop below the 500-byte watermark before the next chunk
      yield bytesOf("b")
    }
    const producer = noopProducer()
    const ref = await store.capture(input(), metadata(), producer)
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("disk-reserve")
    expect(ref.capturedBytes).toBe(1)
    expect(producer.aborts).toEqual(["disk-reserve"])
  })
})

describe("artifactStore.capture — producer abort and write failure", () => {
  it("stops accepting bytes and marks producer-aborted when the signal fires mid-stream", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const controller = new AbortController()
    async function* input(): AsyncIterable<Uint8Array> {
      yield bytesOf("before-abort-")
      controller.abort()
      yield bytesOf("after-abort-should-not-be-captured")
    }
    const aborts: string[] = []
    const producer = {
      abort: (reason: string) => {
        aborts.push(reason)
      },
      signal: controller.signal,
    }
    const ref = await store.capture(input(), metadata(), producer)
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("producer-aborted")
    expect(aborts).toEqual(["producer-aborted"])
    const read = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("before-abort-")
  })

  it("marks write-error and preserves already-captured bytes when the input iterable throws", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    async function* input(): AsyncIterable<Uint8Array> {
      yield bytesOf("partial-data-")
      throw new Error("producer exploded")
    }
    const producer = noopProducer()
    const ref = await store.capture(input(), metadata(), producer)
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("write-error")
    expect(producer.aborts).toEqual(["write-error"])
    const read = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("partial-data-")
  })
})

describe("artifactStore.capture — concurrency", () => {
  it("serializes two concurrent captures against the same run's budget so combined committed bytes never exceed it", async () => {
    const limits = {
      perArtifactBytes: 100,
      perRunBytes: 150,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const bigChunk = new Uint8Array(100).fill(65)
    const [a, b] = await Promise.all([
      store.capture(bigChunk, metadata(), noopProducer()),
      store.capture(bigChunk, metadata(), noopProducer()),
    ])
    expect(a.capturedBytes + b.capturedBytes).toBeLessThanOrEqual(150)
    expect(a.capturedBytes + b.capturedBytes).toBe(150)
    const complete = [a, b].filter((r) => r.complete)
    const incomplete = [a, b].filter((r) => !r.complete)
    expect(complete).toHaveLength(1)
    expect(incomplete).toHaveLength(1)
    expect(incomplete[0]?.truncationReason).toBe("run-limit")
  })
})

describe("artifactStore — access control", () => {
  it("denies a sibling run from reading another child's artifact", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const childOwner = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    const ref = await store.capture(
      bytesOf("secret"),
      metadata({ runId: "child-1", owner: childOwner }),
      noopProducer()
    )
    const sibling = caller({ runId: "child-2", rootRunId: "root-1", parentRunId: "parent-1" })
    await expect(store.read(ref, { start: 0 }, sibling)).rejects.toMatchObject({
      code: "artifact_forbidden",
    })
    await expect(store.stat(ref, sibling)).rejects.toMatchObject({ code: "artifact_forbidden" })
  })

  it("allows a parent to read a child's artifact only when explicitly delegated", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const childOwner = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    const undelegated = await store.capture(
      bytesOf("not shared"),
      metadata({ runId: "child-1", owner: childOwner }),
      noopProducer()
    )
    const parent = caller({ runId: "parent-1", rootRunId: "root-1" })
    await expect(store.read(undelegated, { start: 0 }, parent)).rejects.toMatchObject({
      code: "artifact_forbidden",
    })

    const delegated = await store.capture(
      bytesOf("shared result"),
      metadata({ runId: "child-1", owner: childOwner, delegateToRunIds: ["parent-1"] }),
      noopProducer()
    )
    const read = await store.read(delegated, { start: 0 }, parent)
    expect(Buffer.from(read).toString("utf-8")).toBe("shared result")
  })

  it("always allows the owning run to read its own artifact regardless of delegation", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("mine"), metadata(), noopProducer())
    const read = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("mine")
  })
})

describe("artifactStore — traversal, forgery, and corruption defenses", () => {
  it("rejects a ref with a path-traversal-shaped runId as artifact_missing", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const forged = {
      uri: "artifact://run/../escape/x" as const,
      runId: "../escape",
      artifactId: "x",
      kind: "tool-result" as const,
      mediaType: "text/plain",
      capturedBytes: 0,
      complete: true,
      sha256: "deadbeef",
      createdAt: 0,
    }
    await expect(store.read(forged, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_missing",
    })
  })

  it("rejects a ref whose uri does not match its own runId/artifactId as artifact_forbidden", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("real content"), metadata(), noopProducer())
    const forged = { ...ref, uri: `artifact://run/run-1/not-${ref.artifactId}` as const }
    await expect(store.read(forged, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_forbidden",
    })
  })

  it("rejects a ref whose sha256 disagrees with the stored manifest as artifact_forbidden", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("real content"), metadata(), noopProducer())
    const forged = { ...ref, sha256: "0".repeat(64) }
    await expect(store.read(forged, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_forbidden",
    })
  })

  it("reports a never-created artifact as artifact_missing", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const neverCreated = {
      uri: "artifact://run/run-1/00000000-0000-0000-0000-000000000000" as const,
      runId: "run-1",
      artifactId: "00000000-0000-0000-0000-000000000000",
      kind: "tool-result" as const,
      mediaType: "text/plain",
      capturedBytes: 0,
      complete: true,
      sha256: "deadbeef",
      createdAt: 0,
    }
    await expect(store.read(neverCreated, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_missing",
    })
  })

  it("reports a hand-corrupted manifest file as artifact_corrupt", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("real content"), metadata(), noopProducer())
    const manifestPath = join(dir, "run-1", ref.artifactId, "manifest.json")
    await fs.writeFile(manifestPath, "{ not: valid json ]")
    await expect(store.read(ref, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_corrupt",
    })
    await expect(store.stat(ref, caller())).rejects.toMatchObject({ code: "artifact_corrupt" })
  })

  it("reports a structurally-invalid (but valid JSON) manifest as artifact_corrupt", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("real content"), metadata(), noopProducer())
    const manifestPath = join(dir, "run-1", ref.artifactId, "manifest.json")
    await fs.writeFile(manifestPath, JSON.stringify({ envelopeVersion: 1, ref: { nope: true } }))
    await expect(store.read(ref, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_corrupt",
    })
  })

  it("rejects a directory symlink/junction planted at an artifact id that escapes the run directory", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("real content"), metadata(), noopProducer())
    const artifactDir = join(dir, "run-1", ref.artifactId)
    const manifestPath = join(artifactDir, "manifest.json")
    const legitimateManifest = await fs.readFile(manifestPath, "utf-8")

    const outsideDir = await fs.mkdtemp(join(tmpdir(), "synapse-artifact-escape-"))
    try {
      // The escape target has its own (identical-looking) manifest, so the
      // failure mode under test is the containment check itself, not a
      // trivial ENOENT.
      await fs.writeFile(join(outsideDir, "manifest.json"), legitimateManifest)
      await fs.writeFile(join(outsideDir, "data.bin"), "attacker-controlled bytes")

      await fs.rm(artifactDir, { recursive: true, force: true })
      try {
        await fs.symlink(outsideDir, artifactDir, process.platform === "win32" ? "junction" : "dir")
      } catch (err) {
        // Some sandboxes refuse even unprivileged junction/symlink creation;
        // treat as environment-inconclusive rather than a false failure.
        console.warn("skipping symlink escape test: could not create link", err)
        return
      }

      await expect(store.read(ref, { start: 0 }, caller())).rejects.toMatchObject({
        code: "artifact_forbidden",
      })
      await expect(store.stat(ref, caller())).rejects.toMatchObject({ code: "artifact_forbidden" })
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })
})

describe("artifactStore.collectEligible", () => {
  it("reconciles an abandoned reservation left over from a crash and removes an orphaned temp file", async () => {
    const limits = {
      perArtifactBytes: 100,
      perRunBytes: 100,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
    }
    // Simulate a crash mid-capture: a reservation was made and a temp file
    // written, but the process died before settle()/rename() ran.
    const rawQuota = new ArtifactQuotaStore(dir, ampleDisk)
    await rawQuota.reserve({
      operationId: "crashed-op",
      runId: "run-1",
      artifactId: "art-1",
      limits,
    })
    const artifactDir = join(dir, "run-1", "art-1")
    await fs.mkdir(artifactDir, { recursive: true })
    await fs.writeFile(join(artifactDir, "data.bin.tmp"), "orphaned partial bytes")

    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const result = await store.collectEligible()
    expect(result.reconciledReservations).toBe(1)
    expect(result.reclaimedReservedBytes).toBe(100)
    expect(result.orphanedTempFilesRemoved).toBe(1)

    await expect(fs.access(join(artifactDir, "data.bin.tmp"))).rejects.toThrow()

    // The reconciled reservation frees the run's budget for a fresh capture.
    const ref = await store.capture(bytesOf("fresh"), metadata(), noopProducer())
    expect(ref.complete).toBe(true)
  })

  it("is a safe no-op when nothing is abandoned", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const result = await store.collectEligible()
    expect(result).toEqual({
      reconciledReservations: 0,
      reclaimedReservedBytes: 0,
      orphanedTempFilesRemoved: 0,
      deletedArtifacts: 0,
      deletedBytes: 0,
    })
  })
})

describe("artifactReadError", () => {
  it("carries a stable, closed error code", () => {
    const err = new ArtifactReadError("artifact_missing", "nope")
    expect(err.code).toBe("artifact_missing")
    expect(err.name).toBe("ArtifactReadError")
  })
})
