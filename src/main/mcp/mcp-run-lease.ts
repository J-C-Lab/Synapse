import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import process from "node:process"

const SAFE_RUN_ID = /^[\w-]{1,128}$/
const DEFAULT_STALE_AFTER_MS = 30_000
const FILE_OPERATION_MAX_ATTEMPTS = 8
const DEFAULT_FILE_OPERATION_RETRY_DELAY_MS = 10

interface McpRunLeaseRecord {
  schemaVersion: 1
  ownerId: string
  pid: number
  acquiredAt: number
}

export interface McpRunLease {
  runId: string
  ownerId: string
  /** An opaque filesystem path. Only McpRunLeaseStore may release it. */
  readonly path: string
}

export interface McpRunLeaseStoreOptions {
  now?: () => number
  /** A lease is reclaimable only after this age *and* a failed PID probe. */
  staleAfterMs?: number
  /** Test seam. Production uses the current Node process PID. */
  processId?: number
  /** Test seam. EPERM deliberately counts as alive in the production probe. */
  isProcessAlive?: (pid: number) => boolean
  /** Test seam for short-lived Windows file locks during cleanup. */
  unlink?: (filePath: string) => Promise<void>
  /** Test seam. Production waits briefly between bounded cleanup retries. */
  fileOperationRetryDelayMs?: number
  /** Named crash-recovery test seam. Never set in production. */
  fault?: (
    point:
      | "after_temp_write_before_link"
      | "after_link_before_temp_cleanup"
      | "after_claim_temp_write_before_rename"
  ) => void
}

export class McpRunLeaseBusyError extends Error {
  constructor(runId: string) {
    super(`MCP run ${runId} is already owned by another process`)
    this.name = "McpRunLeaseBusyError"
  }
}

/**
 * Cross-process ownership for the short external section of an MCP call.
 *
 * AgentRunStore's revision and promise locks deliberately coordinate only one
 * process. This store adds a filesystem owner record, atomically installed
 * with link(2), before an MCP checkpoint is created. Recovery takes it only
 * when the owner record is both old enough to be stale and its PID is gone.
 * A stale record is atomically renamed to a uniquely named recovery claim,
 * so two stdio servers cannot both decide to terminalize the same call.
 */
export class McpRunLeaseStore {
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly processId: number
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly unlink: (filePath: string) => Promise<void>
  private readonly fileOperationRetryDelayMs: number
  private readonly fault: McpRunLeaseStoreOptions["fault"]

