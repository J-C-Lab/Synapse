import type { CanonicalJson } from "../runs/canonical-json"
import type { ParsedSkillPackage, SkillPackageManifestEntry } from "./skill-package-parser"
import type { SkillPackageRef } from "./skill-types"
import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { writeJsonFile } from "../../lan/atomic-json-store"
import { canonicalHash } from "../runs/canonical-json"
import { normalizeSkillRelativePath } from "./skill-paths"
import { skillPackageUri } from "./skill-types"

// The immutable, content-addressed skill package store (design §"Discovery
// and conflicts": "Discovery does not leave a descriptor pointing at mutable
// source bytes... ingests the exact files into an immutable
// SkillPackageStore. The returned SkillPackageRef is content addressed by
// that canonical package hash... it never changes bytes behind an existing
// ref."). Deliberately mirrors artifact-store.ts's defensive posture for
// storing similarly untrusted bytes: literal resolved containment, post
// -realpath verification before any read, and atomic stage-then-rename
// ingestion so a crash mid-copy can never leave a half-written package
// reachable under its final hash-addressed name.
//
// v1 quota note: this store enforces a fixed aggregate byte cap (computed
// by summing already-ingested manifests) plus a live free-disk watermark
// check before staging new bytes, rather than a full durable
// reserve/settle ledger like artifact-quota.ts's. That is a deliberate v1
// simplification — the skill catalog is expected to hold at most a few
// dozen small packages, so an O(n) directory walk per ingest is cheap and a
// persisted ledger would be premature; a future checkpoint should promote
// this to a real ledger if the store ever needs to scale past that.

export class SkillPackageStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "SkillPackageStoreError"
  }
}

export class SkillPackageQuotaExceededError extends SkillPackageStoreError {}

const MANIFEST_FILE = "manifest.json"
const PAYLOAD_DIR = "payload"
const PACKAGE_HASH_PATTERN = /^[0-9a-f]{64}$/
const STAGING_PREFIX = ".tmp-"

export interface SkillPackageManifestV1 {
  schemaVersion: 1
  /** Canonical: sorted by `relPath`, exactly as `parseSkillPackage` returns
   *  it. Never re-sorted here — a caller that hands in an unsorted manifest
   *  gets a hash that reflects exactly what it handed in, not a silently
   *  reordered one. */
  entries: SkillPackageManifestEntry[]
}

function isValidManifestEntry(v: unknown): v is SkillPackageManifestEntry {
  if (!v || typeof v !== "object") return false
  const entry = v as Record<string, unknown>
  return (
    typeof entry.relPath === "string" &&
    typeof entry.length === "number" &&
    Number.isFinite(entry.length) &&
    entry.length >= 0 &&
    typeof entry.sha256 === "string"
  )
}

function isValidManifest(v: unknown): v is SkillPackageManifestV1 {
  if (!v || typeof v !== "object") return false
  const record = v as Record<string, unknown>
  return (
    record.schemaVersion === 1 &&
    Array.isArray(record.entries) &&
    record.entries.every(isValidManifestEntry)
  )
}

/** Design §"Discovery and conflicts": "the package store has its own
 *  aggregate quota". Fixed for v1 rather than user-configurable. */
export const DEFAULT_SKILL_PACKAGE_STORE_MAX_AGGREGATE_BYTES = 512 * 1024 * 1024

/** Mirrors artifact-quota.ts's `freeSpaceReserveBytes` formula (the greater
 *  of an absolute floor and a fraction of total volume size) without
 *  importing its `ArtifactQuotaLimits` shape — this store's quota
 *  parameters are its own, independent of the artifact store's. */
export const DEFAULT_SKILL_PACKAGE_STORE_MIN_FREE_BYTES = 512 * 1024 * 1024
export const DEFAULT_SKILL_PACKAGE_STORE_MIN_FREE_FRACTION = 0.05

export interface DiskSpaceInfo {
  freeBytes: number
  totalBytes: number
}
export type StatDiskSpace = (targetPath: string) => Promise<DiskSpaceInfo>

