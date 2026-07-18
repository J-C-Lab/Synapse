import type { FileHandle } from "node:fs/promises"
import type { ArtifactQuotaLimits, StatDiskSpace } from "./artifact-quota"
import type {
  AgentArtifactRef,
  AgentArtifactStore,
  ArtifactCaller,
  ArtifactGcResult,
  ArtifactMetadata,
  ArtifactOwnerContext,
  ArtifactProducer,
  ArtifactRange,
  ArtifactTruncationReason,
} from "./artifact-types"
import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { writeJsonFile } from "../../lan/atomic-json-store"
import { logger } from "../../logging"
import { checkArtifactAccess } from "./artifact-access"
import {
  ArtifactQuotaExceededError,
  ArtifactQuotaStore,
  DEFAULT_ARTIFACT_QUOTA_LIMITS,
  defaultStatDiskSpace,
  freeSpaceReserveBytes,
} from "./artifact-quota"
import {
  ArtifactPinStore,
  ArtifactTombstoneStore,
  buildArtifactTombstone,
} from "./artifact-retention"
import {
  ArtifactReadError,
  artifactUri,
  InvalidArtifactIdError,
  InvalidArtifactRunIdError,
} from "./artifact-types"

// The recoverable artifact backend (design §"Recoverable artifact backend").
// Random artifact ids live under `<baseDir>/<runId>/<artifactId>/`; nothing
// ever maps a URI path segment directly onto an arbitrary filesystem path —
// every id is charset-validated before it ever reaches path.join, and every
// resolved path is re-verified via fs.realpath containment before it is
// opened, so a symlink/junction planted inside a run directory can never
// serve bytes from outside it.

const SAFE_ID = /^[\w-]{1,128}$/

function isSafeId(id: string): boolean {
  return SAFE_ID.test(id)
}

const DATA_FILE = "data.bin"
const TEMP_FILE = "data.bin.tmp"
const MANIFEST_FILE = "manifest.json"

/** How often (in captured bytes) capture() re-checks the live free-disk
 *  watermark while streaming a single artifact, in addition to the check
 *  already performed before the producer is opened. */
const DISK_RECHECK_INTERVAL_BYTES = 8 * 1024 * 1024

/** The one place the artifacts root path is computed, mirroring the
 *  `runTraceDir(userDataDir)` / `xFilePath(userDataDir)` convention every
 *  other store in src/main/ai uses. Not wired into src/main/index.ts by this
 *  task — whichever task first needs a live instance does that. */
export function artifactsRoot(userDataDir: string): string {
  return path.join(userDataDir, "artifacts")
}

export interface ArtifactStoreOptions {
  quotaLimits?: ArtifactQuotaLimits
  statDiskSpace?: StatDiskSpace
  now?: () => number
  /** How often (in captured bytes) capture() re-checks the live free-disk
   *  watermark while streaming a single artifact. Defaults to 8 MiB;
   *  overridable so tests don't need an 8 MiB payload to exercise it. */
  diskRecheckIntervalBytes?: number
  /** Cross-store reference check `collectEligible()` uses to decide whether
   *  a terminal (pin-released) run's artifact is still pinned by a canonical
   *  conversation reference (design §"Retention": "GC uses a reverse
   *  -reference index as a cache but rechecks canonical active conversation
   *  /tombstone records immediately before deleting bytes"). The artifact
   *  store itself never imports ConversationStore — this stays a plain
   *  injected predicate so the store remains self-contained (per this
   *  file's own top-of-file access-check rationale); the real predicate is
   *  wired at construction (src/main/index.ts) from
   *  ConversationStore.collectReferencedArtifactUris.
   *
   *  Deliberately conservative when omitted: `collectEligible()` never
   *  deletes any artifact's bytes unless this is provided — matching every
   *  existing test's expectation of `deletedArtifacts: 0` and never risking
   *  data loss from a store constructed without knowledge of what's still
   *  referenced. */
  isArtifactReferenced?: (uri: AgentArtifactRef["uri"]) => Promise<boolean>
}

interface ArtifactManifestV1 {
  envelopeVersion: 1
  ref: AgentArtifactRef
  owner: ArtifactOwnerContext
  delegateToRunIds: string[]
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "tool-result",
  "command-stdout",
  "command-stderr",
  "history",
  "media",
  "child-result",
  "skill-instructions",
  "skill-asset",
])

const KNOWN_TRUNCATION_REASONS: ReadonlySet<string> = new Set([
  "artifact-limit",
  "run-limit",
  "global-limit",
  "disk-reserve",
  "producer-aborted",
  "write-error",
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function isString(v: unknown): v is string {
  return typeof v === "string"
}
function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string"
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean"
}

function isValidToolPrincipal(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.kind === "local-user" || v.kind === "internal-agent") return true
  if (v.kind === "external-mcp") return isOptionalString(v.clientId)
  if (v.kind === "subagent") return isString(v.parentRunId)
  return false
}

function isValidOwnerContext(v: unknown): v is ArtifactOwnerContext {
  if (!isRecord(v)) return false
  if (!isString(v.runId) || !isString(v.rootRunId)) return false
  if (!isOptionalString(v.parentRunId)) return false
  if (!isOptionalString(v.conversationId)) return false
  if (!isOptionalString(v.workspaceId)) return false
  return isValidToolPrincipal(v.principal)
}