  constructor(
    private readonly runsDir: string,
    options: McpRunLeaseStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.processId = options.processId ?? process.pid
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive
    this.unlink = options.unlink ?? ((filePath) => fs.unlink(filePath))
    this.fileOperationRetryDelayMs =
      options.fileOperationRetryDelayMs ?? DEFAULT_FILE_OPERATION_RETRY_DELAY_MS
    this.fault = options.fault
    if (!Number.isSafeInteger(this.processId) || this.processId <= 0) {
      throw new Error("MCP run lease requires a positive process id")
    }
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 0) {
      throw new Error("MCP run lease staleAfterMs must be a non-negative integer")
    }
    if (
      !Number.isSafeInteger(this.fileOperationRetryDelayMs) ||
      this.fileOperationRetryDelayMs < 0
    ) {
      throw new Error("MCP run lease fileOperationRetryDelayMs must be a non-negative integer")
    }
  }

  /** Acquires the live owner before a new request publishes its checkpoint. */
  async acquire(runId: string): Promise<McpRunLease> {
    assertSafeRunId(runId)
    const ownerPath = this.ownerPath(runId)
    if ((await this.hasRecoveryClaim(runId)) || (await this.hasRecoveryGate(runId))) {
      throw new McpRunLeaseBusyError(runId)
    }
    return this.createAt(runId, ownerPath)
  }

  /**
   * Claims a non-terminal checkpoint only when no live process can still be
   * driving it. A missing owner is an old-version/orphaned checkpoint and is
   * claimed atomically at the normal owner path. A current implementation
   * always owns before checkpoint creation, so a live request never enters
   * this branch.
   */
  async claimStale(runId: string): Promise<McpRunLease | undefined> {
    assertSafeRunId(runId)
    const gate = await this.acquireRecoveryGate(runId)
    if (!gate) return undefined
    try {
      return await this.claimStaleUnderGate(runId)
    } finally {
      await this.release(gate)
    }
  }

  private async claimStaleUnderGate(runId: string): Promise<McpRunLease | undefined> {
    const ownerPath = this.ownerPath(runId)
    const owner = await this.readRecord(ownerPath)
    if (owner) return this.claimStalePath(runId, ownerPath, owner)

    const claims = await this.recoveryClaimPaths(runId)
    if (claims.length > 0) {
      const inspected = await Promise.all(
        claims.map(async (claimPath) => ({ claimPath, record: await this.readRecord(claimPath) }))
      )
      // A malformed claim is intentionally never reclaimed automatically:
      // without a valid PID we cannot prove an owner is dead.
      if (inspected.some(({ record }) => !record || !this.isStaleAndDead(record))) return undefined
      return this.claimStalePath(runId, inspected[0]!.claimPath, inspected[0]!.record!)
    }

    try {
      return await this.createAt(runId, ownerPath)
    } catch (err) {
      if (err instanceof McpRunLeaseBusyError) return undefined
      throw err
    }
  }

  /** Releases only the exact owner token that acquired this lease. */
  async release(lease: McpRunLease): Promise<void> {
    const current = await this.readRecord(lease.path)
    if (!current?.record || current.record.ownerId !== lease.ownerId) return
    await this.removeFileIfPresent(lease.path)
  }

  /** Removes every lease artifact for a run already known to have reached a
   * durable terminal finalization. Unlike release(), this intentionally does
   * not require a matching owner token: phase-complete checkpoint evidence is
   * the fence that makes owner, recovery claim, and recovery gate all safe to
   * discard together. */
  async purgeTerminal(runId: string): Promise<void> {
    assertSafeRunId(runId)
    for (const filePath of await this.leasePaths(runId)) {
      await this.removeFileIfPresent(filePath)
    }
  }

  /** Every run id represented by a lease artifact. Used only by stdio startup
   * to reclaim a post-purge crash: the checkpoint is already gone, so normal
   * phase-complete scanning cannot name its leftover owner file. */
  async leasedRunIds(): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.leasesDir())
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    const runIds = new Set<string>()
    for (const name of names) {
      const runId = runIdFromLeaseName(name)
      if (runId) runIds.add(runId)
    }
    return [...runIds]
  }

  /** Removes an owner/claim/gate set only when every remaining artifact names
   * a stale PID confirmed dead. This is the safe fallback for the narrow
   * checkpoint-purged-before-lease-cleanup crash window. */
  async purgeStaleDeadOrphan(runId: string): Promise<boolean> {
    assertSafeRunId(runId)
    const paths = await this.leasePaths(runId)
    if (paths.length === 0) return false
    const inspections = await Promise.all(paths.map((filePath) => this.readRecord(filePath)))
    if (inspections.some((inspection) => !inspection || !this.isStaleAndDead(inspection))) {
      return false
    }
    for (const filePath of paths) await this.removeFileIfPresent(filePath)
    return true
  }

  /** Reclaims only a temp whose serialized owner (or, if a crash interrupted
   * its write, its PID/timestamp-bearing filename) is both stale and dead.
   * A live acquire may be paused between write/link, so age alone is never
   * enough to delete its `.tmp-*` file. */
  async purgeStaleDeadTemps(): Promise<number> {
    let names: string[]
    try {
      names = await fs.readdir(this.leasesDir())
    } catch (err) {
      if (isNotFound(err)) return 0
      throw err
    }
    let purged = 0
    for (const name of names) {
      if (!name.startsWith(".tmp-")) continue
      const filePath = path.join(this.leasesDir(), name)
      const inspection = await this.tempInspection(filePath, name)
      if (!inspection || !this.isStaleAndDead(inspection)) continue
      await this.removeFileIfPresent(filePath)
      purged++
    }
    return purged
  }

  /** Returns the earliest remaining wait for a dead lease artifact that is
   * not stale yet. Stdio uses this to schedule one bounded follow-up sweep
   * after a quick restart, instead of paying for a directory scan per MCP
   * request. The later sweep still rechecks both age and PID before deleting
   * anything, so this method is planning-only and never grants deletion. */
  async nextStaleDeadSweepDelay(): Promise<number | undefined> {
    let names: string[]
    try {
      names = await fs.readdir(this.leasesDir())
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
    let earliest: number | undefined
    for (const name of names) {
      const filePath = path.join(this.leasesDir(), name)
      const inspection = name.startsWith(".tmp-")
        ? await this.tempInspection(filePath, name)
        : runIdFromLeaseName(name)
          ? await this.readRecord(filePath)
          : undefined
      const record = inspection?.record
      if (!record || this.isProcessAlive(record.pid)) continue
      const remaining = Math.max(0, this.staleAfterMs - this.leaseAge({ ...inspection, record }))
      earliest = earliest === undefined ? remaining : Math.min(earliest, remaining)
    }
    return earliest
  }

  private async createAt(runId: string, destination: string): Promise<McpRunLease> {
    const ownerId = randomUUID()
    const record: McpRunLeaseRecord = {
      schemaVersion: 1,
      ownerId,
      pid: this.processId,
      acquiredAt: this.now(),
    }
    await fs.mkdir(this.leasesDir(), { recursive: true })
    const tempPath = path.join(this.leasesDir(), tempName(record))
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", flag: "wx" })
    } catch (err) {
      await this.removeFileIfPresent(tempPath)
      throw err
    }
    // Deliberately outside the cleanup catch: this seam models process death,
    // so startup must prove it can reclaim the complete temp itself.
    this.fault?.("after_temp_write_before_link")
    try {
      // A hard link is an atomic create-if-absent. Unlike opening the
      // destination with "wx" and then writing it, no contender can ever
      // observe a partially written owner record.
      await fs.link(tempPath, destination)
    } catch (err) {
      await this.removeFileIfPresent(tempPath)
      if (isAlreadyExists(err)) throw new McpRunLeaseBusyError(runId)
      throw err
    }
    // Same crash model after a destination is already visible; the temporary
    // hard link is still safe to collect independently on next stdio startup.
    this.fault?.("after_link_before_temp_cleanup")
    await this.removeFileIfPresent(tempPath)
    return { runId, ownerId, path: destination }
  }

  private async claimStalePath(
    runId: string,
    sourcePath: string,
    inspected: LeaseInspection
  ): Promise<McpRunLease | undefined> {
    if (!this.isStaleAndDead(inspected)) return undefined

    // Refresh the inode timestamp before renaming it. If this process dies
    // between rename and metadata replacement, another recoverer still waits
    // for a full stale interval rather than racing an in-progress hand-off.
    const now = this.now()
    try {
      await fs.utimes(sourcePath, new Date(now), new Date(now))
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }

    const claimPath = this.recoveryClaimPath(runId)
    try {
      await renameWithRetry(sourcePath, claimPath)
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }

    const record = {
      schemaVersion: 1,
      ownerId: randomUUID(),
      pid: this.processId,
      acquiredAt: now,
    } satisfies McpRunLeaseRecord
    await this.replaceClaimRecord(claimPath, record)
    return { runId, ownerId: record.ownerId, path: claimPath }
  }

  /** Replaces a stale recovery claim with this process's ownership record.
   * Its temp follows the same PID/timestamp-bearing protocol as acquire(),
   * so a hard crash after write but before rename is sweepable without ever
   * treating a live recovery claimant as stale by age alone. */
  private async replaceClaimRecord(claimPath: string, record: McpRunLeaseRecord): Promise<void> {
    const tempPath = path.join(this.leasesDir(), tempName(record))
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      })
    } catch (err) {
      await this.removeFileIfPresent(tempPath)
      throw err
    }
    // Deliberately outside cleanup: a process death here leaves a complete,
    // owner-identifiable temp for the stdio startup stale+dead sweep.
    this.fault?.("after_claim_temp_write_before_rename")
    try {
      await renameWithRetry(tempPath, claimPath)
    } catch (err) {
      await this.removeFileIfPresent(tempPath)
      throw err
    }
  }

  private async readRecord(filePath: string): Promise<LeaseInspection | undefined> {
    let text: string
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      ;[text, stat] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)])
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { record: undefined, modifiedAt: stat.mtimeMs }
    }
    return {
      record: isLeaseRecord(value) ? value : undefined,
      modifiedAt: stat.mtimeMs,
    }
  }

  private async tempInspection(
    filePath: string,
    name: string
  ): Promise<LeaseInspection | undefined> {
    const inspection = await this.readRecord(filePath)
    if (inspection?.record) return inspection
    const identity = tempIdentityFromName(name)
    if (!identity) return undefined
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(filePath)
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
    return {
      record: {
        schemaVersion: 1,
        ownerId: "temp-write-interrupted",
        pid: identity.pid,
        acquiredAt: identity.acquiredAt,
      },
      modifiedAt: stat.mtimeMs,
    }
  }

  private isStaleAndDead(inspection: LeaseInspection): boolean {
    const record = inspection.record
    if (!record) return false
    return (
      this.leaseAge({ ...inspection, record }) >= this.staleAfterMs &&
      !this.isProcessAlive(record.pid)
    )
  }

  private leaseAge(inspection: LeaseInspection & { record: McpRunLeaseRecord }): number {
    const now = this.now()
    // A synthetic test clock may predate the filesystem epoch. In production
    // mtime is never in the future; ignore a future value so test seams retain
    // the same stale-owner semantics without making real future timestamps
    // reclaimable.
    const modifiedAt = inspection.modifiedAt <= now ? inspection.modifiedAt : 0
    const mostRecentEvidence = Math.max(inspection.record.acquiredAt, modifiedAt)
    return now - mostRecentEvidence
  }

  private async hasRecoveryClaim(runId: string): Promise<boolean> {
    return (await this.recoveryClaimPaths(runId)).length > 0
  }

  /** Serializes stale-owner inspection itself. A winner retains a separate
   * recovery claim after releasing this short gate, so later recoverers see
   * that live claim rather than acting on an old scan snapshot. */
  private async acquireRecoveryGate(runId: string): Promise<McpRunLease | undefined> {
    const gatePath = this.recoveryGatePath(runId)
    try {
      return await this.createAt(runId, gatePath)
    } catch (err) {
      if (!(err instanceof McpRunLeaseBusyError)) throw err
    }

    const existing = await this.readRecord(gatePath)
    if (!existing || !this.isStaleAndDead(existing)) return undefined
    // The stale process is confirmed dead. Re-check the exact owner before
    // every retry so an old locked gate can never delete a new live gate that
    // appeared while Windows was releasing the old file handle.
    if (!(await this.removeStaleGateIfUnchanged(gatePath, existing))) return undefined
    try {
      return await this.createAt(runId, gatePath)
    } catch (err) {
      if (err instanceof McpRunLeaseBusyError) return undefined
      throw err
    }
  }

  private async hasRecoveryGate(runId: string): Promise<boolean> {
    try {
      await fs.access(this.recoveryGatePath(runId))
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  /** Removes a recovery gate only while it still names the stale inspected
   * owner. Unlike terminal cleanup, this path is not fenced by a completed
   * checkpoint, so a retry must be conservative about a replacement owner. */
  private async removeStaleGateIfUnchanged(
    gatePath: string,
    expected: LeaseInspection
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const current = await this.readRecord(gatePath)
      if (!current) return false
      if (!sameLeaseOwner(current, expected) || !this.isStaleAndDead(current)) return false
      try {
        await this.unlink(gatePath)
        return true
      } catch (err) {
        if (isNotFound(err)) return false
        if (attempt >= FILE_OPERATION_MAX_ATTEMPTS || !isTransientFileOperationError(err)) {
          throw err
        }
        await delay(this.fileOperationRetryDelayMs * attempt)
      }
    }
  }

  /** Bounded Windows cleanup retry. An EPERM/EBUSY has not removed the file,
   * so retrying is safe; all other failures deliberately remain observable. */
  private async removeFileIfPresent(filePath: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.unlink(filePath)
        return
      } catch (err) {
        if (isNotFound(err)) return
        if (attempt >= FILE_OPERATION_MAX_ATTEMPTS || !isTransientFileOperationError(err)) {
          throw err
        }
        await delay(this.fileOperationRetryDelayMs * attempt)
      }
    }
  }

  private async recoveryClaimPaths(runId: string): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.leasesDir())
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    const prefix = `${runId}.recovery-`
    return names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .sort()
      .map((name) => path.join(this.leasesDir(), name))
  }

  private async leasePaths(runId: string): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.leasesDir())
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    const owner = `${runId}.owner.json`
    const gate = `${runId}.reconcile.json`
    const recoveryPrefix = `${runId}.recovery-`
    return names
      .filter(
        (name) =>
          name === owner ||
          name === gate ||
          (name.startsWith(recoveryPrefix) && name.endsWith(".json"))
      )
      .map((name) => path.join(this.leasesDir(), name))
  }

  private leasesDir(): string {
    return path.join(this.runsDir, ".mcp-leases")
  }

  private ownerPath(runId: string): string {
    return path.join(this.leasesDir(), `${runId}.owner.json`)
  }

  private recoveryClaimPath(runId: string): string {
    return path.join(this.leasesDir(), `${runId}.recovery-${randomUUID()}.json`)
  }

  private recoveryGatePath(runId: string): string {
    return path.join(this.leasesDir(), `${runId}.reconcile.json`)
  }
}