export async function defaultStatDiskSpace(targetPath: string): Promise<DiskSpaceInfo> {
  const stats = await fs.statfs(targetPath)
  return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
}

/** The one place the skill-packages root path is computed, mirroring
 *  artifact-store.ts's `artifactsRoot(userDataDir)` convention. */
export function skillPackagesRoot(userDataDir: string): string {
  return path.join(userDataDir, "skill-packages")
}

/** Deterministic identity of the manifest's content (paths, lengths, and
 *  per-file hashes) — the "table of contents" hash. */
export function computeSkillManifestHash(manifest: SkillPackageManifestV1): string {
  return canonicalHash(manifest as unknown as CanonicalJson)
}

/** The address a package is actually stored under. Wrapping `manifestHash`
 *  in its own versioned envelope (rather than reusing it verbatim as the
 *  storage key) means a future manifest-schema bump can change how packages
 *  are addressed without also having to change how a manifest's own content
 *  identity is computed. */
export function computeSkillPackageHash(manifestHash: string): string {
  return canonicalHash({ schemaVersion: 1, manifestHash } as unknown as CanonicalJson)
}

export interface SkillPackageStoreOptions {
  statDiskSpace?: StatDiskSpace
  maxAggregateBytes?: number
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}

async function copyAndHash(
  sourcePath: string,
  destPath: string
): Promise<{ length: number; sha256: string }> {
  const hash = createHash("sha256")
  let length = 0
  const source = await fs.open(sourcePath, "r")
  try {
    const dest = await fs.open(destPath, "w")
    try {
      const chunkSize = 64 * 1024
      const buffer = Buffer.alloc(chunkSize)
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, chunkSize, null)
        if (bytesRead === 0) break
        const chunk = buffer.subarray(0, bytesRead)
        hash.update(chunk)
        length += bytesRead
        let written = 0
        while (written < chunk.length) {
          const { bytesWritten } = await dest.write(chunk, written, chunk.length - written, null)
          if (bytesWritten <= 0)
            throw new SkillPackageStoreError(`write made no progress: ${destPath}`)
          written += bytesWritten
        }
      }
    } finally {
      await dest.close()
    }
  } finally {
    await source.close()
  }
  return { length, sha256: hash.digest("hex") }
}

/**
 * Immutable, content-addressed store for validated skill packages
 * (`<baseDir>/<packageHash>/{manifest.json,payload/...}`). `ingest()` is
 * idempotent by content: re-ingesting identical bytes returns the same ref
 * without touching disk again; ingesting changed bytes always produces a
 * different `packageHash` while the previous directory's bytes stay exactly
 * as they were.
 */
export class SkillPackageStore {
  constructor(
    private readonly baseDir: string,
    private readonly options: SkillPackageStoreOptions = {}
  ) {}

