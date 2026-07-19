import type { CanonicalJson } from "../runs/canonical-json"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"
import { canonicalHash } from "../runs/canonical-json"

// Durable bookkeeping for skill-package leases (Task 25, design
// §"Progressive disclosure": "acquires a durable package lease keyed by
// run/activation/package hash ... Uninstall removes the catalog reference
// but cannot delete package bytes while any activation lease exists.").
//
// Task 24 built no package deletion/GC — nothing today consumes "this
// package has zero active leases" to actually remove bytes. This store's
// only job is to record which (runId, activationId) pairs currently hold a
// lease on which packageHash, correctly and durably, so a later checkpoint
// can build GC on top of it without reworking the bookkeeping. Mirrors
// skill-package-store.ts's defensive posture (content-addressed identity,
// in-process mutex around every mutation) at a much smaller scale: a single
// JSON ledger file rather than a content-addressed directory tree, since a
// lease record is a few dozen bytes, not a payload.

export interface SkillPackageLeaseRecord {
  leaseId: string
  packageHash: string
  runId: string
  activationId: string
  createdAt: number
}

export interface SkillPackageLeaseLedgerV1 {
  schemaVersion: 1
  leases: SkillPackageLeaseRecord[]
}

function emptyLedger(): SkillPackageLeaseLedgerV1 {
  return { schemaVersion: 1, leases: [] }
}

function isValidLeaseRecord(v: unknown): v is SkillPackageLeaseRecord {
  if (!v || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  return (
    typeof r.leaseId === "string" &&
    typeof r.packageHash === "string" &&
    typeof r.runId === "string" &&
    typeof r.activationId === "string" &&
    typeof r.createdAt === "number" &&
    Number.isFinite(r.createdAt)
  )
}

function isValidLedger(v: unknown): v is SkillPackageLeaseLedgerV1 {
  if (!v || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  return r.schemaVersion === 1 && Array.isArray(r.leases) && r.leases.every(isValidLeaseRecord)
}

/** The one place a lease id is derived — deterministic (not random) so
 *  acquiring the same (packageHash, runId, activationId) triple twice (e.g.
 *  a caller retrying a not-yet-committed activation) is idempotent and
 *  always yields the identical id, matching the "recoverable operation id"
 *  pattern the design describes for lease acquisition. */
export function deriveSkillPackageLeaseId(input: {
  packageHash: string
  runId: string
  activationId: string
}): string {
  return canonicalHash({
    packageHash: input.packageHash,
    runId: input.runId,
    activationId: input.activationId,
  } as unknown as CanonicalJson)
}

/** The one place a lease ledger file lives, mirroring
 *  skill-package-store.ts's skillPackagesRoot(userDataDir) convention. */
export function skillPackageLeasesFilePath(userDataDir: string): string {
  return path.join(userDataDir, "skill-package-leases.json")
}

export interface SkillPackageLeaseAcquireInput {
  packageHash: string
  runId: string
  activationId: string
  now: number
}

export interface SkillPackageLeaseAcquireResult {
  leaseId: string
  /** False when an identical (packageHash, runId, activationId) lease was
   *  already held — acquiring it again is a no-op, not a second record. */
  created: boolean
}

/**
 * Durable, file-backed ledger of skill-package leases. `acquire`/`release`/
 * `reconcileStartup` are serialized through an in-process promise-chain
 * mutex (mirroring SkillPackageStore.withLock) so two concurrent callers
 * against the one process-wide instance never race a read-modify-write.
 */
export class SkillPackageLeaseStore {
  private lock: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  /** Idempotent: acquiring the same (packageHash, runId, activationId)
   *  triple twice returns the same leaseId and does not duplicate the
   *  record. */
  async acquire(input: SkillPackageLeaseAcquireInput): Promise<SkillPackageLeaseAcquireResult> {
    return this.withLock(async () => {
      const ledger = await this.readLedger()
      const leaseId = deriveSkillPackageLeaseId(input)
      if (ledger.leases.some((l) => l.leaseId === leaseId)) {
        return { leaseId, created: false }
      }
      const record: SkillPackageLeaseRecord = {
        leaseId,
        packageHash: input.packageHash,
        runId: input.runId,
        activationId: input.activationId,
        createdAt: input.now,
      }
      await writeJsonFile(this.filePath, { ...ledger, leases: [...ledger.leases, record] })
      return { leaseId, created: true }
    })
  }

  /** Idempotent: releasing an id that is not (or no longer) held is a
   *  harmless no-op — safe to call repeatedly from a retried finalization
   *  phase (run-finalizer.ts's resources_released phase). */
  async release(leaseId: string): Promise<{ released: boolean }> {
    return this.withLock(async () => {
      const ledger = await this.readLedger()
      const next = ledger.leases.filter((l) => l.leaseId !== leaseId)
      if (next.length === ledger.leases.length) return { released: false }
      await writeJsonFile(this.filePath, { ...ledger, leases: next })
      return { released: true }
    })
  }

  /** Whether any lease currently exists for `packageHash` — the query a
   *  future package-GC pass would consult before deleting a package's
   *  bytes. Nothing in this checkpoint calls it for that purpose yet (see
   *  this file's top-of-file note). */
  async hasActiveLease(packageHash: string): Promise<boolean> {
    const ledger = await this.readLedger()
    return ledger.leases.some((l) => l.packageHash === packageHash)
  }

  async listLeases(): Promise<SkillPackageLeaseRecord[]> {
    const ledger = await this.readLedger()
    return ledger.leases
  }

  /** Removes every ledger entry whose leaseId is not in `liveLeaseIds` —
   *  e.g. a lease acquired for an activation whose checkpoint commit never
   *  landed before a crash (design §"Progressive disclosure": "an acquired
   *  lease without a matching activation is released after
   *  reconciliation"). `liveLeaseIds` is caller-supplied rather than
   *  computed here: this module owns lease bookkeeping only, not scanning
   *  every run's checkpoint — a caller with access to AgentRunStore (e.g.
   *  src/main/index.ts's startup sequence) derives the still-referenced set
   *  from every non-terminal-or-not-yet-resource-released checkpoint's
   *  `activatedSkills[].packageLeaseId` and passes it in here. */
  async reconcileStartup(liveLeaseIds: ReadonlySet<string>): Promise<{ releasedCount: number }> {
    return this.withLock(async () => {
      const ledger = await this.readLedger()
      const next = ledger.leases.filter((l) => liveLeaseIds.has(l.leaseId))
      const releasedCount = ledger.leases.length - next.length
      if (releasedCount > 0) {
        await writeJsonFile(this.filePath, { ...ledger, leases: next })
      }
      return { releasedCount }
    })
  }

  private async readLedger(): Promise<SkillPackageLeaseLedgerV1> {
    const raw = await readJsonFile(this.filePath)
    if (raw === null) return emptyLedger()
    if (!isValidLedger(raw)) return emptyLedger()
    return raw
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

/** Releases every id in `leaseIds` through `store`, idempotently. The
 *  shared release-side-effect run-finalizer.ts's resources_released phase
 *  (and every composition-root wiring site) calls — see this file's
 *  top-of-file note on why release is safe to call repeatedly. `store`
 *  undefined is a no-op, mirroring artifact-retention.ts's
 *  releaseArtifactRunResources's own "no store wired" tolerance. */
export async function releaseSkillPackageLeases(
  store: SkillPackageLeaseStore | undefined,
  leaseIds: readonly string[]
): Promise<void> {
  if (!store || leaseIds.length === 0) return
  for (const leaseId of leaseIds) {
    await store.release(leaseId)
  }
}
