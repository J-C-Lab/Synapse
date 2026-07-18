import type { CanonicalJson } from "../runs/canonical-json"
import type { ArtifactTruncationReason } from "./artifact-types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { writeJsonFile } from "../../lan/atomic-json-store"
import { canonicalHash } from "../runs/canonical-json"

// Durable, quota-bounded reservation ledger for the artifact store (design
// §"Allocation limits and producer control"). Every capture reserves the
// worst case (the per-artifact ceiling, narrowed by whatever run/global/disk
// room is left) *before* a byte is written, then settles to the actual
// captured size once streaming stops. A crash between reserve and settle
// leaves a "pending" reservation that reconcileAbandoned() releases at
// startup — mirroring root-budget-ledger.ts's reserve/settle idempotent-
// operation pattern, but against one global ledger file rather than one file
// per run, since the four constraints (artifact/run/global/disk) must be
// judged together against a single source of truth.

export type QuotaLimitReason = Extract<
  ArtifactTruncationReason,
  "artifact-limit" | "run-limit" | "global-limit" | "disk-reserve"
>

export interface ArtifactQuotaLimits {
  perArtifactBytes: number
  perRunBytes: number
  globalBytes: number
  /** Absolute floor of free disk space to always keep available. */
  minFreeBytes: number
  /** Fraction of the volume's total size to keep free, compared against
   *  `minFreeBytes` — the larger of the two wins. */
  minFreeFraction: number
  /** Conservative headroom reserved (in addition to the payload grant)
   *  against the per-run/global/disk constraints for the artifact's own
   *  `manifest.json` — metadata is real bytes on disk and must count toward
   *  the same quotas the payload does, not go unaccounted. Never subtracted
   *  from `perArtifactBytes`, which is a payload-only ceiling; the store
   *  settles the manifest's *actual* measured size (bounded by this
   *  headroom) once it's written, so unused headroom is released like any
   *  other reservation. */
  manifestReserveBytes: number
}

/** v1 defaults (design §"Allocation limits and producer control"): 64 MiB
 *  per artifact, 256 MiB per run, 2 GiB global, and the greater of 1 GiB or
 *  5% of the volume kept free. Centrally defined so no call site hardcodes
 *  these as scattered magic numbers; every value is overridable per call. */
export const DEFAULT_ARTIFACT_QUOTA_LIMITS: ArtifactQuotaLimits = {
  perArtifactBytes: 64 * 1024 * 1024,
  perRunBytes: 256 * 1024 * 1024,
  globalBytes: 2 * 1024 * 1024 * 1024,
  minFreeBytes: 1024 * 1024 * 1024,
  minFreeFraction: 0.05,
  // A real manifest (uri, ids, sha256 hex, timestamps, owner context,
  // delegation list) typically serializes to a few hundred bytes; 4 KiB is a
  // generous, cheap-to-reserve ceiling.
  manifestReserveBytes: 4096,
}

export function freeSpaceReserveBytes(totalBytes: number, limits: ArtifactQuotaLimits): number {
  return Math.max(limits.minFreeBytes, Math.round(totalBytes * limits.minFreeFraction))
}

export interface DiskSpaceInfo {
  freeBytes: number
  totalBytes: number
}

export type StatDiskSpace = (targetPath: string) => Promise<DiskSpaceInfo>

/** Default disk-space probe. Node's `fs.promises.statfs` works cross-platform
 *  (including Windows, via libuv) — no shelling out to platform tools. */
export async function defaultStatDiskSpace(targetPath: string): Promise<DiskSpaceInfo> {
  const stats = await fs.statfs(targetPath)
  return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
}

export class ArtifactQuotaExceededError extends Error {
  constructor(
    public readonly reason: QuotaLimitReason,
    message: string
  ) {
    super(message)
    this.name = "ArtifactQuotaExceededError"
  }
}

export class ArtifactQuotaOperationCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactQuotaOperationCorruptionError"
  }
}

export class UnknownArtifactReservationError extends Error {
  constructor(reserveOperationId: string) {
    super(`unknown or already-settled artifact reservation: ${reserveOperationId}`)
    this.name = "UnknownArtifactReservationError"
  }
}

/** A settle() call asked to commit more bytes than its reservation ever
 *  granted. This must never be silently clamped down — that would let real
 *  disk usage exceed what the ledger ever accounted for, defeating the
 *  hard-ceiling guarantee. Surfacing it loudly means an under-sized
 *  reservation (e.g. a manifest whose real size exceeded its estimated
 *  headroom) is a visible bug, not silently-absorbed drift. */