  async ingest(parsed: ParsedSkillPackage): Promise<SkillPackageRef> {
    const manifest: SkillPackageManifestV1 = { schemaVersion: 1, entries: parsed.manifest }
    const manifestHash = computeSkillManifestHash(manifest)
    const packageHash = computeSkillPackageHash(manifestHash)
    const capturedBytes = parsed.manifest.reduce((sum, entry) => sum + entry.length, 0)
    const fileCount = parsed.manifest.length

    const ref: SkillPackageRef = {
      uri: skillPackageUri(packageHash),
      packageHash,
      manifestHash,
      capturedBytes,
      fileCount,
    }

    const existing = await this.readManifestIfPresent(packageHash)
    if (existing) {
      // Idempotent content-addressed reuse: identical bytes are already
      // durably ingested under this hash. Never re-write or re-verify
      // against the (possibly since-changed) source — the store's own
      // previously-verified copy is authoritative from here on.
      return ref
    }

    await this.checkCapacity(capturedBytes)

    const packageDir = this.packageDirPath(packageHash)
    const stagingDir = path.join(this.baseDir, `${STAGING_PREFIX}${randomUUID()}`)
    await fs.mkdir(path.join(stagingDir, PAYLOAD_DIR), { recursive: true })
    try {
      for (const entry of parsed.manifest) {
        const sourcePath = parsed.sourcePaths.get(entry.relPath)
        if (!sourcePath) {
          throw new SkillPackageStoreError(
            `manifest entry missing its source path: ${entry.relPath}`
          )
        }
        const destPath = path.join(stagingDir, PAYLOAD_DIR, ...entry.relPath.split("/"))
        await fs.mkdir(path.dirname(destPath), { recursive: true })
        const copied = await copyAndHash(sourcePath, destPath)
        // Re-verify against the manifest entry the parser already computed
        // — this is the one place a TOCTOU change to a source file between
        // parse-time hashing and this copy would be caught. A descriptor
        // must never point at a package whose bytes silently drifted from
        // what was validated.
        if (copied.length !== entry.length || copied.sha256 !== entry.sha256) {
          throw new SkillPackageStoreError(
            `source bytes for ${entry.relPath} changed between validation and ingestion`
          )
        }
      }
      await writeJsonFile(path.join(stagingDir, MANIFEST_FILE), manifest)

      try {
        await fs.rename(stagingDir, packageDir)
      } catch (err) {
        // A concurrent ingest of the exact same content may have already
        // won the race and created packageDir first — harmless for a
        // content-addressed store, since the directory name IS the hash of
        // the content, so the winner's bytes are guaranteed identical.
        // Anything else is a genuine failure.
        const nowExisting = await this.readManifestIfPresent(packageHash)
        if (!nowExisting) {
          throw new SkillPackageStoreError(`unable to commit skill package ${packageHash}`, {
            cause: err,
          })
        }
      }
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }

    return ref
  }

  async stat(packageHash: string): Promise<SkillPackageRef | undefined> {
    const manifest = await this.readManifestIfPresent(packageHash)
    if (!manifest) return undefined
    return {
      uri: skillPackageUri(packageHash),
      packageHash,
      manifestHash: computeSkillManifestHash(manifest),
      capturedBytes: manifest.entries.reduce((sum, entry) => sum + entry.length, 0),
      fileCount: manifest.entries.length,
    }
  }

  /** Reads one file's exact bytes back out of an ingested package,
   *  containment-checked the same way artifact-store.ts's
   *  `resolveContainedPath` is: resolved via `fs.realpath` and verified to
   *  still be inside the package's own payload directory, so a
   *  symlink/junction planted after ingestion (there should never be one —
   *  ingestion only ever creates plain files/directories — but this is the
   *  same defense-in-depth artifact-store.ts applies at read time) can
   *  never serve bytes from outside it. */
  async read(packageHash: string, relPath: string): Promise<Uint8Array> {
    const normalizedRelPath = normalizeSkillRelativePath(relPath)
    const payloadDir = path.join(this.packageDirPath(packageHash), PAYLOAD_DIR)
    const candidate = path.join(payloadDir, ...normalizedRelPath.split("/"))

    let realPayloadDir: string
    try {
      realPayloadDir = await fs.realpath(payloadDir)
    } catch (err) {
      if (isNotFound(err)) {
        throw new SkillPackageStoreError(`unknown skill package: ${packageHash}`)
      }
      throw err
    }
    let realCandidate: string
    try {
      realCandidate = await fs.realpath(candidate)
    } catch (err) {
      if (isNotFound(err)) {
        throw new SkillPackageStoreError(`unknown file in skill package: ${packageHash}/${relPath}`)
      }
      throw err
    }
    const boundary = realPayloadDir.endsWith(path.sep) ? realPayloadDir : realPayloadDir + path.sep
    if (realCandidate !== realPayloadDir && !realCandidate.startsWith(boundary)) {
      throw new SkillPackageStoreError(
        `path escapes its package payload directory: ${packageHash}/${relPath}`
      )
    }
    const data = await fs.readFile(realCandidate)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }

  /** Startup-only cleanup: removes any `.tmp-*` staging directory left
   *  behind by a process that crashed mid-`ingest()`. Safe to call only
   *  before any live `ingest()` call has started in this process — a
   *  staging directory is always a fresh `randomUUID()` name that `ingest`
   *  itself removes in a `finally` block on every path (success or
   *  failure), so anything matching this prefix that survives to the next
   *  startup can only be crash debris, never a concurrently-running
   *  ingest's live directory. Mirrors artifact-store.ts's
   *  `reconcileStartup()` being called once, before any driver/GC starts. */
  async reconcileStartup(): Promise<{ removedStagingDirs: number }> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.baseDir)
    } catch (err) {
      if (isNotFound(err)) return { removedStagingDirs: 0 }
      throw err
    }
    let removedStagingDirs = 0
    for (const name of entries) {
      if (!name.startsWith(STAGING_PREFIX)) continue
      await fs.rm(path.join(this.baseDir, name), { recursive: true, force: true })
      removedStagingDirs += 1
    }
    return { removedStagingDirs }
  }

  private packageDirPath(packageHash: string): string {
    if (!PACKAGE_HASH_PATTERN.test(packageHash)) {
      throw new SkillPackageStoreError(`invalid package hash: ${packageHash}`)
    }
    return path.join(this.baseDir, packageHash)
  }

  private async readManifestIfPresent(
    packageHash: string
  ): Promise<SkillPackageManifestV1 | undefined> {
    let raw: string
    try {
      raw = await fs.readFile(path.join(this.packageDirPath(packageHash), MANIFEST_FILE), "utf-8")
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new SkillPackageStoreError(`corrupt manifest for package ${packageHash}`, {
        cause: err,
      })
    }
    if (!isValidManifest(parsed)) {
      throw new SkillPackageStoreError(`malformed manifest for package ${packageHash}`)
    }
    return parsed
  }

  /** Sums the `capturedBytes` of every already-ingested package (see this
   *  file's top-of-file quota note for why this is a directory walk rather
   *  than a durable ledger in v1) and rejects if admitting `incomingBytes`
   *  would exceed the configured aggregate cap, or if live free disk space
   *  is already inside its reserve watermark. Fails closed: any per-package
   *  read error other than "not found" aborts the whole check rather than
   *  silently under-counting usage. */
  private async checkCapacity(incomingBytes: number): Promise<void> {
    const maxAggregateBytes =
      this.options.maxAggregateBytes ?? DEFAULT_SKILL_PACKAGE_STORE_MAX_AGGREGATE_BYTES

    let entries: string[]
    try {
      entries = await fs.readdir(this.baseDir)
    } catch (err) {
      if (isNotFound(err)) entries = []
      else throw err
    }
    let aggregateBytes = 0
    for (const name of entries) {
      if (!PACKAGE_HASH_PATTERN.test(name)) continue // skip staging dirs and anything unexpected
      const manifest = await this.readManifestIfPresent(name)
      if (!manifest) continue
      aggregateBytes += manifest.entries.reduce((sum, entry) => sum + entry.length, 0)
    }
    if (aggregateBytes + incomingBytes > maxAggregateBytes) {
      throw new SkillPackageQuotaExceededError(
        `ingesting ${incomingBytes} bytes would exceed the skill package store's aggregate cap ` +
          `of ${maxAggregateBytes} bytes (currently ${aggregateBytes})`
      )
    }

    const statDiskSpace = this.options.statDiskSpace ?? defaultStatDiskSpace
    await fs.mkdir(this.baseDir, { recursive: true })
    const disk = await statDiskSpace(this.baseDir)
    const reserve = Math.max(
      DEFAULT_SKILL_PACKAGE_STORE_MIN_FREE_BYTES,
      Math.round(disk.totalBytes * DEFAULT_SKILL_PACKAGE_STORE_MIN_FREE_FRACTION)
    )
    const headroom = disk.freeBytes - reserve
    if (!Number.isFinite(headroom) || headroom < incomingBytes) {
      throw new SkillPackageQuotaExceededError(
        `insufficient disk headroom to ingest ${incomingBytes} bytes while keeping the ` +
          `${reserve}-byte reserve watermark free`
      )
    }
  }
}
