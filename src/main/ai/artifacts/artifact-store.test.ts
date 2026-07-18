import type {
  AgentArtifactRef,
  ArtifactCaller,
  ArtifactMetadata,
  ArtifactOwnerContext,
} from "./artifact-types"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactQuotaStore } from "./artifact-quota"
import { artifactsRoot, ArtifactStore, estimateManifestReserveBytes } from "./artifact-store"
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

  it("rejects a same-length data replacement whose digest no longer matches", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    await fs.writeFile(join(dir, ref.runId, ref.artifactId, "data.bin"), "abcdefghij")
    await expect(store.read(ref, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_corrupt",
    })
  })

  it("rejects a shortened data file instead of returning a zero-filled tail", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    await fs.writeFile(join(dir, ref.runId, ref.artifactId, "data.bin"), "0123")
    await expect(store.read(ref, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_corrupt",
    })
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
        manifestReserveBytes: 0,
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

  it("truncates at the per-run ceiling (which must still leave room for the manifest itself) and records run-limit", async () => {
    const manifestReserve = estimateManifestReserveBytes(metadata())
    const limits = {
      perArtifactBytes: 1000,
      // Room for exactly one manifest plus 5 payload bytes — the manifest
      // headroom is always reserved first (Issue 1 fix), so a run budget
      // that couldn't also fit a manifest would reject outright instead of
      // gracefully truncating the payload.
      perRunBytes: manifestReserve + 5,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("run-limit")
    expect(ref.capturedBytes).toBe(5)
  })

  it("rejects capture entirely when not even the manifest headroom fits anywhere (true exhaustion, Issue 1)", async () => {
    const manifestReserve = estimateManifestReserveBytes(metadata())
    const limits = {
      perArtifactBytes: 1000,
      // Deliberately less than even one manifest needs — nothing (not even
      // metadata) can be safely written or accounted for.
      perRunBytes: manifestReserve - 1,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const producer = noopProducer()
    await expect(store.capture(bytesOf("0123456789"), metadata(), producer)).rejects.toMatchObject({
      reason: "run-limit",
    })
    expect(producer.aborts).toEqual(["run-limit"])

    // No manifest.json or data.bin was ever written for this rejected
    // capture — the untracked-metadata write Issue 1 fixes never happens.
    // (An empty per-artifact directory may still exist from the initial
    // mkdir before the reservation was attempted; that holds no untracked
    // bytes and isn't what this test guards against.)
    const artifactIds = await fs.readdir(join(dir, "run-1")).catch(() => [])
    for (const artifactId of artifactIds) {
      const entries = await fs.readdir(join(dir, "run-1", artifactId))
      expect(entries).toEqual([])
    }
  })

  it("rejects a second capture once a prior one has nearly exhausted a run's budget (its own manifest no longer fits)", async () => {
    const manifestReserve = estimateManifestReserveBytes(metadata())
    const limits = {
      perArtifactBytes: 1000,
      // Exactly enough for one full manifest + one full 10-byte payload —
      // no slack left for a second manifest at all, since the first
      // capture's real (nonzero) manifest bytes are now committed too.
      perRunBytes: manifestReserve + 10,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const first = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    expect(first.complete).toBe(true)
    expect(first.capturedBytes).toBe(10)

    const producer = noopProducer()
    await expect(
      store.capture(bytesOf("more"), metadata({ runId: "run-1", owner: owner() }), producer)
    ).rejects.toMatchObject({ reason: "run-limit" })
    expect(producer.aborts).toEqual(["run-limit"])
  })

  it("truncates at the global ceiling across two different runs and records global-limit", async () => {
    const metadataA = metadata({
      runId: "run-a",
      owner: owner({ runId: "run-a", rootRunId: "run-a" }),
    })
    const metadataB = metadata({
      runId: "run-b",
      owner: owner({ runId: "run-b", rootRunId: "run-b" }),
    })
    // run-a and run-b use same-length runId strings, so capture()'s
    // per-call manifest headroom estimate (Issue 2 fix) is identical for
    // both — this is what run-b's own reservation will actually ask for.
    const manifestReserve = estimateManifestReserveBytes(metadataA)
    expect(estimateManifestReserveBytes(metadataB)).toBe(manifestReserve)

    // Measure run-a's REAL total committed bytes (payload + its real,
    // possibly-smaller-than-the-worst-case-estimate manifest size) under
    // ample limits, so the tight globalBytes below can be derived exactly
    // rather than guessed.
    const probeStore = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const probeRef = await probeStore.capture(bytesOf("12345"), metadataA, noopProducer())
    const probeManifestBytes = (
      await fs.stat(join(dir, "run-a", probeRef.artifactId, "manifest.json"))
    ).size
    const runACommitted = probeRef.capturedBytes + probeManifestBytes
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })

    // globalBytes leaves exactly 3 payload bytes of room for run-b after
    // run-a's real total commit and run-b's own manifest headroom
    // reservation (the worst-case estimate, since that's what gets reserved
    // up front regardless of the real size).
    const limits = {
      perArtifactBytes: 1_000_000,
      perRunBytes: 1_000_000,
      globalBytes: runACommitted + manifestReserve + 3,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const first = await store.capture(bytesOf("12345"), metadataA, noopProducer())
    expect(first.complete).toBe(true)
    expect(first.capturedBytes).toBe(5)

    const ref = await store.capture(bytesOf("0123456789"), metadataB, noopProducer())
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("global-limit")
    expect(ref.capturedBytes).toBe(3)
  })

  it("counts the manifest's own disk footprint against the run/global quota, not just the payload (Issue 2)", async () => {
    const limits = {
      perArtifactBytes: 1_000_000,
      perRunBytes: 1_000_000,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 4096,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const ref = await store.capture(bytesOf("x"), metadata(), noopProducer())
    expect(ref.complete).toBe(true)
    expect(ref.capturedBytes).toBe(1)

    // If only the 1-byte payload were counted (the pre-fix bug), a fresh
    // reservation against the same run would see exactly
    // (perRunBytes - 1) bytes remaining. A probe reservation with
    // manifestReserveBytes: 0 (so the probe itself doesn't eat further into
    // the budget) must see measurably less than that, proving the
    // manifest's real bytes were committed too.
    const probe = new ArtifactQuotaStore(dir, ampleDisk)
    const receipt = await probe.reserve({
      operationId: "probe-remaining-room",
      runId: "run-1",
      artifactId: "probe-artifact",
      limits: { ...limits, manifestReserveBytes: 0 },
    })
    expect(receipt.grantedBytes).toBeLessThan(limits.perRunBytes - 1)
  })

  it("rejects capture outright when free disk space is already below the watermark (not even the manifest fits)", async () => {
    const lowDisk = async () => ({ freeBytes: 10, totalBytes: 1_000_000 })
    const store = new ArtifactStore(dir, {
      statDiskSpace: lowDisk,
      quotaLimits: {
        perArtifactBytes: 1000,
        perRunBytes: 1000,
        globalBytes: 1_000_000,
        minFreeBytes: 50,
        minFreeFraction: 0,
        manifestReserveBytes: 0,
      },
    })
    const producer = noopProducer()
    await expect(store.capture(bytesOf("0123456789"), metadata(), producer)).rejects.toMatchObject({
      reason: "disk-reserve",
    })
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
        // Low enough that the initial reserve (free=1000) still leaves room
        // for the manifest headroom (~658 bytes for this test's metadata);
        // the mid-stream drop below is what triggers the truncation.
        minFreeBytes: 100,
        minFreeFraction: 0,
        manifestReserveBytes: 0,
      },
      // Re-check after every byte so the test doesn't need an 8MiB payload.
      diskRecheckIntervalBytes: 1,
    })
    async function* input(): AsyncIterable<Uint8Array> {
      yield bytesOf("a")
      free = 50 // drop below the 100-byte watermark before the next chunk
      yield bytesOf("b")
    }
    const producer = noopProducer()
    await expect(store.capture(input(), metadata(), producer)).rejects.toThrow(
      /unable to commit artifact manifest/
    )
    expect(producer.aborts).toEqual(["disk-reserve"])
  })

  it("checks the watermark before the first byte and never writes a chunk past current headroom", async () => {
    let checks = 0
    const diskThatDropsAfterReserve = async () => {
      checks += 1
      // reserve() sees room for the payload+manifest; another writer consumes
      // it before capture's mandatory pre-first-write recheck.
      return checks === 1
        ? { freeBytes: 10_000, totalBytes: 1_000_000 }
        : { freeBytes: 0, totalBytes: 1_000_000 }
    }
    const store = new ArtifactStore(dir, {
      statDiskSpace: diskThatDropsAfterReserve,
      quotaLimits: {
        perArtifactBytes: 1_000,
        perRunBytes: 1_000_000,
        globalBytes: 1_000_000,
        minFreeBytes: 0,
        minFreeFraction: 0,
        manifestReserveBytes: 0,
      },
    })
    const producer = noopProducer()
    await expect(
      store.capture(bytesOf("a very large first chunk"), metadata(), producer)
    ).rejects.toThrow(/unable to commit artifact manifest/)
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

  it("marks producer-aborted when cancellation races with normal EOF", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const controller = new AbortController()
    async function* input(): AsyncIterable<Uint8Array> {
      yield bytesOf("last-chunk")
      controller.abort()
    }
    const producer = { abort: vi.fn(), signal: controller.signal }
    const ref = await store.capture(input(), metadata(), producer)
    expect(ref.complete).toBe(false)
    expect(ref.truncationReason).toBe("producer-aborted")
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

  it("compensates the reservation and rejects when the temporary payload cannot be opened", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })

    function eaccesError(): NodeJS.ErrnoException {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException
      err.code = "EACCES"
      return err
    }

    const openSpy = vi.spyOn(fs, "open").mockRejectedValue(eaccesError())

    try {
      const producer = noopProducer()
      await expect(store.capture(bytesOf("hello"), metadata(), producer)).rejects.toThrow(
        /unable to open artifact payload/
      )
      expect(producer.aborts).toEqual(["write-error"])

      // The quota reservation must have been settled (moved out of
      // "pending"), not left dangling until the next reconciliation pass.
      const ledgerRaw = JSON.parse(await fs.readFile(join(dir, "quota.json"), "utf-8")) as {
        pendingReservations: Record<string, unknown>
      }
      expect(Object.keys(ledgerRaw.pendingReservations)).toHaveLength(0)
    } finally {
      openSpy.mockRestore()
    }
  })

  it("retries a short FileHandle.write and commits only the bytes actually written", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const realOpen = fs.open.bind(fs)
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      if (String(args[0]).endsWith("data.bin.tmp")) {
        const realWrite = handle.write.bind(handle)
        let firstWrite = true
        handle.write = (async (buffer, offset, length, position) => {
          if (firstWrite) {
            firstWrite = false
            const requested = length ?? buffer.byteLength
            return realWrite(buffer, offset ?? 0, Math.max(1, Math.floor(requested / 8)), position)
          }
          return realWrite(buffer, offset, length, position)
        }) as typeof handle.write
      }
      return handle
    })

    try {
      const ref = await store.capture(bytesOf("12345678"), metadata(), noopProducer())
      expect(ref.complete).toBe(true)
      expect(ref.capturedBytes).toBe(8)
      expect(Buffer.from(await store.read(ref, { start: 0 }, caller())).toString("utf8")).toBe(
        "12345678"
      )
    } finally {
      openSpy.mockRestore()
    }
  })

  it("never returns a ref when rename cannot establish the final data file", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const realRename = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).endsWith("data.bin.tmp") && String(newPath).endsWith("data.bin")) {
        throw new Error("simulated rename failure")
      }
      return realRename(oldPath, newPath)
    })

    try {
      await expect(store.capture(bytesOf("payload"), metadata(), noopProducer())).rejects.toThrow(
        /unable to finalize artifact payload/
      )
      const ledgerRaw = JSON.parse(await fs.readFile(join(dir, "quota.json"), "utf-8")) as {
        pendingReservations: Record<string, unknown>
      }
      expect(Object.keys(ledgerRaw.pendingReservations)).toHaveLength(0)
    } finally {
      renameSpy.mockRestore()
    }
  })
})

