import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ArtifactQuotaExceededError,
  ArtifactQuotaOperationCorruptionError,
  ArtifactQuotaStore,
  DEFAULT_ARTIFACT_QUOTA_LIMITS,
  freeSpaceReserveBytes,
} from "./artifact-quota"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-artifact-quota-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function limitsWith(overrides: Partial<typeof DEFAULT_ARTIFACT_QUOTA_LIMITS>) {
  return { ...DEFAULT_ARTIFACT_QUOTA_LIMITS, ...overrides }
}

describe("freeSpaceReserveBytes", () => {
  it("uses the floor when 5% of the volume is smaller than it", () => {
    const limits = limitsWith({ minFreeBytes: 1024, minFreeFraction: 0.05 })
    expect(freeSpaceReserveBytes(1000, limits)).toBe(1024)
  })

  it("uses 5% of the volume when that exceeds the floor", () => {
    const limits = limitsWith({ minFreeBytes: 1024, minFreeFraction: 0.05 })
    expect(freeSpaceReserveBytes(1_000_000, limits)).toBe(50_000)
  })
})

describe("artifactQuotaStore.reserve", () => {
  it("grants the full per-artifact ceiling when run/global/disk have ample room", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 10_000, globalBytes: 100_000 })
    const result = await store.reserve({
      operationId: "op-1",
      runId: "run-1",
      artifactId: "art-1",
      limits,
    })
    expect(result.grantedBytes).toBe(1000)
    expect(result.limitingReason).toBeUndefined()
  })

  it("caps a grant at the remaining per-run budget and reports run-limit", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 1500, globalBytes: 1_000_000 })
    await store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })
    const second = await store.reserve({
      operationId: "op-2",
      runId: "run-1",
      artifactId: "art-2",
      limits,
    })
    expect(second.grantedBytes).toBe(500)
    expect(second.limitingReason).toBe("run-limit")
  })

  it("caps a grant at the remaining global budget and reports global-limit", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 100_000, globalBytes: 1500 })
    await store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })
    const second = await store.reserve({
      operationId: "op-2",
      runId: "run-2",
      artifactId: "art-2",
      limits,
    })
    expect(second.grantedBytes).toBe(500)
    expect(second.limitingReason).toBe("global-limit")
  })

  it("throws ArtifactQuotaExceededError with reason run-limit when a run is already full", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 1000, globalBytes: 1_000_000 })
    await store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })
    await expect(
      store.reserve({ operationId: "op-2", runId: "run-1", artifactId: "art-2", limits })
    ).rejects.toThrow(ArtifactQuotaExceededError)
    await expect(
      store.reserve({ operationId: "op-3", runId: "run-1", artifactId: "art-3", limits })
    ).rejects.toMatchObject({ reason: "run-limit" })
  })

  it("throws ArtifactQuotaExceededError with reason disk-reserve when free space is below the watermark", async () => {
    const lowDisk = async () => ({ freeBytes: 100, totalBytes: 1_000_000 })
    const store = new ArtifactQuotaStore(dir, lowDisk)
    const limits = limitsWith({
      perArtifactBytes: 1000,
      perRunBytes: 100_000,
      globalBytes: 1_000_000,
      minFreeBytes: 1000,
      minFreeFraction: 0,
    })
    await expect(
      store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })
    ).rejects.toMatchObject({ reason: "disk-reserve" })
  })

  it("is idempotent for a retry with the same operationId and payload", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 10_000, globalBytes: 100_000 })
    const first = await store.reserve({
      operationId: "op-1",
      runId: "run-1",
      artifactId: "art-1",
      limits,
    })
    const replay = await store.reserve({
      operationId: "op-1",
      runId: "run-1",
      artifactId: "art-1",
      limits,
    })
    expect(replay).toEqual(first)
    // A replay must not double-count against the run budget.
    const second = await store.reserve({
      operationId: "op-2",
      runId: "run-1",
      artifactId: "art-2",
      limits,
    })
    expect(second.grantedBytes).toBe(1000)
  })

  it("treats a retried operationId with a different payload as corruption", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 10_000, globalBytes: 100_000 })
    await store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })
    await expect(
      store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-2", limits })
    ).rejects.toThrow(ArtifactQuotaOperationCorruptionError)
  })

  it("serializes concurrent reservations against the same run so exactly the expected count succeed", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 100, perRunBytes: 250, globalBytes: 1_000_000 })
    const results = await Promise.allSettled([
      store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits }),
      store.reserve({ operationId: "op-2", runId: "run-1", artifactId: "art-2", limits }),
      store.reserve({ operationId: "op-3", runId: "run-1", artifactId: "art-3", limits }),
    ])
    const granted = results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<ArtifactQuotaStore["reserve"]>>> =>
          r.status === "fulfilled"
      )
      .map((r) => r.value.grantedBytes)
    // 250 total room split across three 100-byte requests: 100 + 100 + 50.
    expect(granted.sort((a, b) => b - a)).toEqual([100, 100, 50])
  })
})