export class ArtifactQuotaOverrunError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactQuotaOverrunError"
  }
}

// ---------------------------------------------------------------------------
// Pure ledger shape and operations

export interface ArtifactRunUsage {
  reservedBytes: number
  committedBytes: number
}

interface PendingReservation {
  runId: string
  artifactId: string
  bytes: number
}

/** A reservation that survived until process startup. It deliberately
 * exposes no mutable ledger internals: ArtifactStore supplies the only safe
 * answer to "how many bytes really made it to disk?" by inspecting its own
 * manifest/data pair before this store settles the grant. */
export interface PendingArtifactReservation extends PendingReservation {
  reserveOperationId: string
}

export interface ArtifactQuotaOperationReceipt {
  operationId: string
  kind: "reserve" | "settle" | "reclaim"
  runId: string
  artifactId: string
  payloadHash: string
  grantedBytes: number
  limitingReason?: QuotaLimitReason
  actualBytes?: number
  releasedBytes?: number
  appliedAtRevision: number
}

export interface ArtifactQuotaLedgerV1 {
  schemaVersion: 1
  revision: number
  globalReservedBytes: number
  globalCommittedBytes: number
  runs: Record<string, ArtifactRunUsage>
  pendingReservations: Record<string, PendingReservation>
  operations: Record<string, ArtifactQuotaOperationReceipt>
}

export function createEmptyArtifactQuotaLedger(): ArtifactQuotaLedgerV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    globalReservedBytes: 0,
    globalCommittedBytes: 0,
    runs: {},
    pendingReservations: {},
    operations: {},
  }
}

function runUsage(ledger: ArtifactQuotaLedgerV1, runId: string): ArtifactRunUsage {
  return ledger.runs[runId] ?? { reservedBytes: 0, committedBytes: 0 }
}

/** Shared idempotency gate, mirroring root-budget-ledger.ts's
 *  checkOperationIdempotency: a replay under the same operationId with an
 *  identical payload is a harmless no-op; a replay with a different payload
 *  is corruption. */
function checkIdempotency(
  ledger: ArtifactQuotaLedgerV1,
  operationId: string,
  payload: unknown
):
  | { replay: true; receipt: ArtifactQuotaOperationReceipt }
  | { replay: false; payloadHash: string } {
  const payloadHash = canonicalHash(payload as unknown as CanonicalJson)
  const existing = ledger.operations[operationId]
  if (!existing) return { replay: false, payloadHash }
  if (existing.payloadHash !== payloadHash) {
    throw new ArtifactQuotaOperationCorruptionError(
      `artifact quota operation ${operationId} replayed with a different payload`
    )
  }
  return { replay: true, receipt: existing }
}

export interface ReserveInput {
  operationId: string
  runId: string
  artifactId: string
  limits: ArtifactQuotaLimits
  disk: DiskSpaceInfo
}

export interface ReserveOutcome {
  ledger: ArtifactQuotaLedgerV1
  receipt: ArtifactQuotaOperationReceipt
}

/**
 * Reserves the largest payload amount the four constraints simultaneously
 * allow, up to the per-artifact ceiling — **plus** a fixed manifest headroom
 * that is always reserved whenever there is room for it, independent of
 * whether the payload itself gets any room at all. This is deliberate: a
 * denied-payload capture must still be able to write and account for its
 * (small) `manifest.json`, so metadata bytes are never left untracked on the
 * disk-exhausted / quota-exhausted path (see Issue 1 in review). Only throws
 * `ArtifactQuotaExceededError` when even the manifest headroom itself cannot
 * fit anywhere — true, total exhaustion where nothing is safe to write.
 * `grantedBytes` (the payload figure callers truncate their stream against)
 * may legitimately be zero without throwing.
 */