interface LeaseInspection {
  record: McpRunLeaseRecord | undefined
  modifiedAt: number
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`invalid MCP run id: ${runId}`)
}

function isLeaseRecord(value: unknown): value is McpRunLeaseRecord {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<McpRunLeaseRecord>
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.ownerId === "string" &&
    candidate.ownerId.length > 0 &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid! > 0 &&
    Number.isFinite(candidate.acquiredAt)
  )
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // Permission denied is intentionally fail-closed: a process we cannot
    // inspect may still own an external host effect, so recovery must not
    // terminate its checkpoint.
    return !isNoSuchProcess(err)
  }
}

function isAlreadyExists(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "EEXIST")
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}

function isNoSuchProcess(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ESRCH")
}

function runIdFromLeaseName(name: string): string | undefined {
  const suffixes = [".owner.json", ".reconcile.json"]
  for (const suffix of suffixes) {
    if (name.endsWith(suffix)) {
      const runId = name.slice(0, -suffix.length)
      return SAFE_RUN_ID.test(runId) ? runId : undefined
    }
  }
  const recoveryAt = name.indexOf(".recovery-")
  if (recoveryAt < 1 || !name.endsWith(".json")) return undefined
  const runId = name.slice(0, recoveryAt)
  return SAFE_RUN_ID.test(runId) ? runId : undefined
}

