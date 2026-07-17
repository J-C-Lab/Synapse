import type { AgentArtifactRef, ArtifactTombstone } from "./artifact-types"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"

// Retention/pin/tombstone bookkeeping for the artifact store (Task 21,
// design §"Retention"). Kept independently testable from artifact-store.ts's
// filesystem-heavy capture/read paths, mirroring how tool-result-capture.ts
// and history-artifact.ts stayed small pure(-ish) modules alongside it.
//
// Three responsibilities:
//  1. ArtifactPinStore — durable "has this run's pin been released" ledger.
//     A run absent from the ledger is treated as still pinned (never yet
//     released) — safe-by-default: an artifact is only ever GC-eligible once
//     its owning run has *affirmatively* released its pin in finalization.
//  2. ArtifactTombstoneStore — durable record of what retention deleted, so
//     a later stat/read/resolve against those bytes gets a stable
//     `artifact_expired` diagnosis (with the tombstone attached) instead of
//     an ambiguous `artifact_missing`. Retained for at least
//     MIN_TOMBSTONE_RETENTION_MS (design: "at least 30 days").
//  3. selectEligibleForDeletion — the pure decision: an artifact is only
//     ever GC-eligible when its run's pin has been released AND it is not
//     referenced by any active/grace-period conversation. Non-terminal run
//     artifacts (pin never released) and referenced artifacts are never
//     deleted, regardless of quota pressure — quota pressure instead denies
//     new capture (artifact-quota.ts's existing ArtifactQuotaExceededError),
//     never breaks existing history.

const PIN_LEDGER_FILE = "run-pins.json"
const TOMBSTONE_LEDGER_FILE = "tombstones.json"

/** Design §"Retention": "retain ... for at least 30 days so a stale
 *  UI/event/reference receives a stable diagnosis rather than ambiguous
 *  'not found.'" */
export const MIN_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// ArtifactPinStore — durable run-pin-release ledger

export interface ArtifactRunPinLedgerV1 {
  schemaVersion: 1
  releasedRuns: Record<string, { finalizationId: string; releasedAt: number }>
}

function emptyPinLedger(): ArtifactRunPinLedgerV1 {
  return { schemaVersion: 1, releasedRuns: {} }
}

function isValidPinLedger(v: unknown): v is ArtifactRunPinLedgerV1 {
  if (!v || typeof v !== "object") return false
  const record = v as Record<string, unknown>
  if (record.schemaVersion !== 1) return false
  if (!record.releasedRuns || typeof record.releasedRuns !== "object") return false
  return true
}

/**
 * Tracks which runs have released their artifact pin (design: "Non-terminal
 * run artifacts are pinned against deletion... Terminal finalization may
 * release the run pin only after conversation commit"). A runId never
 * recorded here is treated as still pinned — retention never deletes a run's
 * artifacts until this store affirmatively says the run finalized.
 */
export class ArtifactPinStore {
  private lock: Promise<void> = Promise.resolve()

  constructor(private readonly baseDir: string) {}

  /** Idempotent: releasing an already-released run's pin again (a
   *  finalization retry after a crash) is a safe no-op that keeps the first
   *  recorded release. */
  async release(runId: string, finalizationId: string, now: number): Promise<void> {
    await this.withLock(async () => {
      const ledger = await this.load()
      if (ledger.releasedRuns[runId]) return
      ledger.releasedRuns[runId] = { finalizationId, releasedAt: now }
      await this.save(ledger)
    })
  }

  /** True when `runId` has never released its pin (including a runId this
   *  store has never heard of at all) — the safe default. */
  async isPinned(runId: string): Promise<boolean> {
    const ledger = await this.load()
    return !ledger.releasedRuns[runId]
  }

  private async load(): Promise<ArtifactRunPinLedgerV1> {
    const raw = await readJsonFile(this.ledgerPath())
    if (raw !== null && isValidPinLedger(raw)) return raw
    return emptyPinLedger()
  }

  private async save(ledger: ArtifactRunPinLedgerV1): Promise<void> {
    await writeJsonFile(this.ledgerPath(), ledger)
  }