export function reserveArtifactCapacity(
  ledger: ArtifactQuotaLedgerV1,
  input: ReserveInput
): ReserveOutcome {
  const idempotency = checkIdempotency(ledger, input.operationId, {
    operationId: input.operationId,
    runId: input.runId,
    artifactId: input.artifactId,
    limits: input.limits,
  })
  if (idempotency.replay) return { ledger, receipt: idempotency.receipt }

  const run = runUsage(ledger, input.runId)
  const manifestReserve = input.limits.manifestReserveBytes

  const runRemainingTotal = input.limits.perRunBytes - run.reservedBytes - run.committedBytes
  const globalRemainingTotal =
    input.limits.globalBytes - ledger.globalReservedBytes - ledger.globalCommittedBytes
  const diskRemainingTotal =
    // statfs already reflects committed bytes, but it cannot reserve space
    // for captures another caller has admitted and not yet settled. Count
    // those pending grants exactly once here. This is intentionally
    // conservative while a temporary file is partly written: the unsafe
    // alternative lets serial reservations overcommit a stable statfs sample.
    input.disk.freeBytes -
    freeSpaceReserveBytes(input.disk.totalBytes, input.limits) -
    ledger.globalReservedBytes

  // True exhaustion: not even the manifest's own headroom fits anywhere.
  // This is the one case a capture cannot produce a checkpointed ref for at
  // all — genuinely nothing (not even metadata) is safe to write.
  const manifestCandidates: Array<{ bytes: number; reason: QuotaLimitReason }> = [
    { bytes: runRemainingTotal, reason: "run-limit" },
    { bytes: globalRemainingTotal, reason: "global-limit" },
    { bytes: diskRemainingTotal, reason: "disk-reserve" },
  ]
  let manifestBinding = manifestCandidates[0]!
  for (const candidate of manifestCandidates) {
    if (candidate.bytes < manifestBinding.bytes) manifestBinding = candidate
  }
  if (manifestBinding.bytes < manifestReserve) {
    throw new ArtifactQuotaExceededError(
      manifestBinding.reason,
      `cannot reserve even manifest headroom for run ${input.runId}: ${manifestBinding.reason} exhausted`
    )
  }

  // Every remaining-capacity candidate is narrowed by the manifest headroom
  // that's already been proven to fit above — the payload ceiling
  // (perArtifactBytes) is not, since that one is a payload-only cap.
  const runRemaining = runRemainingTotal - manifestReserve
  const globalRemaining = globalRemainingTotal - manifestReserve
  const diskRemaining = diskRemainingTotal - manifestReserve

  const candidates: Array<{ bytes: number; reason: QuotaLimitReason }> = [
    { bytes: input.limits.perArtifactBytes, reason: "artifact-limit" },
    { bytes: runRemaining, reason: "run-limit" },
    { bytes: globalRemaining, reason: "global-limit" },
    { bytes: diskRemaining, reason: "disk-reserve" },
  ]
  let binding = candidates[0]!
  for (const candidate of candidates) {
    if (candidate.bytes < binding.bytes) binding = candidate
  }
  // Legitimately zero (no throw): the payload may be fully denied while the
  // manifest headroom above was still successfully reserved.
  const grantedBytes = Math.max(0, Math.floor(binding.bytes))
  const limitingReason = grantedBytes < input.limits.perArtifactBytes ? binding.reason : undefined

  // The ledger reserves the payload grant *plus* the manifest headroom as
  // one total; settle() later commits the manifest's actual measured size
  // (which must never exceed this total — see ArtifactQuotaOverrunError),
  // so unused headroom is released exactly like unused payload capacity.
  const totalReservedBytes = grantedBytes + manifestReserve

  const receipt: ArtifactQuotaOperationReceipt = {
    operationId: input.operationId,
    kind: "reserve",
    runId: input.runId,
    artifactId: input.artifactId,
    payloadHash: idempotency.payloadHash,
    grantedBytes,
    limitingReason,
    appliedAtRevision: ledger.revision + 1,
  }
  const nextLedger: ArtifactQuotaLedgerV1 = {
    ...ledger,
    revision: ledger.revision + 1,
    globalReservedBytes: ledger.globalReservedBytes + totalReservedBytes,
    runs: {
      ...ledger.runs,
      [input.runId]: { ...run, reservedBytes: run.reservedBytes + totalReservedBytes },
    },
    pendingReservations: {
      ...ledger.pendingReservations,
      [input.operationId]: {
        runId: input.runId,
        artifactId: input.artifactId,
        bytes: totalReservedBytes,
      },
    },
    operations: { ...ledger.operations, [input.operationId]: receipt },
  }
  return { ledger: nextLedger, receipt }
}

export interface SettleInput {
  operationId: string
  reserveOperationId: string
  actualBytes: number
}

export interface ReclaimInput {
  /** A deterministic GC/reconciliation operation id. Replaying the same
   * deletion after a crash is harmless; reusing it for another artifact is
   * corruption, just like reserve/settle operation ids. */
  operationId: string
  runId: string
  artifactId: string
}