function tempName(record: McpRunLeaseRecord): string {
  return `.tmp-${record.pid}-${record.acquiredAt}-${record.ownerId}`
}

function tempIdentityFromName(name: string): { pid: number; acquiredAt: number } | undefined {
  const match = /^\.tmp-(\d+)-(\d+)-.+$/.exec(name)
  if (!match) return undefined
  const pid = Number(match[1])
  const acquiredAt = Number(match[2])
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(acquiredAt)) return undefined
  return { pid, acquiredAt }
}

/** A reader may hold a Windows handle on the old claim at the exact instant
 * recovery replaces its metadata. Keep the original atomic-json-store retry
 * behavior locally, while retaining a lease-recognizable temporary name. */
async function renameWithRetry(tempPath: string, destination: string): Promise<void> {
  const maxAttempts = 8
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tempPath, destination)
      return
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientFileOperationError(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, attempt * 10))
    }
  }
}

function isTransientFileOperationError(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined
  return code === "EPERM" || code === "EBUSY"
}

function sameLeaseOwner(left: LeaseInspection, right: LeaseInspection): boolean {
  return (
    left.record?.ownerId === right.record?.ownerId &&
    left.record?.pid === right.record?.pid &&
    left.record?.acquiredAt === right.record?.acquiredAt
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