describe("artifactStore.capture — concurrency", () => {
  it("serializes two concurrent captures against the same run's budget so only one can also fit its own manifest", async () => {
    const manifestReserve = estimateManifestReserveBytes(metadata())
    const limits = {
      perArtifactBytes: 100,
      // Exactly one manifest + one full 100-byte payload, no slack for a
      // second manifest — deterministic regardless of the real (nonzero)
      // manifest size, since any nonzero commit from the first capture
      // leaves less than manifestReserve of room for the second.
      perRunBytes: manifestReserve + 100,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk, quotaLimits: limits })
    const bigChunk = new Uint8Array(100).fill(65)
    const results = await Promise.allSettled([
      store.capture(bigChunk, metadata(), noopProducer()),
      store.capture(bigChunk, metadata(), noopProducer()),
    ])
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<ArtifactStore["capture"]>>> =>
        r.status === "fulfilled"
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(fulfilled[0]?.value.complete).toBe(true)
    expect(fulfilled[0]?.value.capturedBytes).toBe(100)
    expect(rejected[0]?.reason).toMatchObject({ reason: "run-limit" })
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

describe("artifactStore.resolve — by-id lookup with no caller-supplied ref (Task 19 follow-up)", () => {
  it("returns the authoritative ref, real sha256 included, for an artifact captured with no checkpoint or ref round-trip involved", async () => {
    // Simulates exactly the Task 18 run_command interop case:
    // execution-tool-host.ts calls store.capture() directly and only ever
    // embeds the resulting uri as plain JSON text in its own bespoke
    // payload — nothing ever hands a full AgentArtifactRef back in, and
    // nothing durably references it from a checkpoint message. resolve()
    // must still find it from runId+artifactId alone.
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const content = bytesOf("$ pnpm build\nbuild succeeded\n")
    const ref = await store.capture(
      content,
      metadata({ kind: "command-stdout", mediaType: "text/plain; charset=utf-8" }),
      noopProducer()
    )

    const resolved = await store.resolve(ref.runId, ref.artifactId, caller())

    expect(resolved).toEqual(ref)
    expect(resolved.sha256).toBe(createHash("sha256").update(content).digest("hex"))
  })

  it("applies the same checkArtifactAccess rules as stat/read: denies an unrelated caller", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const childOwner = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    const ref = await store.capture(
      bytesOf("secret"),
      metadata({ runId: "child-1", owner: childOwner }),
      noopProducer()
    )
    const sibling = caller({ runId: "child-2", rootRunId: "root-1", parentRunId: "parent-1" })
    await expect(store.resolve(ref.runId, ref.artifactId, sibling)).rejects.toMatchObject({
      code: "artifact_forbidden",
    })
  })

  it("allows a parent to resolve a child's artifact only when explicitly delegated", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const childOwner = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    const undelegated = await store.capture(
      bytesOf("not shared"),
      metadata({ runId: "child-1", owner: childOwner }),
      noopProducer()
    )
    const parent = caller({ runId: "parent-1", rootRunId: "root-1" })
    await expect(
      store.resolve(undelegated.runId, undelegated.artifactId, parent)
    ).rejects.toMatchObject({ code: "artifact_forbidden" })

    const delegated = await store.capture(
      bytesOf("shared result"),
      metadata({ runId: "child-1", owner: childOwner, delegateToRunIds: ["parent-1"] }),
      noopProducer()
    )
    const resolved = await store.resolve(delegated.runId, delegated.artifactId, parent)
    expect(resolved.uri).toBe(delegated.uri)
  })

  it("always allows the owning run to resolve its own artifact regardless of delegation", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("mine"), metadata(), noopProducer())
    const resolved = await store.resolve(ref.runId, ref.artifactId, caller())
    expect(resolved.uri).toBe(ref.uri)
  })

  it("reports an unknown artifactId as artifact_missing", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    await store.capture(bytesOf("real content"), metadata(), noopProducer())
    await expect(
      store.resolve("run-1", "00000000-0000-0000-0000-000000000000", caller())
    ).rejects.toMatchObject({ code: "artifact_missing" })
  })

  it("rejects a path-traversal-shaped runId as artifact_missing", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    await expect(store.resolve("../escape", "x", caller())).rejects.toMatchObject({
      code: "artifact_missing",
    })
  })

  it("reports a hand-corrupted manifest file as artifact_corrupt", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const ref = await store.capture(bytesOf("real content"), metadata(), noopProducer())
    const manifestPath = join(dir, "run-1", ref.artifactId, "manifest.json")
    await fs.writeFile(manifestPath, "{ not: valid json ]")
    await expect(store.resolve(ref.runId, ref.artifactId, caller())).rejects.toMatchObject({
      code: "artifact_corrupt",
    })
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
  it("reconciles an abandoned reservation only at startup and removes its orphaned temp file", async () => {
    const manifestReserve = estimateManifestReserveBytes(metadata())
    const limits = {
      perArtifactBytes: 100,
      // Room for the simulated 100-byte crashed reservation *and*, once
      // reconciled, a real fresh capture's own manifest + payload.
      perRunBytes: manifestReserve + 100,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
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
    const startup = await store.reconcileStartup()
    expect(startup.reconciledCount).toBe(1)
    expect(startup.reclaimedBytes).toBe(100)

    await expect(fs.access(join(artifactDir, "data.bin.tmp"))).rejects.toThrow()

    const result = await store.collectEligible()
    expect(result.reconciledReservations).toBe(0)
    expect(result.reclaimedReservedBytes).toBe(0)
    expect(result.orphanedTempFilesRemoved).toBe(0)

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

  it("does not reclaim a live capture reservation when GC runs concurrently", async () => {
    let releaseSecondChunk!: () => void
    let firstChunkSeen!: () => void
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkSeen = resolve
    })
    const secondChunk = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve
    })
    async function* slowProducer(): AsyncIterable<Uint8Array> {
      yield bytesOf("first")
      firstChunkSeen()
      await secondChunk
      yield bytesOf(" second")
    }
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const capture = store.capture(slowProducer(), metadata(), noopProducer())
    await firstChunk

    const gc = await store.collectEligible()
    expect(gc.reconciledReservations).toBe(0)
    releaseSecondChunk()
    await expect(capture).resolves.toMatchObject({ complete: true })
  })
})