export interface CommittedArtifact {
  runId: string
  artifactId: string
  bytes: number
}

function committedArtifactKey(runId: string, artifactId: string): string {
  return canonicalHash([runId, artifactId] as unknown as CanonicalJson)
}

/** Derives live committed artifact bytes from the durable operation log.
 * The ledger predates explicit GC releases, so keeping this derivation (not
 * a new required v1 field) makes existing quota.json files immediately
 * reclaimable without a risky migration. Artifact ids are UUIDs, but the
 * map sums defensively in case a corrupt/legacy log contains more than one
 * settlement for the same identity. */
export function listCommittedArtifacts(ledger: ArtifactQuotaLedgerV1): CommittedArtifact[] {
  const committed = new Map<string, CommittedArtifact>()
  // Object property enumeration is not an operation-order guarantee for
  // numeric-looking ids. `appliedAtRevision` is the durable total order, so
  // replay the log by it when a reclaim must cancel an earlier settlement.
  const receipts = Object.values(ledger.operations).sort(
    (a, b) => a.appliedAtRevision - b.appliedAtRevision
  )
  for (const receipt of receipts) {
    const key = committedArtifactKey(receipt.runId, receipt.artifactId)
    if (receipt.kind === "settle") {
      const bytes = receipt.actualBytes ?? 0
      if (bytes <= 0) continue
      const existing = committed.get(key)
      committed.set(key, {
        runId: receipt.runId,
        artifactId: receipt.artifactId,
        bytes: (existing?.bytes ?? 0) + bytes,
      })
      continue
    }
    if (receipt.kind === "reclaim") committed.delete(key)
  }
  return [...committed.values()]
}

/** Releases the committed bytes belonging to one artifact after its on-disk
 * directory has been removed. This is deliberately a separate idempotent
 * operation rather than folding deletion into settle(): retention may run
 * days later, and a crash after fs.rm must be repairable from quota.json.
 *
 * A missing committed entry is a safe zero-byte no-op. It covers artifacts
 * created before quota accounting existed and a second reconciliation after
 * a successful reclaim, without ever making counters negative. */
export function reclaimArtifactCapacity(
  ledger: ArtifactQuotaLedgerV1,
  input: ReclaimInput
): ReserveOutcome {
  const idempotency = checkIdempotency(ledger, input.operationId, input)
  if (idempotency.replay) return { ledger, receipt: idempotency.receipt }

  const committed = listCommittedArtifacts(ledger).find(
    (entry) => entry.runId === input.runId && entry.artifactId === input.artifactId
  )
  const reclaimedBytes = committed?.bytes ?? 0
  const run = runUsage(ledger, input.runId)
  if (reclaimedBytes > run.committedBytes || reclaimedBytes > ledger.globalCommittedBytes) {
    throw new ArtifactQuotaOperationCorruptionError(
      `artifact quota committed bytes for ${input.runId}/${input.artifactId} exceed ledger totals`
    )
  }

  const receipt: ArtifactQuotaOperationReceipt = {
    operationId: input.operationId,
    kind: "reclaim",
    runId: input.runId,
    artifactId: input.artifactId,
    payloadHash: idempotency.payloadHash,
    grantedBytes: reclaimedBytes,
    releasedBytes: reclaimedBytes,
    appliedAtRevision: ledger.revision + 1,
  }
  return {
    ledger: {
      ...ledger,
      revision: ledger.revision + 1,
      globalCommittedBytes: ledger.globalCommittedBytes - reclaimedBytes,
      runs: {
        ...ledger.runs,
        [input.runId]: {
          reservedBytes: run.reservedBytes,
          committedBytes: run.committedBytes - reclaimedBytes,
        },
      },
      operations: { ...ledger.operations, [input.operationId]: receipt },
    },
    receipt,
  }
}

/** Moves a pending reservation's actual usage into committed totals and
 *  releases whatever was reserved but never used. Used both for a normal
 *  successful capture and for releasing an aborted/failed one (actualBytes
 *  simply ends up 0 or partial in that case).
 *
 *  Never clamps an overrun: `actualBytes` exceeding what was reserved throws
 *  `ArtifactQuotaOverrunError` rather than silently capping the commit at
 *  `pending.bytes`. A caller (capture()'s payload accounting) that only ever
 *  asks to settle at most what it itself reserved will never hit this; it
 *  exists so a mis-sized reservation is a loud, typed failure instead of
 *  quietly letting committed bytes exceed what the ledger ever accounted
 *  for. */