  private ledgerPath(): string {
    return path.join(this.baseDir, PIN_LEDGER_FILE)
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

// ---------------------------------------------------------------------------
// ArtifactTombstoneStore — durable expired-artifact tombstone ledger

export interface ArtifactTombstoneLedgerV1 {
  schemaVersion: 1
  tombstones: Record<string, ArtifactTombstone>
}

function emptyTombstoneLedger(): ArtifactTombstoneLedgerV1 {
  return { schemaVersion: 1, tombstones: {} }
}

function isValidTombstoneLedger(v: unknown): v is ArtifactTombstoneLedgerV1 {
  if (!v || typeof v !== "object") return false
  const record = v as Record<string, unknown>
  if (record.schemaVersion !== 1) return false
  if (!record.tombstones || typeof record.tombstones !== "object") return false
  return true
}

/** Pure builder for the tombstone retention deletion writes — mirrors
 *  history-artifact.ts's buildCompactionRecord precedent (pure composition,
 *  no I/O). */
export function buildArtifactTombstone(
  ref: Pick<AgentArtifactRef, "uri" | "sha256" | "capturedBytes">,
  deletedAt: number,
  reason: string
): ArtifactTombstone {
  return { uri: ref.uri, sha256: ref.sha256, capturedBytes: ref.capturedBytes, deletedAt, reason }
}

export class ArtifactTombstoneStore {
  private lock: Promise<void> = Promise.resolve()

  constructor(private readonly baseDir: string) {}

  async record(tombstone: ArtifactTombstone): Promise<void> {
    await this.withLock(async () => {
      const ledger = await this.load()
      ledger.tombstones[tombstone.uri] = tombstone
      await this.save(ledger)
    })
  }

  async get(uri: string): Promise<ArtifactTombstone | undefined> {
    const ledger = await this.load()
    return ledger.tombstones[uri]
  }

  /** Drops tombstones older than `minRetentionMs` (default
   *  MIN_TOMBSTONE_RETENTION_MS). Safe to call on every sweep — a tombstone
   *  younger than the floor is always kept, regardless of how often this
   *  runs. */
  async pruneExpired(now: number, minRetentionMs = MIN_TOMBSTONE_RETENTION_MS): Promise<number> {
    return this.withLock(async () => {
      const ledger = await this.load()
      let removed = 0
      for (const [uri, tombstone] of Object.entries(ledger.tombstones)) {
        if (now - tombstone.deletedAt >= minRetentionMs) {
          delete ledger.tombstones[uri]
          removed += 1
        }
      }
      if (removed > 0) await this.save(ledger)
      return removed
    })
  }

  private async load(): Promise<ArtifactTombstoneLedgerV1> {
    const raw = await readJsonFile(this.ledgerPath())
    if (raw !== null && isValidTombstoneLedger(raw)) return raw
    return emptyTombstoneLedger()
  }

  private async save(ledger: ArtifactTombstoneLedgerV1): Promise<void> {
    await writeJsonFile(this.ledgerPath(), ledger)
  }

  private ledgerPath(): string {
    return path.join(this.baseDir, TOMBSTONE_LEDGER_FILE)
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

// ---------------------------------------------------------------------------
// Pure GC eligibility decision

export interface RetentionCandidate {
  runId: string
  artifactId: string
  uri: AgentArtifactRef["uri"]
}

/**
 * An artifact is eligible for deletion only when BOTH hold:
 *  - its owning run's pin has been released (`isRunPinned` false — terminal
 *    finalization already ran `releaseRunPin`);
 *  - it is not currently referenced (`isReferenced` false — no active
 *    conversation, and no tombstoned conversation still inside its grace
 *    window, pins it).
 *
 * Deliberately pure and synchronous: callers precompute both predicates as
 * plain lookups (a Set membership check, typically) so this function has no
 * I/O and is trivial to unit test against every combination.
 */
export function selectEligibleForDeletion(
  candidates: readonly RetentionCandidate[],
  isRunPinned: (runId: string) => boolean,
  isReferenced: (uri: string) => boolean
): RetentionCandidate[] {
  return candidates.filter(
    (candidate) => !isRunPinned(candidate.runId) && !isReferenced(candidate.uri)
  )
}

// ---------------------------------------------------------------------------
// Resource-release wiring shared by every run-finalizer caller

export interface ReleaseArtifactResourcesPlan {
  releaseArtifactRunPin: boolean
}

export interface ReleaseArtifactResourcesContext {
  runId: string
  finalizationId: string
}

/**
 * Shared `RunFinalizerDeps.releaseResources` body every caller (AgentService,
 * BackgroundAgentRunner, SubagentRunner, run-recovery-orchestrator,
 * AgentRunRecoveryService's abandon path) delegates to, rather than five
 * independent (and previously stubbed) copies. Only ever calls
 * `artifactStore.releaseRunPin` when the plan actually asks for it — a
 * non-terminal run's plan always has `releaseArtifactRunPin: false` and this
 * is a no-op. Deliberately does not catch a `releaseRunPin` failure: letting
 * it propagate keeps `releaseResourcesPhase` from advancing past
 * `trace_upserted`, so a crash here is resumed by a plain retry (`
 * releaseRunPin` is idempotent per finalizationId) exactly like every other
 * finalization phase.
 */
export async function releaseArtifactRunResources(
  artifactStore:
    | { releaseRunPin: (runId: string, finalizationId: string) => Promise<void> }
    | undefined,
  plan: ReleaseArtifactResourcesPlan,
  context: ReleaseArtifactResourcesContext
): Promise<{ artifactRunPinReleased: boolean }> {
  if (!plan.releaseArtifactRunPin || !artifactStore) return { artifactRunPinReleased: false }
  await artifactStore.releaseRunPin(context.runId, context.finalizationId)
  return { artifactRunPinReleased: true }
}
