import type { ToolPrincipal } from "@synapse/plugin-sdk"

// Host-only artifact vocabulary (design §"Recoverable artifact backend",
// Checkpoint B). `AgentArtifactRef` mirrors the shape frozen in the design
// doc byte-for-byte; it is never imported by @synapse/agent-protocol, which
// only ever sees the bounded `AgentArtifactRefSummary` renderer projection.
// This module is pure types/errors — no I/O, no fs, no node imports beyond
// type-only ones.

export type ArtifactTruncationReason =
  | "artifact-limit"
  | "run-limit"
  | "global-limit"
  | "disk-reserve"
  | "producer-aborted"
  | "write-error"

export type ArtifactKind =
  | "tool-result"
  | "command-stdout"
  | "command-stderr"
  | "history"
  | "media"
  | "child-result"
  | "skill-instructions"
  | "skill-asset"

export interface AgentArtifactRef {
  uri: `artifact://run/${string}/${string}`
  runId: string
  artifactId: string
  kind: ArtifactKind
  mediaType: string
  capturedBytes: number
  /** Known only when the producer reported it independently of capture. */
  sourceBytes?: number
  complete: boolean
  truncationReason?: ArtifactTruncationReason
  sha256: string
  createdAt: number
  expiresAt?: number
}

/** Builds the one URI shape every artifact ref uses. Centralized so no
 *  caller ever hand-assembles (and potentially mis-assembles) the string a
 *  forged-ref check compares against. */
export function artifactUri(runId: string, artifactId: string): AgentArtifactRef["uri"] {
  return `artifact://run/${runId}/${artifactId}`
}

/** Half-open byte range: `[start, end)`. `end` omitted means "to the end of
 *  the captured bytes". Both bounds are validated against the artifact's
 *  actual `capturedBytes` by the store, not trusted at face value. */
export interface ArtifactRange {
  start: number
  end?: number
}

/**
 * The run-tree/conversation/workspace/principal context an artifact was
 * captured under. Persisted alongside (never inside) the public
 * `AgentArtifactRef` so access checks never need a live lookup into
 * AgentRunStore — the artifact store is self-contained.
 */
export interface ArtifactOwnerContext {
  runId: string
  rootRunId: string
  parentRunId?: string
  conversationId?: string
  workspaceId?: string
  principal: ToolPrincipal
}

/**
 * Who is asking to stat/read an artifact, and from where. Compared against
 * the artifact's `ArtifactOwnerContext` by artifact-access.ts. Never
 * constructed from untrusted input — the tool-host layer (Task 19) derives
 * it from the same frozen run identity/authority every other host check uses.
 */
export interface ArtifactCaller {
  runId: string
  rootRunId: string
  parentRunId?: string
  conversationId?: string
  workspaceId?: string
  principal: ToolPrincipal
}

export type ArtifactReadErrorCode =
  | "artifact_expired"
  | "artifact_missing"
  | "artifact_corrupt"
  | "artifact_forbidden"
  | "range_invalid"

/** Retention (Task 21) owns real tombstone creation; the shape is defined
 *  now so `ArtifactReadError`'s `artifact_expired` case never needs a
 *  breaking change once retention starts populating it. */
export interface ArtifactTombstone {
  uri: AgentArtifactRef["uri"]
  sha256: string
  capturedBytes: number
  deletedAt: number
  reason: string
}

/** The closed error contract `read_artifact` (Task 19) surfaces to the
 *  model/renderer. Every rejection from `stat`/`read` is one of these. */
export class ArtifactReadError extends Error {
  constructor(
    public readonly code: ArtifactReadErrorCode,
    message: string,
    public readonly tombstone?: ArtifactTombstone
  ) {
    super(message)
    this.name = "ArtifactReadError"
  }
}

export class InvalidArtifactRunIdError extends Error {
  constructor(runId: string) {
    super(`invalid artifact run id: ${runId}`)
    this.name = "InvalidArtifactRunIdError"
  }
}

export class InvalidArtifactIdError extends Error {
  constructor(artifactId: string) {
    super(`invalid artifact id: ${artifactId}`)
    this.name = "InvalidArtifactIdError"
  }
}

/** One capacity reservation or settlement against the quota ledger
 *  (artifact-quota.ts). `grantedBytes` may be less than the per-artifact
 *  ceiling when a narrower run/global/disk constraint binds first. */
export interface ArtifactAllocationReceipt {
  operationId: string
  runId: string
  artifactId: string
  grantedBytes: number
  limitingReason?: Extract<
    ArtifactTruncationReason,
    "artifact-limit" | "run-limit" | "global-limit" | "disk-reserve"
  >
}

/** What one `collectEligible()` pass did. This task's store only reconciles
 *  abandoned reservations left over from a crash mid-capture (orphaned temp
 *  files and never-settled quota holds) — it does not implement retention
 *  deletion of otherwise-eligible artifacts, which is Task 21's job. The
 *  shape stays stable so Task 21 can add real deletion counts without a
 *  breaking change. */
export interface ArtifactGcResult {
  reconciledReservations: number
  reclaimedReservedBytes: number
  orphanedTempFilesRemoved: number
  deletedArtifacts: number
  deletedBytes: number
}

/** Metadata a producer supplies to `capture()`. `owner` is the frozen
 *  context an access check later compares a caller against. */
export interface ArtifactMetadata {
  runId: string
  owner: ArtifactOwnerContext
  kind: ArtifactKind
  mediaType: string
  /** Producer-reported total length, when known independently of capture
   *  (e.g. a `Content-Length` header). Never used in place of the actual
   *  captured/hashed byte count. */
  sourceBytes?: number
  expiresAt?: number
  /** Run ids explicitly granted read access beyond the default same-run
   *  visibility — e.g. a child sharing its result back to its parent, or a
   *  parent explicitly handing an artifact down to a child. Never inferred
   *  from `kind` or from run-tree shape alone. */
  delegateToRunIds?: readonly string[]
}

/** The producer-control bag `capture()` receives. `abort()` is the store's
 *  only way to stop a remote/plugin producer or a command's process tree —
 *  it must actually terminate the source, not merely stop draining a pipe.
 *  `signal` is an additive, optional cooperative-cancellation hook: Task
 *  18/19 can tie it to run cancellation/timeout so an external abort request
 *  produces a `"producer-aborted"` ref without the store polling anything
 *  else. Both fields are structurally compatible with a caller that only
 *  supplies `abort()`. */
export interface ArtifactProducer {
  abort: (reason: ArtifactTruncationReason) => Promise<void> | void
  signal?: AbortSignal
}

/** The narrow interface design §"Recoverable artifact backend" specifies.
 *  artifact-store.ts's class implements this exactly. */
export interface AgentArtifactStore {
  capture: (
    input: AsyncIterable<Uint8Array> | Uint8Array,
    metadata: ArtifactMetadata,
    producer: ArtifactProducer
  ) => Promise<AgentArtifactRef>
  stat: (ref: AgentArtifactRef, caller: ArtifactCaller) => Promise<AgentArtifactRef>
  read: (ref: AgentArtifactRef, range: ArtifactRange, caller: ArtifactCaller) => Promise<Uint8Array>
  releaseRunPin: (runId: string, finalizationId: string) => Promise<void>
  collectEligible: () => Promise<ArtifactGcResult>
}