function isValidRef(v: unknown): v is AgentArtifactRef {
  if (!isRecord(v)) return false
  if (!isString(v.uri) || !isString(v.runId) || !isString(v.artifactId)) return false
  if (!isString(v.kind) || !KNOWN_KINDS.has(v.kind)) return false
  if (!isString(v.mediaType)) return false
  if (!isFiniteNumber(v.capturedBytes) || v.capturedBytes < 0) return false
  if (v.sourceBytes !== undefined && !isFiniteNumber(v.sourceBytes)) return false
  if (!isBoolean(v.complete)) return false
  if (
    v.truncationReason !== undefined &&
    (!isString(v.truncationReason) || !KNOWN_TRUNCATION_REASONS.has(v.truncationReason))
  ) {
    return false
  }
  if (!isString(v.sha256)) return false
  if (!isFiniteNumber(v.createdAt)) return false
  if (v.expiresAt !== undefined && !isFiniteNumber(v.expiresAt)) return false
  return true
}

function isValidManifest(v: unknown): v is ArtifactManifestV1 {
  if (!isRecord(v)) return false
  if (v.envelopeVersion !== 1) return false
  if (!isValidRef(v.ref)) return false
  if (!isValidOwnerContext(v.owner)) return false
  if (!Array.isArray(v.delegateToRunIds) || !v.delegateToRunIds.every(isString)) return false
  return true
}

// A 36-char placeholder matching randomUUID()'s fixed length exactly, so the
// estimate below doesn't need a real artifactId (not yet known when this is
// first called, and its length is constant regardless of value anyway).
const PLACEHOLDER_ARTIFACT_ID = "00000000-0000-0000-0000-000000000000"

// The longest ArtifactTruncationReason value — used as a draft placeholder
// so the estimate below never undercounts regardless of which reason (if
// any) the real capture ends up with.
const LONGEST_TRUNCATION_REASON: ArtifactTruncationReason = "producer-aborted"

/**
 * Deterministic upper-bound estimate of one artifact's `manifest.json`
 * serialized size, computed almost entirely from `metadata` — known before
 * any reservation or streaming happens — plus worst-case placeholders for
 * the handful of fields only known once streaming completes (`sha256`,
 * `capturedBytes`, `createdAt`, `complete`, `truncationReason`).
 *
 * This exists so the manifest's own disk footprint is never left
 * unaccounted (review Issue 1) *and* so a producer-controlled,
 * effectively-unbounded field — `mediaType` or `delegateToRunIds` — can
 * never silently exceed a fixed configured headroom (review Issue 2): both
 * are measured at their real length here, so the reservation this drives
 * scales with the real input instead of assuming a guessed constant is
 * always enough. It reuses the *real* manifest shape/serialization path
 * (not a hand-derived byte-overhead constant) so it can never drift out of
 * sync with what `writeJsonFile` actually writes.
 */
export function estimateManifestReserveBytes(metadata: ArtifactMetadata): number {
  const draftRef: AgentArtifactRef = {
    uri: artifactUri(metadata.runId, PLACEHOLDER_ARTIFACT_ID),
    runId: metadata.runId,
    artifactId: PLACEHOLDER_ARTIFACT_ID,
    kind: metadata.kind,
    mediaType: metadata.mediaType,
    capturedBytes: Number.MAX_SAFE_INTEGER,
    sourceBytes: metadata.sourceBytes,
    complete: false,
    truncationReason: LONGEST_TRUNCATION_REASON,
    sha256: "0".repeat(64),
    createdAt: Number.MAX_SAFE_INTEGER,
    expiresAt: metadata.expiresAt ?? Number.MAX_SAFE_INTEGER,
  }
  const draftManifest: ArtifactManifestV1 = {
    envelopeVersion: 1,
    ref: draftRef,
    owner: metadata.owner,
    delegateToRunIds: [...(metadata.delegateToRunIds ?? [])],
  }
  return Buffer.byteLength(`${JSON.stringify(draftManifest, null, 2)}\n`, "utf-8")
}

/** Reconstructs a proper same-realm `Uint8Array` view over any typed-array-
 *  like input. Deliberately avoids `instanceof Uint8Array`: a producer built
 *  under jsdom's `TextEncoder` (tests) or a different vm context yields a
 *  `Uint8Array` from another realm, which fails `instanceof` here even
 *  though it is byte-for-byte identical — `ArrayBuffer.isView` is the
 *  realm-safe check every engine implements identically. */
