import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ArtifactPinStore,
  ArtifactTombstoneStore,
  buildArtifactTombstone,
  MIN_TOMBSTONE_RETENTION_MS,
  releaseArtifactRunResources,
  selectEligibleForDeletion,
} from "./artifact-retention"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-artifact-retention-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("artifactPinStore", () => {
  it("treats an unknown run as still pinned", async () => {
    const store = new ArtifactPinStore(dir)
    expect(await store.isPinned("run-never-seen")).toBe(true)
  })

  it("is unpinned only after release() is called for that run", async () => {
    const store = new ArtifactPinStore(dir)
    expect(await store.isPinned("run-1")).toBe(true)
    await store.release("run-1", "fin-1", 1000)
    expect(await store.isPinned("run-1")).toBe(false)
    // A different, never-released run is unaffected.
    expect(await store.isPinned("run-2")).toBe(true)
  })

  it("release is idempotent across a fresh store instance (durable, not in-memory)", async () => {
    const first = new ArtifactPinStore(dir)
    await first.release("run-1", "fin-1", 1000)

    const second = new ArtifactPinStore(dir)
    expect(await second.isPinned("run-1")).toBe(false)
    // Re-releasing (e.g. a finalization retry after a crash) is a no-op, not
    // an error.
    await expect(second.release("run-1", "fin-1", 2000)).resolves.toBeUndefined()
    expect(await second.isPinned("run-1")).toBe(false)
  })

  it("concurrent releases for different runs never clobber each other", async () => {
    const store = new ArtifactPinStore(dir)
    await Promise.all([
      store.release("run-a", "fin-a", 1),
      store.release("run-b", "fin-b", 2),
      store.release("run-c", "fin-c", 3),
    ])
    expect(await store.isPinned("run-a")).toBe(false)
    expect(await store.isPinned("run-b")).toBe(false)
    expect(await store.isPinned("run-c")).toBe(false)
  })
})

describe("artifactTombstoneStore", () => {
  function tombstone(uri: string, deletedAt: number) {
    return buildArtifactTombstone(
      { uri: uri as `artifact://run/${string}/${string}`, sha256: "abc", capturedBytes: 10 },
      deletedAt,
      "retention-terminal-unreferenced"
    )
  }

  it("returns undefined for a uri never recorded", async () => {
    const store = new ArtifactTombstoneStore(dir)
    expect(await store.get("artifact://run/r1/a1")).toBeUndefined()
  })

  it("round-trips a recorded tombstone, durably across instances", async () => {
    const store = new ArtifactTombstoneStore(dir)
    const t = tombstone("artifact://run/r1/a1", 1000)
    await store.record(t)

    const reopened = new ArtifactTombstoneStore(dir)
    expect(await reopened.get("artifact://run/r1/a1")).toEqual(t)
  })

  it("keeps a tombstone younger than the minimum retention window", async () => {
    const store = new ArtifactTombstoneStore(dir)
    await store.record(tombstone("artifact://run/r1/a1", 1000))
    const removed = await store.pruneExpired(1000 + MIN_TOMBSTONE_RETENTION_MS - 1)
    expect(removed).toBe(0)
    expect(await store.get("artifact://run/r1/a1")).toBeDefined()
  })

  it("prunes a tombstone at/after the minimum retention window", async () => {
    const store = new ArtifactTombstoneStore(dir)
    await store.record(tombstone("artifact://run/r1/a1", 1000))
    const removed = await store.pruneExpired(1000 + MIN_TOMBSTONE_RETENTION_MS)
    expect(removed).toBe(1)
    expect(await store.get("artifact://run/r1/a1")).toBeUndefined()
  })

  it("prunes only the expired entries, keeping a still-fresh one", async () => {
    const store = new ArtifactTombstoneStore(dir)
    await store.record(tombstone("artifact://run/r1/old", 0))
    await store.record(tombstone("artifact://run/r1/fresh", 5_000_000))
    const removed = await store.pruneExpired(MIN_TOMBSTONE_RETENTION_MS + 1)
    expect(removed).toBe(1)
    expect(await store.get("artifact://run/r1/old")).toBeUndefined()
    expect(await store.get("artifact://run/r1/fresh")).toBeDefined()
  })
})

describe("selectEligibleForDeletion", () => {
  const candidates = [
    { runId: "run-terminal-unreferenced", artifactId: "a1", uri: "artifact://run/t/a1" as const },
    { runId: "run-terminal-referenced", artifactId: "a2", uri: "artifact://run/t/a2" as const },
    { runId: "run-non-terminal", artifactId: "a3", uri: "artifact://run/nt/a3" as const },
  ]
  const pinnedRuns = new Set(["run-non-terminal"])
  const referencedUris = new Set(["artifact://run/t/a2"])

  it("selects only artifacts whose run is unpinned and whose uri is unreferenced", () => {
    const eligible = selectEligibleForDeletion(
      candidates,
      (runId) => pinnedRuns.has(runId),
      (uri) => referencedUris.has(uri)
    )
    expect(eligible.map((c) => c.artifactId)).toEqual(["a1"])
  })

  it("excludes a non-terminal (still-pinned) run's artifacts even if unreferenced", () => {
    const eligible = selectEligibleForDeletion(
      [{ runId: "run-non-terminal", artifactId: "a3", uri: "artifact://run/nt/a3" as const }],
      (runId) => pinnedRuns.has(runId),
      () => false
    )
    expect(eligible).toEqual([])
  })

  it("excludes a terminal run's artifact that an active conversation still references", () => {
    const eligible = selectEligibleForDeletion(
      [{ runId: "run-terminal-referenced", artifactId: "a2", uri: "artifact://run/t/a2" as const }],
      () => false,
      (uri) => referencedUris.has(uri)
    )
    expect(eligible).toEqual([])
  })

  it("returns an empty array for an empty candidate list", () => {
    expect(
      selectEligibleForDeletion(
        [],
        () => false,
        () => false
      )
    ).toEqual([])
  })
})

describe("releaseArtifactRunResources", () => {
  it("calls releaseRunPin and reports success when the plan asks for release", async () => {
    const releaseRunPin = vi.fn(async () => {})
    const result = await releaseArtifactRunResources(
      { releaseRunPin },
      { releaseArtifactRunPin: true },
      { runId: "run-1", finalizationId: "fin-1" }
    )
    expect(releaseRunPin).toHaveBeenCalledWith("run-1", "fin-1")
    expect(result).toEqual({ artifactRunPinReleased: true })
  })

  it("is a no-op and reports false when the plan does not ask for release", async () => {
    const releaseRunPin = vi.fn(async () => {})
    const result = await releaseArtifactRunResources(
      { releaseRunPin },
      { releaseArtifactRunPin: false },
      { runId: "run-1", finalizationId: "fin-1" }
    )
    expect(releaseRunPin).not.toHaveBeenCalled()
    expect(result).toEqual({ artifactRunPinReleased: false })
  })

  it("reports false (never throws) when no artifact store is wired", async () => {
    const result = await releaseArtifactRunResources(
      undefined,
      { releaseArtifactRunPin: true },
      { runId: "run-1", finalizationId: "fin-1" }
    )
    expect(result).toEqual({ artifactRunPinReleased: false })
  })

  it("propagates a releaseRunPin failure rather than reporting a false success", async () => {
    const releaseRunPin = vi.fn(async () => {
      throw new Error("simulated crash releasing pin")
    })
    await expect(
      releaseArtifactRunResources(
        { releaseRunPin },
        { releaseArtifactRunPin: true },
        { runId: "run-1", finalizationId: "fin-1" }
      )
    ).rejects.toThrow(/simulated crash/)
  })
})