export function settleArtifactCapacity(
  ledger: ArtifactQuotaLedgerV1,
  input: SettleInput
): ReserveOutcome {
  const idempotency = checkIdempotency(ledger, input.operationId, input)
  if (idempotency.replay) return { ledger, receipt: idempotency.receipt }

  const pending = ledger.pendingReservations[input.reserveOperationId]
  if (!pending) throw new UnknownArtifactReservationError(input.reserveOperationId)

  if (input.actualBytes > pending.bytes) {
    throw new ArtifactQuotaOverrunError(
      `settle for reservation ${input.reserveOperationId} requested ${input.actualBytes} bytes, ` +
        `exceeding the ${pending.bytes} bytes actually reserved`
    )
  }
  const actualBytes = Math.max(0, input.actualBytes)
  const releasedBytes = pending.bytes - actualBytes
  const run = runUsage(ledger, pending.runId)

  const { [input.reserveOperationId]: _removed, ...remainingPending } = ledger.pendingReservations
  const receipt: ArtifactQuotaOperationReceipt = {
    operationId: input.operationId,
    kind: "settle",
    runId: pending.runId,
    artifactId: pending.artifactId,
    payloadHash: idempotency.payloadHash,
    grantedBytes: pending.bytes,
    actualBytes,
    releasedBytes,
    appliedAtRevision: ledger.revision + 1,
  }
  const nextLedger: ArtifactQuotaLedgerV1 = {
    ...ledger,
    revision: ledger.revision + 1,
    globalReservedBytes: ledger.globalReservedBytes - pending.bytes,
    globalCommittedBytes: ledger.globalCommittedBytes + actualBytes,
    runs: {
      ...ledger.runs,
      [pending.runId]: {
        reservedBytes: run.reservedBytes - pending.bytes,
        committedBytes: run.committedBytes + actualBytes,
      },
    },
    pendingReservations: remainingPending,
    operations: { ...ledger.operations, [input.operationId]: receipt },
  }
  return { ledger: nextLedger, receipt }
}

/** Releases every reservation still pending (i.e. never settled) — the
 *  startup reconciliation this task's spec calls for. Each release is its
 *  own idempotent settle(actualBytes: 0) so re-running reconciliation twice
 *  in a row is always safe. */
export function reconcileAbandonedPendingReservations(
  ledger: ArtifactQuotaLedgerV1,
  operationIdPrefix: string
): { ledger: ArtifactQuotaLedgerV1; reconciledCount: number; reclaimedBytes: number } {
  let next = ledger
  let reconciledCount = 0
  let reclaimedBytes = 0
  for (const reserveOperationId of Object.keys(ledger.pendingReservations)) {
    const pending = next.pendingReservations[reserveOperationId]
    if (!pending) continue
    const outcome = settleArtifactCapacity(next, {
      operationId: `${operationIdPrefix}:${reserveOperationId}`,
      reserveOperationId,
      actualBytes: 0,
    })
    next = outcome.ledger
    reconciledCount += 1
    reclaimedBytes += pending.bytes
  }
  return { ledger: next, reconciledCount, reclaimedBytes }
}

// ---------------------------------------------------------------------------
// Durable single-file store: <baseDir>/quota.json

const LEDGER_FILE = "quota.json"

export class ArtifactQuotaStore {
  private lock: Promise<void> = Promise.resolve()

  constructor(
    private readonly baseDir: string,
    private readonly statDiskSpace: StatDiskSpace = defaultStatDiskSpace
  ) {}

  async reserve(input: {
    operationId: string
    runId: string
    artifactId: string
    limits: ArtifactQuotaLimits
  }): Promise<ArtifactQuotaOperationReceipt> {
    return this.withLock(async () => {
      const ledger = await this.load()
      const disk = await this.statDiskSpace(this.baseDir)
      const outcome = reserveArtifactCapacity(ledger, { ...input, disk })
      await this.save(outcome.ledger)
      return outcome.receipt
    })
  }

  async settle(input: SettleInput): Promise<ArtifactQuotaOperationReceipt> {
    return this.withLock(async () => {
      const ledger = await this.load()
      const outcome = settleArtifactCapacity(ledger, input)
      await this.save(outcome.ledger)
      return outcome.receipt
    })
  }