describe("artifactStore.releaseRunPin / collectEligible — retention (Task 21)", () => {
  it("does not delete a non-terminal run's artifact even when unreferenced", async () => {
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      isArtifactReferenced: async () => false,
    })
    await store.capture(bytesOf("keep me"), metadata(), noopProducer())
    // releaseRunPin never called for run-1 — it stays non-terminal/pinned.
    const result = await store.collectEligible()
    expect(result.deletedArtifacts).toBe(0)
    expect(result.deletedBytes).toBe(0)
  })

  it("does not delete a terminal run's artifact that is still referenced", async () => {
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      isArtifactReferenced: async () => true,
    })
    const ref = await store.capture(bytesOf("still referenced"), metadata(), noopProducer())
    await store.releaseRunPin("run-1", "fin-1")
    const result = await store.collectEligible()
    expect(result.deletedArtifacts).toBe(0)
    expect(result.deletedBytes).toBe(0)
    // Bytes are genuinely still there — reads keep working.
    const read = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe("still referenced")
  })

  it("deletes a terminal, unreferenced run's artifact and records a tombstone", async () => {
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      isArtifactReferenced: async () => false,
    })
    const ref = await store.capture(bytesOf("goodbye"), metadata(), noopProducer())
    await store.releaseRunPin("run-1", "fin-1")

    const result = await store.collectEligible()
    expect(result.deletedArtifacts).toBe(1)
    expect(result.deletedBytes).toBe(ref.capturedBytes)

    // A subsequent stat/read/resolve against the deleted artifact reports
    // artifact_expired (with the tombstone attached), never artifact_missing.
    await expect(store.stat(ref, caller())).rejects.toMatchObject({ code: "artifact_expired" })
    let caught: unknown
    try {
      await store.stat(ref, caller())
    } catch (err) {
      caught = err
    }
    expect((caught as { tombstone?: unknown }).tombstone).toMatchObject({
      uri: ref.uri,
      sha256: ref.sha256,
      capturedBytes: ref.capturedBytes,
    })
    await expect(store.read(ref, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_expired",
    })
    await expect(store.resolve("run-1", ref.artifactId, caller())).rejects.toMatchObject({
      code: "artifact_expired",
    })
  })

  it("returns committed quota after deleting an eligible artifact, so a later capture is admitted", async () => {
    const manifestReserve = estimateManifestReserveBytes(metadata())
    const limits = {
      perArtifactBytes: 10,
      perRunBytes: manifestReserve + 10,
      globalBytes: manifestReserve + 10,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      quotaLimits: limits,
      isArtifactReferenced: async () => false,
    })
    await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    await store.releaseRunPin("run-1", "fin-1")
    await store.collectEligible()

    const replacement = await store.capture(bytesOf("abcdefghij"), metadata(), noopProducer())
    expect(replacement.capturedBytes).toBe(10)
    expect(replacement.complete).toBe(true)
  })

  it("reconciles quota on restart when deletion completed just before the GC process crashed", async () => {
    const manifestReserve = estimateManifestReserveBytes(metadata())
    const limits = {
      perArtifactBytes: 10,
      perRunBytes: manifestReserve + 10,
      globalBytes: manifestReserve + 10,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      quotaLimits: limits,
      isArtifactReferenced: async () => false,
    })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    await store.releaseRunPin("run-1", "fin-1")

    const artifactDir = join(dir, "run-1", ref.artifactId)
    const realRm = fs.rm.bind(fs)
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === artifactDir) {
        await realRm(target as never, options as never)
        throw new Error("simulated crash after artifact deletion")
      }
      return realRm(target as never, options as never)
    })
    await expect(store.collectEligible()).rejects.toThrow(/simulated crash after artifact deletion/)
    rmSpy.mockRestore()

    const restarted = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      quotaLimits: limits,
      isArtifactReferenced: async () => false,
    })
    await restarted.collectEligible()
    const replacement = await restarted.capture(bytesOf("abcdefghij"), metadata(), noopProducer())
    expect(replacement.complete).toBe(true)
    expect(replacement.capturedBytes).toBe(10)
  })

  it("never deletes anything when isArtifactReferenced is not wired at all", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    await store.capture(bytesOf("no reference predicate wired"), metadata(), noopProducer())
    await store.releaseRunPin("run-1", "fin-1")
    const result = await store.collectEligible()
    expect(result.deletedArtifacts).toBe(0)
    expect(result.deletedBytes).toBe(0)
  })

  it("rechecks isArtifactReferenced immediately before each deletion, so a reference appearing mid-sweep is honored (race regression)", async () => {
    // Two candidates in the SAME run. The predicate treats whichever
    // candidate is checked FIRST as unreferenced (so it proceeds to real
    // deletion) and whichever is checked SECOND as referenced — but only
    // once the first candidate's bytes are ACTUALLY gone from disk. That is
    // real, observable evidence that real async work (the first
    // candidate's fs.rm) has already completed by the time the second is
    // checked — exactly modeling "a conversation commit adds a fresh
    // reference to this uri while the sweep is still working through
    // earlier candidates."
    //
    // A precompute-then-delete implementation (the pre-fix bug) checks
    // every candidate in one pass BEFORE deleting any of them, so neither
    // candidate's directory would ever be gone yet at check time — both
    // would be (incorrectly) treated as unreferenced and both would be
    // deleted. The fixed, recheck-immediately-before-delete implementation
    // deletes the first candidate before ever checking the second, so the
    // second candidate's check correctly observes the first one is gone
    // and survives.
    let refA!: AgentArtifactRef
    let refB!: AgentArtifactRef
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      isArtifactReferenced: async (uri) => {
        const otherDir =
          uri === refA.uri
            ? join(dir, "run-1", refB.artifactId)
            : join(dir, "run-1", refA.artifactId)
        const otherStillExists = await fs
          .access(otherDir)
          .then(() => true)
          .catch(() => false)
        return !otherStillExists
      },
    })
    refA = await store.capture(bytesOf("candidate A"), metadata(), noopProducer())
    refB = await store.capture(bytesOf("candidate B"), metadata(), noopProducer())
    await store.releaseRunPin("run-1", "fin-1")

    const result = await store.collectEligible()

    // Exactly one of the two was deleted — the one processed first. Under
    // the pre-fix precompute-then-delete bug, this would be 2 (both
    // deleted, since neither's directory was gone yet when either was
    // checked).
    expect(result.deletedArtifacts).toBe(1)

    const aGone = await fs
      .access(join(dir, "run-1", refA.artifactId))
      .then(() => false)
      .catch(() => true)
    const bGone = await fs
      .access(join(dir, "run-1", refB.artifactId))
      .then(() => false)
      .catch(() => true)
    // Exactly one survived, and it is still fully readable.
    expect([aGone, bGone].filter(Boolean)).toHaveLength(1)
    const survivingRef = aGone ? refB : refA
    const survivingText = aGone ? "candidate B" : "candidate A"
    const read = await store.read(survivingRef, { start: 0 }, caller())
    expect(Buffer.from(read).toString("utf-8")).toBe(survivingText)
  })

  it("isolates a single candidate's reference-check failure from the rest of the sweep", async () => {
    // Three eligible candidates in the same run: one whose reference check
    // throws (a permissions error, EIO, ... — anything other than the
    // already-handled "conversation record JSON is malformed" case), and
    // two ordinary unreferenced ones. The throwing candidate must survive
    // (fail closed — never delete on an inconclusive answer) without
    // aborting the sweep for its siblings, and collectEligible() must
    // resolve with a result rather than reject.
    let refThrows!: AgentArtifactRef
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      isArtifactReferenced: async (uri) => {
        if (uri === refThrows.uri) throw new Error("simulated I/O failure reading a conversation")
        return false
      },
    })
    refThrows = await store.capture(bytesOf("poisoned check"), metadata(), noopProducer())
    const refB = await store.capture(bytesOf("ordinary eligible B"), metadata(), noopProducer())
    const refC = await store.capture(bytesOf("ordinary eligible C"), metadata(), noopProducer())
    await store.releaseRunPin("run-1", "fin-1")

    const result = await store.collectEligible()

    // Only the two candidates whose check didn't throw were deleted.
    expect(result.deletedArtifacts).toBe(2)
    expect(result.deletedBytes).toBe(refB.capturedBytes + refC.capturedBytes)

    // The candidate whose check threw survives and is still fully readable.
    const survivor = await store.read(refThrows, { start: 0 }, caller())
    expect(Buffer.from(survivor).toString("utf-8")).toBe("poisoned check")

    // Its siblings were genuinely deleted (expired, not merely absent).
    await expect(store.stat(refB, caller())).rejects.toMatchObject({ code: "artifact_expired" })
    await expect(store.stat(refC, caller())).rejects.toMatchObject({ code: "artifact_expired" })
  })

  it("an unrelated invalid/never-captured artifact id still reports artifact_missing, not artifact_expired", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    await expect(
      store.resolve("run-never-existed", "artifact-never-existed", caller())
    ).rejects.toMatchObject({ code: "artifact_missing" })
  })

  it("quota pressure from a referenced artifact denies new capture rather than GC breaking history", async () => {
    const manifestReserve = estimateManifestReserveBytes(metadata())
    const limits = {
      perArtifactBytes: 10,
      // Room for exactly one 10-byte payload plus its manifest — a second
      // capture's manifest headroom alone cannot fit once the first commits.
      perRunBytes: manifestReserve + 10,
      globalBytes: 1_000_000,
      minFreeBytes: 0,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    const store = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      quotaLimits: limits,
      isArtifactReferenced: async () => true, // this run's artifact is still referenced
    })
    const ref = await store.capture(bytesOf("0123456789"), metadata(), noopProducer())
    await store.releaseRunPin("run-1", "fin-1")

    // GC cannot reclaim the referenced artifact's quota...
    const gc = await store.collectEligible()
    expect(gc.deletedArtifacts).toBe(0)

    // ...so a fresh capture that needs room is denied outright (never
    // silently deleting the referenced artifact to make space).
    await expect(store.capture(bytesOf("more bytes"), metadata(), noopProducer())).rejects.toThrow(
      /run-limit exhausted/
    )
    // The referenced artifact's bytes are still fully intact.
    const stillThere = await store.read(ref, { start: 0 }, caller())
    expect(Buffer.from(stillThere).toString("utf-8")).toBe("0123456789")
  })
})

describe("artifactReadError", () => {
  it("carries a stable, closed error code", () => {
    const err = new ArtifactReadError("artifact_missing", "nope")
    expect(err.code).toBe("artifact_missing")
    expect(err.name).toBe("ArtifactReadError")
  })
})