function toUint8Array(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

async function* toAsyncIterable(
  input: AsyncIterable<Uint8Array> | Uint8Array
): AsyncIterable<Uint8Array> {
  if (ArrayBuffer.isView(input)) {
    yield toUint8Array(input)
    return
  }
  yield* input
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}

export class ArtifactStore implements AgentArtifactStore {
  private readonly quotaStore: ArtifactQuotaStore
  private readonly pinStore: ArtifactPinStore
  private readonly tombstoneStore: ArtifactTombstoneStore
  private readonly limits: ArtifactQuotaLimits
  private readonly statDiskSpace: StatDiskSpace
  private readonly now: () => number
  private readonly diskRecheckIntervalBytes: number
  private readonly isArtifactReferenced?: (uri: AgentArtifactRef["uri"]) => Promise<boolean>
  private startupReconciliation?: Promise<{ reconciledCount: number; reclaimedBytes: number }>

  constructor(
    private readonly baseDir: string,
    options: ArtifactStoreOptions = {}
  ) {
    this.limits = options.quotaLimits ?? DEFAULT_ARTIFACT_QUOTA_LIMITS
    this.statDiskSpace = options.statDiskSpace ?? defaultStatDiskSpace
    this.quotaStore = new ArtifactQuotaStore(baseDir, this.statDiskSpace)
    this.pinStore = new ArtifactPinStore(baseDir)
    this.tombstoneStore = new ArtifactTombstoneStore(baseDir)
    this.now = options.now ?? (() => Date.now())
    this.diskRecheckIntervalBytes = Math.max(
      1,
      Math.floor(options.diskRecheckIntervalBytes ?? DISK_RECHECK_INTERVAL_BYTES)
    )
    this.isArtifactReferenced = options.isArtifactReferenced
  }

  async capture(
    input: AsyncIterable<Uint8Array> | Uint8Array,
    metadata: ArtifactMetadata,
    producer: ArtifactProducer
  ): Promise<AgentArtifactRef> {
    if (!isSafeId(metadata.runId)) throw new InvalidArtifactRunIdError(metadata.runId)
    if (metadata.owner.runId !== metadata.runId) {
      throw new Error(
        `artifact metadata owner.runId (${metadata.owner.runId}) must match runId (${metadata.runId})`
      )
    }

    // artifactId is always a fresh crypto-random UUID, never derived from
    // caller-supplied path segments — the traversal/containment defenses in
    // resolveContainedPath exist to re-verify at *read* time, when a
    // symlink/junction could have been planted into an existing run
    // directory after creation. At this write-time point there is nothing
    // an attacker could yet have influenced (the directory we're about to
    // create doesn't exist until this call creates it), so no independent
    // realpath check is needed here.
    const artifactId = randomUUID()
    const artifactDir = path.join(this.runDirPath(metadata.runId), artifactId)
    await fs.mkdir(artifactDir, { recursive: true })

    const reserveOperationId = `capture:${metadata.runId}:${artifactId}`
    // The manifest headroom is sized off *this call's* actual metadata
    // (mediaType/delegateToRunIds are producer-controlled and effectively
    // unbounded in length) rather than trusting a fixed configured floor to
    // always be enough — see estimateManifestReserveBytes.
    const effectiveLimits: ArtifactQuotaLimits = {
      ...this.limits,
      manifestReserveBytes: Math.max(
        this.limits.manifestReserveBytes,
        estimateManifestReserveBytes(metadata)
      ),
    }

    let grantedBytes: number
    let limitingReason: ArtifactTruncationReason | undefined
    try {
      const receipt = await this.quotaStore.reserve({
        operationId: reserveOperationId,
        runId: metadata.runId,
        artifactId,
        limits: effectiveLimits,
      })
      grantedBytes = receipt.grantedBytes
      limitingReason = receipt.limitingReason
    } catch (err) {
      if (!(err instanceof ArtifactQuotaExceededError)) throw err
      // Not even the manifest's own headroom fits anywhere — genuinely
      // nothing is safe to write or account for. Abort the producer and
      // reject rather than fabricate an unaccounted checkpoint.
      await this.abortProducer(producer, err.reason)
      throw err
    }

    // Reservation above always succeeds from this point on (it only ever
    // throws when even the manifest can't fit, handled above) — so every
    // path below, including a fully payload-denied `grantedBytes: 0`, goes
    // through the same open/stream/settle/write-manifest flow. There is no
    // separate "denied" branch that would skip settling and leave the
    // manifest's bytes untracked.
    const tempPath = path.join(artifactDir, TEMP_FILE)
    const finalPath = path.join(artifactDir, DATA_FILE)
    const hash = createHash("sha256")
    let capturedBytes = 0
    let complete = true
    let truncationReason: ArtifactTruncationReason | undefined

    let handle: FileHandle
    try {
      handle = await fs.open(tempPath, "w")
    } catch (err) {
      // A ref is a promise that data.bin exists and matches its digest. If we
      // cannot even create the temporary payload, no valid incomplete ref can
      // be manufactured; compensate the reservation and fail explicitly.
      await this.abortProducer(producer, "write-error")
      await this.abandonCapture(reserveOperationId, artifactDir)
      throw new Error(`unable to open artifact payload for ${metadata.runId}`, { cause: err })
    }

    let bytesUntilDiskCheck = 0
    try {
      for await (const rawChunk of toAsyncIterable(input)) {
        if (producer.signal?.aborted) {
          complete = false
          truncationReason = "producer-aborted"
          break
        }
        const chunk = ArrayBuffer.isView(rawChunk)
          ? toUint8Array(rawChunk)
          : new Uint8Array(rawChunk)
        let chunkOffset = 0
        while (chunkOffset < chunk.length) {
          // Recheck before the first byte and before every bounded write
          // window. The exact current headroom limits the next write, so a
          // single giant producer chunk cannot cross the watermark between
          // periodic checks.
          if (bytesUntilDiskCheck <= 0) {
            const disk = await this.statDiskSpace(this.baseDir)
            const reserve = freeSpaceReserveBytes(disk.totalBytes, this.limits)
            const headroom = Math.floor(disk.freeBytes - reserve)
            if (!Number.isFinite(headroom) || headroom <= 0) {
              complete = false
              truncationReason = "disk-reserve"
              break
            }
            bytesUntilDiskCheck = Math.min(this.diskRecheckIntervalBytes, headroom)
          }

          const remaining = grantedBytes - capturedBytes
          if (remaining <= 0) {
            complete = false
            truncationReason = limitingReason ?? "artifact-limit"
            break
          }
          const byteCount = Math.min(chunk.length - chunkOffset, remaining, bytesUntilDiskCheck)
          if (byteCount <= 0) {
            complete = false
            truncationReason = "disk-reserve"
            break
          }

          const toWrite = chunk.subarray(chunkOffset, chunkOffset + byteCount)
          let writeOffset = 0
          while (writeOffset < toWrite.length) {
            const { bytesWritten } = await handle.write(
              toWrite,
              writeOffset,
              toWrite.length - writeOffset,
              null
            )
            if (bytesWritten <= 0) {
              throw new Error("artifact payload write made no progress")
            }
            const written = toWrite.subarray(writeOffset, writeOffset + bytesWritten)
            // Account only bytes that FileHandle has confirmed reached the
            // OS. If a later short-write continuation fails, the incomplete
            // ref still describes exactly the bytes that did land.
            hash.update(written)
            capturedBytes += bytesWritten
            bytesUntilDiskCheck -= bytesWritten
            writeOffset += bytesWritten
          }
          chunkOffset += toWrite.length
        }
        if (!complete) break
      }
      // A producer can be aborted after yielding its final chunk but before
      // async iteration reaches EOF. Re-check after the loop so that race
      // is never misreported as a complete artifact.
      if (complete && producer.signal?.aborted) {
        complete = false
        truncationReason = "producer-aborted"
      }
    } catch {
      complete = false
      truncationReason = "write-error"
    } finally {
      await handle.close()
    }

    if (!complete) {
      await this.abortProducer(producer, truncationReason!)
    }

    // A manifest may only be committed after the exact final payload exists.
    // Never replace a failed rename with an empty data.bin: that would make a
    // returned ref's byte count/hash describe a file that is not there.
    try {
      await fs.rename(tempPath, finalPath)
    } catch (err) {
      await this.abandonCapture(reserveOperationId, artifactDir)
      throw new Error(`unable to finalize artifact payload for ${metadata.runId}`, { cause: err })
    }

    const ref: AgentArtifactRef = {
      uri: artifactUri(metadata.runId, artifactId),
      runId: metadata.runId,
      artifactId,
      kind: metadata.kind,
      mediaType: metadata.mediaType,
      capturedBytes,
      sourceBytes: metadata.sourceBytes,
      complete,
      truncationReason,
      sha256: hash.digest("hex"),
      createdAt: this.now(),
      expiresAt: metadata.expiresAt,
    }
    const manifest: ArtifactManifestV1 = {
      envelopeVersion: 1,
      ref,
      owner: metadata.owner,
      delegateToRunIds: [...(metadata.delegateToRunIds ?? [])],
    }

    try {
      // Prove the final rename produced the exact bytes the ref commits to
      // before either the manifest or quota settlement makes it durable.
      await this.verifyArtifactData(ref)
    } catch (err) {
      await this.abandonCapture(reserveOperationId, artifactDir)
      throw new Error(`final artifact payload failed verification for ${metadata.runId}`, {
        cause: err,
      })
    }

    // The manifest is this capture's durable commit record, so it lands
    // before the reservation is settled. Startup can then reconcile a crash
    // in the remaining window from a valid manifest plus pending grant.
    // The manifest is real bytes on disk too — settle its actual measured
    // size (matching atomic-json-store.ts's `${JSON.stringify(v, null, 2)}\n`
    // encoding exactly) alongside the payload in the same settle operation.
    // settleArtifactCapacity throws ArtifactQuotaOverrunError rather than
    // silently clamping if this ever exceeds the reserved headroom — which
    // estimateManifestReserveBytes is specifically designed to prevent.
    const manifestBytes = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8")
    try {
      const disk = await this.statDiskSpace(this.baseDir)
      const reserve = freeSpaceReserveBytes(disk.totalBytes, this.limits)
      const headroom = Math.floor(disk.freeBytes - reserve)
      if (!Number.isFinite(headroom) || headroom < manifestBytes) {
        throw new Error("disk watermark cannot admit artifact manifest")
      }
    } catch (err) {
      await this.abandonCapture(reserveOperationId, artifactDir)
      throw new Error(`unable to commit artifact manifest for ${metadata.runId}`, { cause: err })
    }
    try {
      await writeJsonFile(this.manifestPath(metadata.runId, artifactId), manifest)
    } catch (err) {
      // No manifest means no durable reference. Best-effort compensation
      // handles a normal I/O error; startup removes an unmanifested pending
      // directory if the process dies in this branch.
      await this.abandonCapture(reserveOperationId, artifactDir)
      throw err
    }
    await this.quotaStore.settle({
      operationId: `${reserveOperationId}:settle`,
      reserveOperationId,
      actualBytes: capturedBytes + manifestBytes,
    })
    return ref
  }

  async stat(ref: AgentArtifactRef, caller: ArtifactCaller): Promise<AgentArtifactRef> {
    const { manifest } = await this.loadAndAuthorize(ref, caller)
    return manifest.ref
  }

  async read(
    ref: AgentArtifactRef,
    range: ArtifactRange,
    caller: ArtifactCaller
  ): Promise<Uint8Array> {
    const { manifest } = await this.loadAndAuthorize(ref, caller)
    // A manifest is only metadata; never serve bytes merely because it
    // parses. Verify exact length and digest first so short reads, a
    // same-length replacement, and a post-capture append all fail closed.
    await this.verifyArtifactData(manifest.ref)
    const capturedBytes = manifest.ref.capturedBytes
    const start = range.start
    const end = range.end ?? capturedBytes
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      start > capturedBytes
    ) {
      throw new ArtifactReadError(
        "range_invalid",
        `invalid range [${range.start}, ${range.end}) for artifact ${ref.uri} (capturedBytes=${capturedBytes})`
      )
    }
    const clampedEnd = Math.min(end, capturedBytes)
    const length = clampedEnd - start
    if (length === 0) return new Uint8Array(0)

    const dataPath = await this.resolveContainedPath(ref.runId, ref.artifactId, DATA_FILE)
    const handle = await fs.open(dataPath, "r")
    try {
      const buffer = Buffer.alloc(length)
      let offset = 0
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset)
        if (bytesRead === 0) {
          throw new ArtifactReadError(
            "artifact_corrupt",
            `artifact data ended early while reading ${ref.uri}`
          )
        }
        offset += bytesRead
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } finally {
      await handle.close()
    }
  }

  /** Marks `runId`'s pin released — design §"Retention": "Terminal
   *  finalization may release the run pin only after conversation commit."
   *  Idempotent (ArtifactPinStore.release), so a finalization retry after a
   *  crash around this call never double-releases or errors. Once released,
   *  `runId`'s artifacts become GC-eligible in a later `collectEligible()`
   *  sweep, subject to still passing the reference check. */
  async releaseRunPin(runId: string, finalizationId: string): Promise<void> {
    if (!isSafeId(runId)) throw new InvalidArtifactRunIdError(runId)
    await this.pinStore.release(runId, finalizationId, this.now())
  }

  /** Compensates a capture that never produced a verifiable final data.bin.
   * The zero-byte settlement releases the pending capacity before deleting
   * the directory; if the process dies in either step, startup reconciliation
   * sees either the still-pending directory or the operation receipt and can
   * safely finish the idempotent cleanup. */
  private async abandonCapture(reserveOperationId: string, artifactDir: string): Promise<void> {
    await this.quotaStore
      .settle({
        operationId: `${reserveOperationId}:abandon`,
        reserveOperationId,
        actualBytes: 0,
      })
      .catch(() => {})
    await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => {})
  }

  /** Producer cancellation is best effort from the store's perspective: an
   * adapter's abort rejection must never skip durable quota compensation or
   * leave an unverifiable payload directory behind. */
  private async abortProducer(
    producer: ArtifactProducer,
    reason: ArtifactTruncationReason
  ): Promise<void> {
    await Promise.resolve(producer.abort(reason)).catch(() => {})
  }

  /** Reconciles only reservations left by a previous process. This is an
   * explicit startup phase, not part of GC: an ordinary GC sweep can overlap
   * a live capture and therefore must never decide its pending reservation is
   * abandoned. Valid manifest/data pairs are settled exactly; everything
   * else is deleted before a zero-byte settlement so orphaned bytes cannot
   * escape both the quota ledger and later retention. */
  async reconcileStartup(): Promise<{ reconciledCount: number; reclaimedBytes: number }> {
    if (!this.startupReconciliation) {
      this.startupReconciliation = this.reconcileStartupOnce()
    }
    return this.startupReconciliation
  }

  private async reconcileStartupOnce(): Promise<{
    reconciledCount: number
    reclaimedBytes: number
  }> {
    const result = await this.quotaStore.reconcileStartupPending(async (pending) => {
      if (!isSafeId(pending.runId) || !isSafeId(pending.artifactId)) return undefined
      const artifactDir = path.join(this.baseDir, pending.runId, pending.artifactId)
      const manifest = await this.readManifestForGc(pending.runId, pending.artifactId)
      if (
        !manifest ||
        manifest.ref.runId !== pending.runId ||
        manifest.ref.artifactId !== pending.artifactId
      ) {
        await fs.rm(artifactDir, { recursive: true, force: true })
        return 0
      }
      try {
        await this.verifyArtifactData(manifest.ref)
        const manifestPath = await this.resolveContainedPath(
          pending.runId,
          pending.artifactId,
          MANIFEST_FILE
        )
        const manifestBytes = (await fs.stat(manifestPath)).size
        const actualBytes = manifest.ref.capturedBytes + manifestBytes
        // A manifest whose physical bytes exceed its original reservation is
        // not safely recoverable by silently committing an overrun. Remove
        // the orphan and settle zero; the operation log remains internally
        // consistent and a caller never inherits unaccounted disk usage.
        if (actualBytes > pending.bytes) {
          await fs.rm(artifactDir, { recursive: true, force: true })
          return 0
        }
        return actualBytes
      } catch {
        await fs.rm(artifactDir, { recursive: true, force: true })
        return 0
      }
    })
    // At this point no drivers have started in production. Clearing tmp
    // files is safe only in this startup phase, never in collectEligible().
    await this.removeOrphanedTempFiles()
    return result
  }

  /** Runs the Task 21 retention sweep: every artifact whose run has
   *  released its pin AND is not currently referenced (per
   *  `isArtifactReferenced`, re-checked fresh for each candidate rather than
   *  from any cached index) has its bytes deleted and a tombstone recorded.
   *  Never deletes anything when `isArtifactReferenced` was not supplied at
   *  construction — a store with no way to know what's still referenced
   *  must never guess. */
  async collectEligible(): Promise<ArtifactGcResult> {
    // Do not reconcile pending reservations or remove tmp files here. GC is
    // allowed while a live capture owns both, and revoking that reservation
    // would turn a successful capture into UnknownArtifactReservationError.
    // Startup-only recovery is performed by reconcileStartup().
    // A prior process may have died after removing an eligible directory but
    // before reclaiming its settled quota. Detect only directories that are
    // genuinely absent (not malformed or merely unreadable) and compensate
    // from the durable quota operation log before considering new deletions.
    await this.quotaStore.reconcileMissingArtifacts(async ({ runId, artifactId }) => {
      // quota.json is durable input too. Never let a corrupted historical
      // operation turn this recovery probe into a path traversal outside the
      // artifacts root; leave that entry accounted for rather than guessing.
      if (!isSafeId(runId) || !isSafeId(artifactId)) return true
      try {
        await fs.access(path.join(this.baseDir, runId, artifactId))
        return true
      } catch (err) {
        if (isNotFound(err)) return false
        throw err
      }
    })
    const deletion = await this.deleteEligibleArtifacts()
    await this.tombstoneStore.pruneExpired(this.now())
    return {
      reconciledReservations: 0,
      reclaimedReservedBytes: 0,
      orphanedTempFilesRemoved: 0,
      deletedArtifacts: deletion.deletedArtifacts,
      deletedBytes: deletion.deletedBytes,
    }
  }

  private async deleteEligibleArtifacts(): Promise<{
    deletedArtifacts: number
    deletedBytes: number
  }> {
    if (!this.isArtifactReferenced) return { deletedArtifacts: 0, deletedBytes: 0 }
    const isArtifactReferenced = this.isArtifactReferenced

    let runIds: string[]
    try {
      runIds = await fs.readdir(this.baseDir)
    } catch (err) {
      if (isNotFound(err)) return { deletedArtifacts: 0, deletedBytes: 0 }
      throw err
    }

    let deletedArtifacts = 0
    let deletedBytes = 0
    for (const runId of runIds.filter(isSafeId)) {
      // Non-terminal (pin never released) runs are always skipped in full —
      // never even enumerated further — matching "Non-terminal run
      // artifacts are pinned against deletion."
      if (await this.pinStore.isPinned(runId)) continue

      const runDir = path.join(this.baseDir, runId)
      let artifactIds: string[]
      try {
        artifactIds = await fs.readdir(runDir)
      } catch {
        continue
      }

      const candidates: { runId: string; artifactId: string; uri: AgentArtifactRef["uri"] }[] = []
      const manifestByArtifactId = new Map<string, ArtifactManifestV1>()
      for (const artifactId of artifactIds.filter(isSafeId)) {
        const manifest = await this.readManifestForGc(runId, artifactId)
        if (!manifest) continue
        manifestByArtifactId.set(artifactId, manifest)
        candidates.push({ runId, artifactId, uri: manifest.ref.uri })
      }
      if (candidates.length === 0) continue

      // Design §"Retention": "GC ... rechecks canonical active conversation
      // /tombstone records immediately before deleting bytes." The reference
      // check for a given candidate MUST happen right before that same
      // candidate's fs.rm — never precomputed for the whole run up front —
      // or a reference that appears mid-sweep (e.g. a concurrent commitRun
      // adding a fresh conversation turn while this loop is still working
      // through earlier candidates) could be missed, deleting bytes a
      // canonical record now depends on. selectEligibleForDeletion's pure
      // batch form intentionally isn't used here for exactly that reason —
      // it would require precomputing every candidate's reference state in
      // one pass before any deletion, reopening this race.
      for (const candidate of candidates) {
        // Fault-isolate one candidate's reference check from the rest of the
        // sweep: a JSON-parse failure inside collectReferencedArtifactUris is
        // already handled there (swallowed → treated as absent), but ANY
        // OTHER failure (permissions, EIO, ...) must never abort the whole
        // GC pass — it would discard the quota-reconciliation/orphaned-temp
        // -file work already done earlier in this call and skip every other
        // run/candidate that had nothing wrong with it. Fail closed for just
        // this one candidate (treat a throwing check as "referenced" — never
        // delete on an inconclusive answer) and keep going.
        let referenced: boolean
        try {
          referenced = await isArtifactReferenced(candidate.uri)
        } catch (err) {
          logger.child("artifact-retention").error("reference check failed during GC sweep", {
            uri: candidate.uri,
            err,
          })
          continue
        }
        if (referenced) continue
        const manifest = manifestByArtifactId.get(candidate.artifactId)!
        const artifactDir = path.join(runDir, candidate.artifactId)
        await this.tombstoneStore.record(
          buildArtifactTombstone(manifest.ref, this.now(), "retention-terminal-unreferenced")
        )
        // Make deletion intent durable before removing bytes. A crash before
        // fs.rm merely retries next sweep; a crash after it is reconciled
        // from quota.json before another quota decision is made.
        await fs.rm(artifactDir, { recursive: true, force: true })
        await this.quotaStore.reclaim({
          operationId: `gc-reclaim:${runId}:${candidate.artifactId}`,
          runId,
          artifactId: candidate.artifactId,
        })
        deletedArtifacts += 1
        deletedBytes += manifest.ref.capturedBytes
      }

      // Best-effort: remove the run directory once every artifact under it
      // is gone. Never fatal — a concurrent capture racing this sweep (or a
      // leftover unexpected file) just leaves the directory in place.
      try {
        const remaining = await fs.readdir(runDir)
        if (remaining.length === 0) await fs.rmdir(runDir)
      } catch {
        // best-effort only
      }
    }
    return { deletedArtifacts, deletedBytes }
  }

  /** Host-internal manifest read for the GC sweep only: no forgery/access
   *  checks (nothing here is caller-supplied), and any failure (missing,
   *  corrupt, symlink-escape) just means "skip this artifact this sweep" —
   *  never a thrown ArtifactReadError, unlike loadManifestById below. Still
   *  goes through resolveContainedPath so a GC sweep can never be tricked
   *  into reading outside a run's own directory. */
  private async readManifestForGc(
    runId: string,
    artifactId: string
  ): Promise<ArtifactManifestV1 | undefined> {
    try {
      const manifestPath = await this.resolveContainedPath(runId, artifactId, MANIFEST_FILE)
      const raw = JSON.parse(await fs.readFile(manifestPath, "utf-8"))
      return isValidManifest(raw) ? raw : undefined
    } catch {
      return undefined
    }
  }

  private async removeOrphanedTempFiles(): Promise<number> {
    let removed = 0
    let runIds: string[]
    try {
      runIds = await fs.readdir(this.baseDir)
    } catch (err) {
      if (isNotFound(err)) return 0
      throw err
    }
    for (const runId of runIds.filter(isSafeId)) {
      const runDir = path.join(this.baseDir, runId)
      let artifactIds: string[]
      try {
        artifactIds = await fs.readdir(runDir)
      } catch {
        continue
      }
      for (const artifactId of artifactIds.filter(isSafeId)) {
        try {
          await fs.rm(path.join(runDir, artifactId, TEMP_FILE))
          removed += 1
        } catch (err) {
          if (!isNotFound(err)) throw err
        }
      }
    }
    return removed
  }

  /** Loads and shape-validates the on-disk manifest for `runId`/`artifactId`
   *  by id alone — no caller-supplied ref to cross-check, since that step
   *  differs between `loadAndAuthorize` (has one) and `resolve` (doesn't).
   *  Throws the same closed `ArtifactReadError` codes either caller already
   *  surfaces: `artifact_missing` for an unknown/invalid id,
   *  `artifact_corrupt` for unreadable/malformed JSON. Never checks access —
   *  every caller of this helper runs `checkArtifactAccess` itself
   *  immediately after, against whatever `caller` context it has. */
  private async loadManifestById(runId: string, artifactId: string): Promise<ArtifactManifestV1> {
    if (!isSafeId(runId) || !isSafeId(artifactId)) {
      throw new ArtifactReadError(
        "artifact_missing",
        `unknown artifact: run/${runId}/${artifactId}`
      )
    }
    let manifestPath: string
    try {
      manifestPath = await this.resolveContainedPath(runId, artifactId, MANIFEST_FILE)
    } catch (err) {
      throw await this.expiredOrRethrow(runId, artifactId, err)
    }
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(manifestPath, "utf-8"))
    } catch (err) {
      // resolveContainedPath already realpath'd this exact path, so ENOENT
      // here would only happen if something deleted it in between (a GC
      // sweep racing this read) — treat identically to the not-found case
      // above rather than misreporting a race as corruption.
      if (isNotFound(err)) throw await this.expiredOrRethrow(runId, artifactId, err)
      throw new ArtifactReadError(
        "artifact_corrupt",
        `artifact manifest for run/${runId}/${artifactId} is corrupt: ${(err as Error).message}`
      )
    }
    if (!isValidManifest(raw)) {
      throw new ArtifactReadError(
        "artifact_corrupt",
        `artifact manifest for run/${runId}/${artifactId} is malformed`
      )
    }
    return raw
  }

  /** A "not found" outcome is ambiguous on its own: it could mean the id was
   *  never valid (the pre-existing `artifact_missing` meaning), or it could
   *  mean retention deleted real bytes that once existed. Distinguishes the
   *  two by checking the tombstone ledger before deciding which
   *  ArtifactReadError to throw — `artifact_expired` (with the tombstone
   *  attached) only when this store itself recorded deleting it. */
  private async expiredOrRethrow(runId: string, artifactId: string, err: unknown): Promise<Error> {
    if (err instanceof ArtifactReadError && err.code === "artifact_missing") {
      const tombstone = await this.tombstoneStore.get(artifactUri(runId, artifactId))
      if (tombstone) {
        return new ArtifactReadError(
          "artifact_expired",
          `artifact expired: its bytes were deleted by retention (run/${runId}/${artifactId})`,
          tombstone
        )
      }
      return err
    }
    if (err instanceof Error) return err
    return new Error(String(err))
  }

  async resolve(
    runId: string,
    artifactId: string,
    caller: ArtifactCaller
  ): Promise<AgentArtifactRef> {
    const manifest = await this.loadManifestById(runId, artifactId)
    if (!checkArtifactAccess(manifest.owner, manifest.delegateToRunIds, caller)) {
      throw new ArtifactReadError(
        "artifact_forbidden",
        `caller run ${caller.runId} may not read artifact ${manifest.ref.uri}`
      )
    }
    return manifest.ref
  }

  private async loadAndAuthorize(
    ref: AgentArtifactRef,
    caller: ArtifactCaller
  ): Promise<{ manifest: ArtifactManifestV1 }> {
    if (!isSafeId(ref.runId) || !isSafeId(ref.artifactId)) {
      throw new ArtifactReadError("artifact_missing", `unknown artifact: ${ref.uri}`)
    }
    if (ref.uri !== artifactUri(ref.runId, ref.artifactId)) {
      throw new ArtifactReadError("artifact_forbidden", `forged artifact uri: ${ref.uri}`)
    }

    const manifest = await this.loadManifestById(ref.runId, ref.artifactId)

    // Never trust the caller-supplied ref for anything security-relevant —
    // only the freshly loaded, on-disk manifest is authoritative. A ref
    // whose fields disagree with it is either forged or stale.
    if (
      manifest.ref.runId !== ref.runId ||
      manifest.ref.artifactId !== ref.artifactId ||
      manifest.ref.uri !== ref.uri ||
      manifest.ref.sha256 !== ref.sha256
    ) {
      throw new ArtifactReadError(
        "artifact_forbidden",
        `artifact ref does not match its stored manifest: ${ref.uri}`
      )
    }

    if (!checkArtifactAccess(manifest.owner, manifest.delegateToRunIds, caller)) {
      throw new ArtifactReadError(
        "artifact_forbidden",
        `caller run ${caller.runId} may not read artifact ${ref.uri}`
      )
    }

    return { manifest }
  }

  /** Streams and verifies the authoritative data file. `FileHandle.read`
   * may legally return fewer bytes than requested, so this never relies on
   * a single read or implicitly zero-filled Buffer tail. A full digest check
   * is deliberately done before every public read for correctness; a future
   * verified chunk index/cache may optimize that only if it preserves this
   * exact invalidation and mutation-detection contract. */
  private async verifyArtifactData(ref: AgentArtifactRef): Promise<void> {
    const dataPath = await this.resolveContainedPath(ref.runId, ref.artifactId, DATA_FILE)
    const handle = await fs.open(dataPath, "r")
    try {
      const hash = createHash("sha256")
      let offset = 0
      const chunkSize = 64 * 1024
      while (offset < ref.capturedBytes) {
        const buffer = Buffer.alloc(Math.min(chunkSize, ref.capturedBytes - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (bytesRead === 0) {
          throw new ArtifactReadError(
            "artifact_corrupt",
            `artifact data is shorter than its manifest for ${ref.uri}`
          )
        }
        hash.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      const extra = Buffer.alloc(1)
      const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, ref.capturedBytes)
      if (extraBytes !== 0) {
        throw new ArtifactReadError(
          "artifact_corrupt",
          `artifact data is longer than its manifest for ${ref.uri}`
        )
      }
      if (hash.digest("hex") !== ref.sha256) {
        throw new ArtifactReadError(
          "artifact_corrupt",
          `artifact data digest does not match its manifest for ${ref.uri}`
        )
      }
    } finally {
      await handle.close()
    }
  }

  /** Resolves `<baseDir>/<runId>/<artifactId>/<fileName>` and verifies —
   *  via fs.realpath, post-open — that the real path is still contained
   *  under the real run directory. Rejects a symlink/junction planted
   *  anywhere in the chain that would otherwise serve bytes from outside
   *  the run's own tree. */
  private async resolveContainedPath(
    runId: string,
    artifactId: string,
    fileName: string
  ): Promise<string> {
    if (!isSafeId(artifactId)) throw new InvalidArtifactIdError(artifactId)
    const runDir = this.runDirPath(runId)
    const candidate = path.join(runDir, artifactId, fileName)

    let realRunDir: string
    let realCandidate: string
    try {
      realRunDir = await fs.realpath(runDir)
    } catch (err) {
      if (isNotFound(err))
        throw new ArtifactReadError("artifact_missing", `unknown artifact run: ${runId}`)
      throw err
    }
    try {
      realCandidate = await fs.realpath(candidate)
    } catch (err) {
      if (isNotFound(err)) {
        throw new ArtifactReadError(
          "artifact_missing",
          `unknown artifact: ${runId}/${artifactId}/${fileName}`
        )
      }
      throw err
    }

    const boundary = realRunDir.endsWith(path.sep) ? realRunDir : realRunDir + path.sep
    if (realCandidate !== realRunDir && !realCandidate.startsWith(boundary)) {
      throw new ArtifactReadError(
        "artifact_forbidden",
        `artifact path escapes its run directory: ${runId}/${artifactId}/${fileName}`
      )
    }
    return realCandidate
  }

  private runDirPath(runId: string): string {
    if (!isSafeId(runId)) throw new InvalidArtifactRunIdError(runId)
    return path.join(this.baseDir, runId)
  }

  private manifestPath(runId: string, artifactId: string): string {
    if (!isSafeId(artifactId)) throw new InvalidArtifactIdError(artifactId)
    return path.join(this.runDirPath(runId), artifactId, MANIFEST_FILE)
  }
}