  async reclaim(input: ReclaimInput): Promise<ArtifactQuotaOperationReceipt> {
    return this.withLock(async () => {
      const ledger = await this.load()
      const outcome = reclaimArtifactCapacity(ledger, input)
      await this.save(outcome.ledger)
      return outcome.receipt
    })
  }

  /** Compensates the crash window after a caller has removed an artifact
   * directory but before it could durably call reclaim(). The predicate is
   * owned by ArtifactStore because quota.json intentionally knows nothing
   * about filesystem layout. Any predicate failure is fail-closed: leave the
   * committed quota in place and retry on a later collection pass. */
  async reconcileMissingArtifacts(
    isArtifactPresent: (artifact: CommittedArtifact) => Promise<boolean>
  ): Promise<{ reconciledCount: number; reclaimedBytes: number }> {
    return this.withLock(async () => {
      let ledger = await this.load()
      let reconciledCount = 0
      let reclaimedBytes = 0
      for (const artifact of listCommittedArtifacts(ledger)) {
        let present: boolean
        try {
          present = await isArtifactPresent(artifact)
        } catch {
          continue
        }
        if (present) continue
        const outcome = reclaimArtifactCapacity(ledger, {
          operationId: `reconcile-missing:${committedArtifactKey(artifact.runId, artifact.artifactId)}`,
          runId: artifact.runId,
          artifactId: artifact.artifactId,
        })
        ledger = outcome.ledger
        reconciledCount += 1
        reclaimedBytes += outcome.receipt.releasedBytes ?? 0
      }
      if (reconciledCount > 0) await this.save(ledger)
      return { reconciledCount, reclaimedBytes }
    })
  }

  async reconcileAbandoned(): Promise<{ reconciledCount: number; reclaimedBytes: number }> {
    return this.withLock(async () => {
      const ledger = await this.load()
      const result = reconcileAbandonedPendingReservations(ledger, `reconcile-${Date.now()}`)
      await this.save(result.ledger)
      return { reconciledCount: result.reconciledCount, reclaimedBytes: result.reclaimedBytes }
    })
  }

  /** Startup-only reconciliation for captures interrupted between reserve
   * and settle. The artifact store owns the filesystem state, so it returns
   * an exact committed byte count (or zero after safely deleting an
   * unmanifested/corrupt capture). Returning undefined is fail-closed: leave
   * the reservation pending for a later startup rather than guess.
   *
   * Do not call this from ordinary GC. A live process can legitimately have
   * pending reservations while its producer streams data. */
  async reconcileStartupPending(
    recover: (pending: PendingArtifactReservation) => Promise<number | undefined>
  ): Promise<{ reconciledCount: number; reclaimedBytes: number }> {
    return this.withLock(async () => {
      let ledger = await this.load()
      let reconciledCount = 0
      let reclaimedBytes = 0
      for (const [reserveOperationId, pending] of Object.entries(ledger.pendingReservations)) {
        let actualBytes: number | undefined
        try {
          actualBytes = await recover({ ...pending, reserveOperationId })
        } catch {
          continue
        }
        if (
          actualBytes === undefined ||
          !Number.isSafeInteger(actualBytes) ||
          actualBytes < 0 ||
          actualBytes > pending.bytes
        ) {
          continue
        }
        const outcome = settleArtifactCapacity(ledger, {
          operationId: `startup-reconcile:${reserveOperationId}`,
          reserveOperationId,
          actualBytes,
        })
        ledger = outcome.ledger
        reconciledCount += 1
        reclaimedBytes += outcome.receipt.releasedBytes ?? 0
      }
      if (reconciledCount > 0) await this.save(ledger)
      return { reconciledCount, reclaimedBytes }
    })
  }

  private async load(): Promise<ArtifactQuotaLedgerV1> {
    try {
      const text = await fs.readFile(this.ledgerPath(), "utf-8")
      return JSON.parse(text) as ArtifactQuotaLedgerV1
    } catch (err) {
      if (isNotFound(err)) return createEmptyArtifactQuotaLedger()
      throw err
    }
  }

  private async save(ledger: ArtifactQuotaLedgerV1): Promise<void> {
    await writeJsonFile(this.ledgerPath(), ledger)
  }

  private ledgerPath(): string {
    return path.join(this.baseDir, LEDGER_FILE)
  }

  /** One constant lock key: the whole point of this store is that all four
   *  constraints (including the global one) are judged against a single
   *  file, so every mutation is serialized in-process rather than racing on
   *  optimistic-concurrency revisions like the per-run budget ledger does. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
