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
import { checkArtifactAccess } from "./artifact-access"
import {
  ArtifactQuotaExceededError,
  ArtifactQuotaStore,
  DEFAULT_ARTIFACT_QUOTA_LIMITS,
  defaultStatDiskSpace,
  freeSpaceReserveBytes,
} from "./artifact-quota"
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
  private readonly limits: ArtifactQuotaLimits
  private readonly statDiskSpace: StatDiskSpace
  private readonly now: () => number
  private readonly diskRecheckIntervalBytes: number

  constructor(
    private readonly baseDir: string,
    options: ArtifactStoreOptions = {}
  ) {
    this.limits = options.quotaLimits ?? DEFAULT_ARTIFACT_QUOTA_LIMITS
    this.statDiskSpace = options.statDiskSpace ?? defaultStatDiskSpace
    this.quotaStore = new ArtifactQuotaStore(baseDir, this.statDiskSpace)
    this.now = options.now ?? (() => Date.now())
    this.diskRecheckIntervalBytes = options.diskRecheckIntervalBytes ?? DISK_RECHECK_INTERVAL_BYTES
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

    const artifactId = randomUUID()
    const artifactDir = path.join(this.runDirPath(metadata.runId), artifactId)
    await fs.mkdir(artifactDir, { recursive: true })

    const reserveOperationId = `capture:${metadata.runId}:${artifactId}`
    let grantedBytes = 0
    let limitingReason: ArtifactTruncationReason | undefined
    let deniedReason: ArtifactTruncationReason | undefined
    try {
      const receipt = await this.quotaStore.reserve({
        operationId: reserveOperationId,
        runId: metadata.runId,
        artifactId,
        limits: this.limits,
      })
      grantedBytes = receipt.grantedBytes
      limitingReason = receipt.limitingReason
    } catch (err) {
      if (!(err instanceof ArtifactQuotaExceededError)) throw err
      deniedReason = err.reason
    }

    const tempPath = path.join(artifactDir, TEMP_FILE)
    const finalPath = path.join(artifactDir, DATA_FILE)
    const hash = createHash("sha256")
    let capturedBytes = 0
    let complete = true
    let truncationReason: ArtifactTruncationReason | undefined

    if (deniedReason) {
      complete = false
      truncationReason = deniedReason
      await fs.writeFile(tempPath, new Uint8Array(0))
    } else {
      const handle = await fs.open(tempPath, "w")
      let bytesSinceDiskCheck = 0
      try {
        for await (const rawChunk of toAsyncIterable(input)) {
          if (producer.signal?.aborted) {
            complete = false
            truncationReason = "producer-aborted"
            break
          }
          // Checked before spending anything on this chunk (not after
          // writing it) so a watermark drop rejects the chunk that would
          // breach it rather than a hypothetical next one.
          if (bytesSinceDiskCheck >= this.diskRecheckIntervalBytes) {
            bytesSinceDiskCheck = 0
            const disk = await this.statDiskSpace(this.baseDir)
            const reserve = freeSpaceReserveBytes(disk.totalBytes, this.limits)
            if (disk.freeBytes - reserve <= 0) {
              complete = false
              truncationReason = "disk-reserve"
              break
            }
          }
          const chunk = ArrayBuffer.isView(rawChunk)
            ? toUint8Array(rawChunk)
            : new Uint8Array(rawChunk)
          const remaining = grantedBytes - capturedBytes
          if (remaining <= 0) {
            complete = false
            truncationReason = limitingReason ?? "artifact-limit"
            break
          }
          const toWrite = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
          await handle.write(toWrite)
          hash.update(toWrite)
          capturedBytes += toWrite.length
          bytesSinceDiskCheck += toWrite.length
          if (toWrite.length < chunk.length) {
            complete = false
            truncationReason = limitingReason ?? "artifact-limit"
            break
          }
        }
      } catch {
        complete = false
        truncationReason = "write-error"
      } finally {
        await handle.close()
      }
    }

    if (!complete) {
      await producer.abort(truncationReason!)
    }

    await fs.rename(tempPath, finalPath)

    if (!deniedReason) {
      await this.quotaStore.settle({
        operationId: `${reserveOperationId}:settle`,
        reserveOperationId,
        actualBytes: capturedBytes,
      })
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
    await writeJsonFile(this.manifestPath(metadata.runId, artifactId), manifest)
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
      await handle.read(buffer, 0, length, start)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } finally {
      await handle.close()
    }
  }

  /** No-op in this task: pin/tombstone bookkeeping is Task 21's job. Accepts
   *  the call (validating the runId) so Task 19/21 wiring can start calling
   *  it now without a signature change later. */
  async releaseRunPin(runId: string, _finalizationId: string): Promise<void> {
    if (!isSafeId(runId)) throw new InvalidArtifactRunIdError(runId)
  }

  /** This task's scope: reconcile whatever a crash mid-capture left behind —
   *  never-settled quota reservations and orphaned `data.bin.tmp` files.
   *  Retention-based deletion of otherwise-eligible artifacts is Task 21's
   *  job; `deletedArtifacts`/`deletedBytes` are always 0 here. */
  async collectEligible(): Promise<ArtifactGcResult> {
    const reconciled = await this.quotaStore.reconcileAbandoned()
    const orphanedTempFilesRemoved = await this.removeOrphanedTempFiles()
    return {
      reconciledReservations: reconciled.reconciledCount,
      reclaimedReservedBytes: reconciled.reclaimedBytes,
      orphanedTempFilesRemoved,
      deletedArtifacts: 0,
      deletedBytes: 0,
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

    const manifestPath = await this.resolveContainedPath(ref.runId, ref.artifactId, MANIFEST_FILE)
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(manifestPath, "utf-8"))
    } catch (err) {
      throw new ArtifactReadError(
        "artifact_corrupt",
        `artifact manifest for ${ref.uri} is corrupt: ${(err as Error).message}`
      )
    }
    if (!isValidManifest(raw)) {
      throw new ArtifactReadError(
        "artifact_corrupt",
        `artifact manifest for ${ref.uri} is malformed`
      )
    }
    const manifest = raw

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