describe("artifactQuotaStore.settle", () => {
  it("moves reserved bytes to committed and releases the unused portion", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    // perRunBytes equal to the per-artifact ceiling so the run budget (not
    // the artifact ceiling) is what binds the second reservation below.
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 1000, globalBytes: 100_000 })
    const reserved = await store.reserve({
      operationId: "op-1",
      runId: "run-1",
      artifactId: "art-1",
      limits,
    })
    expect(reserved.grantedBytes).toBe(1000)
    await store.settle({ operationId: "op-1-settle", reserveOperationId: "op-1", actualBytes: 300 })

    // 300 bytes committed leaves 700 of run headroom; the released 700 (not
    // the full 1000 ceiling) is what the next reservation can get.
    const second = await store.reserve({
      operationId: "op-2",
      runId: "run-1",
      artifactId: "art-2",
      limits,
    })
    expect(second.grantedBytes).toBe(700)
  })

  it("is idempotent for a settle retry with the same operationId", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 10_000, globalBytes: 100_000 })
    await store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })
    const first = await store.settle({
      operationId: "settle-1",
      reserveOperationId: "op-1",
      actualBytes: 300,
    })
    const replay = await store.settle({
      operationId: "settle-1",
      reserveOperationId: "op-1",
      actualBytes: 300,
    })
    expect(replay).toEqual(first)
  })

  it("throws when settling an unknown reservation", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    await expect(
      store.settle({
        operationId: "settle-1",
        reserveOperationId: "never-reserved",
        actualBytes: 10,
      })
    ).rejects.toThrow()
  })
})

describe("artifactQuotaStore.reconcileAbandoned", () => {
  it("releases every never-settled reservation back to free capacity", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 1000, globalBytes: 100_000 })
    await store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })

    // Run is now fully reserved; a second reservation must fail until reconciled.
    await expect(
      store.reserve({ operationId: "op-2", runId: "run-1", artifactId: "art-2", limits })
    ).rejects.toThrow(ArtifactQuotaExceededError)

    const result = await store.reconcileAbandoned()
    expect(result.reconciledCount).toBe(1)
    expect(result.reclaimedBytes).toBe(1000)

    const afterReconcile = await store.reserve({
      operationId: "op-3",
      runId: "run-1",
      artifactId: "art-3",
      limits,
    })
    expect(afterReconcile.grantedBytes).toBe(1000)
  })

  it("survives a fresh store instance reloading the persisted ledger (crash-restart simulation)", async () => {
    const first = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 1000, globalBytes: 100_000 })
    await first.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })

    const restarted = new ArtifactQuotaStore(dir, ampleDisk)
    const result = await restarted.reconcileAbandoned()
    expect(result.reconciledCount).toBe(1)

    const after = await restarted.reserve({
      operationId: "op-2",
      runId: "run-1",
      artifactId: "art-2",
      limits,
    })
    expect(after.grantedBytes).toBe(1000)
  })

  it("does not reconcile a reservation that was already settled", async () => {
    const store = new ArtifactQuotaStore(dir, ampleDisk)
    const limits = limitsWith({ perArtifactBytes: 1000, perRunBytes: 1000, globalBytes: 100_000 })
    await store.reserve({ operationId: "op-1", runId: "run-1", artifactId: "art-1", limits })
    await store.settle({ operationId: "settle-1", reserveOperationId: "op-1", actualBytes: 200 })

    const result = await store.reconcileAbandoned()
    expect(result.reconciledCount).toBe(0)
    expect(result.reclaimedBytes).toBe(0)
  })
})
