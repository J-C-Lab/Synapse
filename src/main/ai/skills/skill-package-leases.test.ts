import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  deriveSkillPackageLeaseId,
  releaseSkillPackageLeases,
  SkillPackageLeaseStore,
} from "./skill-package-leases"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempFilePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-skill-leases-"))
  tempDirs.push(dir)
  return path.join(dir, "skill-package-leases.json")
}

describe("deriveSkillPackageLeaseId", () => {
  it("is deterministic for the same triple", () => {
    const input = { packageHash: "hash-a", runId: "run-1", activationId: "act-1" }
    expect(deriveSkillPackageLeaseId(input)).toBe(deriveSkillPackageLeaseId({ ...input }))
  })

  it("differs when any field differs", () => {
    const base = { packageHash: "hash-a", runId: "run-1", activationId: "act-1" }
    const id = deriveSkillPackageLeaseId(base)
    expect(deriveSkillPackageLeaseId({ ...base, packageHash: "hash-b" })).not.toBe(id)
    expect(deriveSkillPackageLeaseId({ ...base, runId: "run-2" })).not.toBe(id)
    expect(deriveSkillPackageLeaseId({ ...base, activationId: "act-2" })).not.toBe(id)
  })
})

describe("skillPackageLeaseStore", () => {
  it("acquire creates a new lease and persists it durably", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    const result = await store.acquire({
      packageHash: "hash-a",
      runId: "run-1",
      activationId: "act-1",
      now: 1000,
    })
    expect(result.created).toBe(true)
    expect(await store.hasActiveLease("hash-a")).toBe(true)

    // Durably persisted: a fresh store instance over the same file sees it.
    const reopened = new SkillPackageLeaseStore(filePath)
    expect(await reopened.hasActiveLease("hash-a")).toBe(true)
    const leases = await reopened.listLeases()
    expect(leases).toHaveLength(1)
    expect(leases[0]).toMatchObject({
      leaseId: result.leaseId,
      packageHash: "hash-a",
      runId: "run-1",
      activationId: "act-1",
      createdAt: 1000,
    })
  })

  it("acquire is idempotent for the same triple", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    const input = { packageHash: "hash-a", runId: "run-1", activationId: "act-1", now: 1000 }
    const first = await store.acquire(input)
    const second = await store.acquire({ ...input, now: 2000 })
    expect(second.created).toBe(false)
    expect(second.leaseId).toBe(first.leaseId)
    expect(await store.listLeases()).toHaveLength(1)
  })

  it("acquire concurrently for distinct activations never loses a write", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.acquire({
          packageHash: "hash-a",
          runId: "run-1",
          activationId: `act-${i}`,
          now: 1000,
        })
      )
    )
    expect(await store.listLeases()).toHaveLength(10)
  })

  it("release removes the lease and is idempotent", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    const { leaseId } = await store.acquire({
      packageHash: "hash-a",
      runId: "run-1",
      activationId: "act-1",
      now: 1000,
    })
    const first = await store.release(leaseId)
    expect(first.released).toBe(true)
    expect(await store.hasActiveLease("hash-a")).toBe(false)

    const second = await store.release(leaseId)
    expect(second.released).toBe(false)
  })

  it("release of an unknown id is a harmless no-op", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    const result = await store.release("never-acquired")
    expect(result.released).toBe(false)
  })

  it("reconcileStartup releases leases not in the live set and keeps the rest", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    const kept = await store.acquire({
      packageHash: "hash-a",
      runId: "run-1",
      activationId: "act-1",
      now: 1000,
    })
    const orphaned = await store.acquire({
      packageHash: "hash-b",
      runId: "run-2",
      activationId: "act-2",
      now: 1000,
    })
    const outcome = await store.reconcileStartup(new Set([kept.leaseId]))
    expect(outcome.releasedCount).toBe(1)
    expect(await store.hasActiveLease("hash-a")).toBe(true)
    expect(await store.hasActiveLease("hash-b")).toBe(false)
    const remaining = await store.listLeases()
    expect(remaining.map((l) => l.leaseId)).toEqual([kept.leaseId])
    void orphaned
  })

  it("reconcileStartup is a no-op when every lease is still live", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    const { leaseId } = await store.acquire({
      packageHash: "hash-a",
      runId: "run-1",
      activationId: "act-1",
      now: 1000,
    })
    const outcome = await store.reconcileStartup(new Set([leaseId]))
    expect(outcome.releasedCount).toBe(0)
    expect(await store.hasActiveLease("hash-a")).toBe(true)
  })

  it("tolerates a missing ledger file", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    expect(await store.hasActiveLease("hash-a")).toBe(false)
    expect(await store.listLeases()).toEqual([])
    expect((await store.reconcileStartup(new Set())).releasedCount).toBe(0)
  })

  it("tolerates a corrupt ledger file by treating it as empty", async () => {
    const filePath = await tempFilePath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, "not json at all", "utf-8")
    const store = new SkillPackageLeaseStore(filePath)
    expect(await store.listLeases()).toEqual([])
  })
})

describe("releaseSkillPackageLeases", () => {
  it("releases every id through the store", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    const a = await store.acquire({
      packageHash: "hash-a",
      runId: "run-1",
      activationId: "act-1",
      now: 1000,
    })
    const b = await store.acquire({
      packageHash: "hash-b",
      runId: "run-1",
      activationId: "act-2",
      now: 1000,
    })
    await releaseSkillPackageLeases(store, [a.leaseId, b.leaseId])
    expect(await store.listLeases()).toEqual([])
  })

  it("is a no-op when store is undefined", async () => {
    await expect(releaseSkillPackageLeases(undefined, ["x"])).resolves.toBeUndefined()
  })

  it("is a no-op for an empty id list", async () => {
    const filePath = await tempFilePath()
    const store = new SkillPackageLeaseStore(filePath)
    await store.acquire({ packageHash: "hash-a", runId: "run-1", activationId: "act-1", now: 1000 })
    await releaseSkillPackageLeases(store, [])
    expect(await store.listLeases()).toHaveLength(1)
  })
})
