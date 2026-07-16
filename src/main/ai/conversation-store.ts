import type { CanonicalJson } from "./runs/canonical-json"
import type { DurableChatMessage } from "./runs/durable-messages"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"
import { canonicalHash } from "./runs/canonical-json"
import { deriveArtifactUris, toChatMessages, toDurableMessages } from "./runs/durable-messages"

// Conversation persistence as plain JSON, one file per conversation (decision
// §11.1 — no native deps), on the V2 durable schema (design §"Migrate
// conversations to V2 CAS, leases, and tombstones"). Every mutation goes
// through `withLock`, a per-conversation promise-chain mutex: the existing
// atomic-json-store helper only serializes the physical write, not the
// read-validate-write sequence a lease/CAS operation needs.
//
// `get`/`save`/`delete`/`list` are the pre-existing compatibility projection
// — every current caller (AgentService et al.) keeps working unchanged.
// `acquireRunLease`/`renewRunLease`/`commitRun`/`releaseRunLease`/`tombstone`
// are the new durable-run API; nothing calls them yet (that lands with the
// interactive-chat migration).

const DEFAULT_LEASE_MS = 30_000

export interface StoredConversation {
  id: string
  title?: string
  workspaceId: string
  messages: import("./providers/types").ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
  title?: string
  workspaceId: string
  updatedAt: number
}

export interface ConversationActiveRun {
  runId: string
  fencingToken: number
  baseContentRevision: number
  leaseExpiresAt: number
  finalizationId?: string
  committedContentRevision?: number
  /** Canonical hash of the last messages payload committed under
   *  `finalizationId` — lets a retry be recognized as identical vs. corrupt. */
  committedMessagesHash?: string
}

export interface ConversationRecordV2 {
  schemaVersion: 2
  id: string
  state: "active" | "deleted"
  recordRevision: number
  contentRevision: number
  deletionEpoch: number
  /** Monotonically increasing across the conversation's whole lifetime —
   *  survives lease release, unlike `activeRun.fencingToken`. */
  lastFencingToken: number
  activeRun?: ConversationActiveRun
  messages: DurableChatMessage[]
  /** Host-derived from `messages` in the same atomic write — never a
   *  best-effort side index. */
  artifactUris: string[]
  deletedAt?: number
  title?: string
  workspaceId: string
  createdAt: number
  updatedAt: number
}

export class ConversationNotFoundError extends Error {
  constructor(id: string) {
    super(`Conversation not found: ${id}`)
    this.name = "ConversationNotFoundError"
  }
}

/** A tombstone is permanent for an id. Callers must choose a new id instead
 * of silently turning a deleted conversation back into an active record. */
export class ConversationTombstonedError extends Error {
  constructor(id: string) {
    super(`Conversation is tombstoned: ${id}`)
    this.name = "ConversationTombstonedError"
  }
}

export type ConversationLeaseConflictReason =
  | "conversation-tombstoned"
  | "stale-content-revision"
  | "lease-already-held"
  | "stale-fencing-token"
  | "commit-preconditions-not-met"
  | "release-preconditions-not-met"
  | "no-active-run"

export class ConversationLeaseConflictError extends Error {
  constructor(public readonly reason: ConversationLeaseConflictReason) {
    super(`conversation lease conflict: ${reason}`)
    this.name = "ConversationLeaseConflictError"
  }
}

export class ConversationCommitCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConversationCommitCorruptionError"
  }
}

export class ConversationStore {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  // --- legacy-compatible projection -----------------------------------

  async get(id: string): Promise<StoredConversation | undefined> {
    const record = await this.withLock(id, () => this.readForMutation(id))
    if (!record || record.state !== "active") return undefined
    return toStoredConversation(record)
  }

  /** Create or replace a conversation, stamping `updatedAt`. Bypasses the
   *  lease/CAS system entirely — the pre-existing whole-history write path
   *  every current caller still uses. */
  async save(conversation: StoredConversation): Promise<StoredConversation> {
    return this.withLock(conversation.id, async () => {
      const now = this.now()
      const existing = await this.readForMutation(conversation.id)
      if (existing?.state === "deleted") throw new ConversationTombstonedError(conversation.id)
      const previousMessages = existing?.messages ?? []
      const messages = toDurableMessages(previousMessages, conversation.messages)
      const base: ConversationRecordV2 =
        existing ?? emptyRecord(conversation.id, conversation.workspaceId, conversation.createdAt)

      const next: ConversationRecordV2 = {
        ...base,
        state: "active",
        title: conversation.title,
        workspaceId: conversation.workspaceId,
        messages,
        artifactUris: deriveArtifactUris(messages),
        contentRevision: base.contentRevision + (messages.length > previousMessages.length ? 1 : 0),
        recordRevision: base.recordRevision + 1,
        updatedAt: now,
      }
      await this.writeRecord(next)
      return toStoredConversation(next)
    })
  }

  async delete(id: string): Promise<void> {
    await this.withLock(id, async () => {
      const now = this.now()
      const record = await this.readForMutation(id)
      if (!record || record.state !== "active") return
      await this.writeRecord(tombstoneOf(record, now))
    })
  }

  /** All active conversations as summaries, newest first. */
  async list(): Promise<ConversationSummary[]> {
    let files: string[]
    try {
      files = await fs.readdir(this.dir)
    } catch (err) {
      if (isFileNotFound(err)) return []
      throw err
    }

    const summaries: ConversationSummary[] = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const id = file.slice(0, -".json".length)
      if (!isSafeId(id)) continue
      const record = await this.withLock(id, () => this.readForMutation(id))
      if (record && record.state === "active") {
        summaries.push({
          id: record.id,
          title: record.title,
          workspaceId: record.workspaceId,
          updatedAt: record.updatedAt,
        })
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // --- durable run lease / commit / tombstone API ----------------------

  async acquireRunLease(
    conversationId: string,
    expectedContentRevision: number,
    runId: string
  ): Promise<{ fencingToken: number; deletionEpoch: number }> {
    return this.withLock(conversationId, async () => {
      const now = this.now()
      const record = await this.readForMutation(conversationId)
      if (!record) throw new ConversationNotFoundError(conversationId)
      if (record.state !== "active") {
        throw new ConversationLeaseConflictError("conversation-tombstoned")
      }
      if (record.contentRevision !== expectedContentRevision) {
        throw new ConversationLeaseConflictError("stale-content-revision")
      }
      if (record.activeRun && record.activeRun.leaseExpiresAt > now) {
        throw new ConversationLeaseConflictError("lease-already-held")
      }
      const fencingToken = record.lastFencingToken + 1
      const next: ConversationRecordV2 = {
        ...record,
        lastFencingToken: fencingToken,
        activeRun: {
          runId,
          fencingToken,
          baseContentRevision: expectedContentRevision,
          leaseExpiresAt: now + DEFAULT_LEASE_MS,
        },
        recordRevision: record.recordRevision + 1,
        updatedAt: now,
      }
      await this.writeRecord(next)
      return { fencingToken, deletionEpoch: record.deletionEpoch }
    })
  }

  /**
   * Reads the conversation's current content revision and acquires a lease
   * against it in one atomic step under this conversation's lock — the
   * `expectedContentRevision` CAS parameter on {@link acquireRunLease} means
   * a caller who doesn't already hold that revision (every new interactive
   * turn) would otherwise have to read it first via a separate call, racing
   * any writer that lands between the read and the acquire.
   *
   * `titleIfUnset`, when given, is written in this same atomic step — but
   * only if the record's title is not already set. A title is derived once
   * from a conversation's first message and never changes after that, so
   * this is the only write path that ever needs to set it; `commitRun`
   * deliberately never touches title.
   */
  async acquireRunLeaseAtCurrentRevision(
    conversationId: string,
    runId: string,
    titleIfUnset?: string
  ): Promise<{
    fencingToken: number
    deletionEpoch: number
    baseContentRevision: number
    messages: DurableChatMessage[]
  }> {
    return this.withLock(conversationId, async () => {
      const now = this.now()
      const record = await this.readForMutation(conversationId)
      if (!record) throw new ConversationNotFoundError(conversationId)
      if (record.state !== "active") {
        throw new ConversationLeaseConflictError("conversation-tombstoned")
      }
      if (record.activeRun && record.activeRun.leaseExpiresAt > now) {
        throw new ConversationLeaseConflictError("lease-already-held")
      }
      const fencingToken = record.lastFencingToken + 1
      const baseContentRevision = record.contentRevision
      const next: ConversationRecordV2 = {
        ...record,
        title: record.title ?? titleIfUnset,
        lastFencingToken: fencingToken,
        activeRun: {
          runId,
          fencingToken,
          baseContentRevision,
          leaseExpiresAt: now + DEFAULT_LEASE_MS,
        },
        recordRevision: record.recordRevision + 1,
        updatedAt: now,
      }
      await this.writeRecord(next)
      return {
        fencingToken,
        deletionEpoch: record.deletionEpoch,
        baseContentRevision,
        messages: record.messages,
      }
    })
  }

  async renewRunLease(conversationId: string, runId: string, fencingToken: number): Promise<void> {
    await this.withLock(conversationId, async () => {
      const now = this.now()
      const record = await this.readForMutation(conversationId)
      if (!record) throw new ConversationNotFoundError(conversationId)
      if (!activeRunMatches(record, runId, fencingToken)) {
        throw new ConversationLeaseConflictError("stale-fencing-token")
      }
      const next: ConversationRecordV2 = {
        ...record,
        activeRun: { ...record.activeRun!, leaseExpiresAt: now + DEFAULT_LEASE_MS },
        recordRevision: record.recordRevision + 1,
        updatedAt: now,
      }
      await this.writeRecord(next)
    })
  }

  async commitRun(input: {
    conversationId: string
    runId: string
    fencingToken: number
    baseContentRevision: number
    deletionEpoch: number
    finalizationId: string
    messages: DurableChatMessage[]
  }): Promise<{ contentRevision: number }> {
    return this.withLock(input.conversationId, async () => {
      const now = this.now()
      const record = await this.readForMutation(input.conversationId)
      if (!record) throw new ConversationNotFoundError(input.conversationId)

      const payloadHash = canonicalHash(input.messages as unknown as CanonicalJson)

      if (
        record.activeRun?.runId === input.runId &&
        record.activeRun.fencingToken === input.fencingToken &&
        record.activeRun.finalizationId === input.finalizationId &&
        record.activeRun.committedContentRevision !== undefined
      ) {
        if (record.activeRun.committedMessagesHash === payloadHash) {
          return { contentRevision: record.activeRun.committedContentRevision }
        }
        throw new ConversationCommitCorruptionError(
          `commitRun retry for finalizationId ${input.finalizationId} sent a different payload`
        )
      }

      if (
        record.state !== "active" ||
        record.deletionEpoch !== input.deletionEpoch ||
        !activeRunMatches(record, input.runId, input.fencingToken) ||
        record.contentRevision !== input.baseContentRevision
      ) {
        throw new ConversationLeaseConflictError("commit-preconditions-not-met")
      }

      const contentRevision = record.contentRevision + 1
      const next: ConversationRecordV2 = {
        ...record,
        contentRevision,
        messages: input.messages,
        artifactUris: deriveArtifactUris(input.messages),
        recordRevision: record.recordRevision + 1,
        activeRun: {
          ...record.activeRun!,
          finalizationId: input.finalizationId,
          committedContentRevision: contentRevision,
          committedMessagesHash: payloadHash,
        },
        updatedAt: now,
      }
      await this.writeRecord(next)
      return { contentRevision }
    })
  }

  async releaseRunLease(input: {
    conversationId: string
    runId: string
    fencingToken: number
    finalizationId: string
    committedContentRevision: number
  }): Promise<{ recordRevision: number }> {
    return this.withLock(input.conversationId, async () => {
      const now = this.now()
      const record = await this.readForMutation(input.conversationId)
      if (!record) throw new ConversationNotFoundError(input.conversationId)

      if (!record.activeRun) {
        if (input.fencingToken <= record.lastFencingToken) {
          return { recordRevision: record.recordRevision }
        }
        throw new ConversationLeaseConflictError("no-active-run")
      }

      if (
        record.activeRun.runId !== input.runId ||
        record.activeRun.fencingToken !== input.fencingToken ||
        record.activeRun.finalizationId !== input.finalizationId ||
        record.activeRun.committedContentRevision !== input.committedContentRevision
      ) {
        throw new ConversationLeaseConflictError("release-preconditions-not-met")
      }

      const next: ConversationRecordV2 = {
        ...record,
        activeRun: undefined,
        recordRevision: record.recordRevision + 1,
        updatedAt: now,
      }
      await this.writeRecord(next)
      return { recordRevision: next.recordRevision }
    })
  }

  /** CAS-guarded tombstone for durable callers that hold an expected
   *  content revision. `delete()` above is the unconditional legacy path. */
  async tombstone(conversationId: string, expectedContentRevision: number): Promise<void> {
    await this.withLock(conversationId, async () => {
      const now = this.now()
      const record = await this.readForMutation(conversationId)
      if (!record) throw new ConversationNotFoundError(conversationId)
      if (record.contentRevision !== expectedContentRevision) {
        throw new ConversationLeaseConflictError("stale-content-revision")
      }
      await this.writeRecord(tombstoneOf(record, now))
    })
  }

  // --- internals --------------------------------------------------------

  /** Reads the current record, migrating a legacy v1 record to V2 and
   *  persisting that migration immediately so message ids stabilize. Callers
   *  must already hold this conversation's lock (see `withLock`). */
  private async readForMutation(id: string): Promise<ConversationRecordV2 | undefined> {
    const raw = await readJsonFile(this.filePath(id))
    if (raw === null) return undefined
    const v2 = tryParseV2(raw)
    if (v2) return v2
    const legacy = tryParseLegacy(raw)
    if (!legacy) return undefined
    const migrated = migrateLegacyRecord(legacy)
    await this.writeRecord(migrated)
    return migrated
  }

  private async writeRecord(record: ConversationRecordV2): Promise<void> {
    await writeJsonFile(this.filePath(record.id), record)
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${safeId(id)}.json`)
  }

  /** Per-conversation promise-chain mutex serializing every mutation
   *  (including the migrate-then-read path) so a lease/CAS decision is
   *  never made against a value another in-flight call is about to replace. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const key = safeId(id)
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }
}

function activeRunMatches(
  record: ConversationRecordV2,
  runId: string,
  fencingToken: number
): boolean {
  return (
    record.activeRun !== undefined &&
    record.activeRun.runId === runId &&
    record.activeRun.fencingToken === fencingToken
  )
}

function tombstoneOf(record: ConversationRecordV2, now: number): ConversationRecordV2 {
  return {
    ...record,
    state: "deleted",
    deletionEpoch: record.deletionEpoch + 1,
    activeRun: undefined,
    deletedAt: now,
    recordRevision: record.recordRevision + 1,
    updatedAt: now,
  }
}

function emptyRecord(id: string, workspaceId: string, createdAt: number): ConversationRecordV2 {
  return {
    schemaVersion: 2,
    id,
    state: "active",
    recordRevision: 0,
    contentRevision: 0,
    deletionEpoch: 0,
    lastFencingToken: 0,
    activeRun: undefined,
    messages: [],
    artifactUris: [],
    title: undefined,
    workspaceId,
    createdAt,
    updatedAt: createdAt,
  }
}

function toStoredConversation(record: ConversationRecordV2): StoredConversation {
  return {
    id: record.id,
    title: record.title,
    workspaceId: record.workspaceId,
    messages: toChatMessages(record.messages),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function tryParseV2(value: unknown): ConversationRecordV2 | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== 2) return undefined
  if (typeof v.id !== "string" || !Array.isArray(v.messages)) return undefined
  return {
    schemaVersion: 2,
    id: v.id,
    state: v.state === "deleted" ? "deleted" : "active",
    recordRevision: typeof v.recordRevision === "number" ? v.recordRevision : 0,
    contentRevision: typeof v.contentRevision === "number" ? v.contentRevision : 0,
    deletionEpoch: typeof v.deletionEpoch === "number" ? v.deletionEpoch : 0,
    lastFencingToken: typeof v.lastFencingToken === "number" ? v.lastFencingToken : 0,
    activeRun: isRecord(v.activeRun)
      ? (v.activeRun as unknown as ConversationActiveRun)
      : undefined,
    messages: v.messages as DurableChatMessage[],
    artifactUris: Array.isArray(v.artifactUris) ? (v.artifactUris as string[]) : [],
    deletedAt: typeof v.deletedAt === "number" ? v.deletedAt : undefined,
    title: typeof v.title === "string" ? v.title : undefined,
    workspaceId:
      typeof v.workspaceId === "string" && v.workspaceId.trim() ? v.workspaceId : "default",
    createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
  }
}

function tryParseLegacy(value: unknown): StoredConversation | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (v.schemaVersion === 2) return undefined
  if (typeof v.id !== "string" || !Array.isArray(v.messages)) return undefined
  return {
    id: v.id,
    title: typeof v.title === "string" ? v.title : undefined,
    workspaceId:
      typeof v.workspaceId === "string" && v.workspaceId.trim() ? v.workspaceId : "default",
    messages: v.messages as StoredConversation["messages"],
    createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
  }
}

function migrateLegacyRecord(legacy: StoredConversation): ConversationRecordV2 {
  const messages = toDurableMessages([], legacy.messages)
  return {
    schemaVersion: 2,
    id: legacy.id,
    state: "active",
    recordRevision: 1,
    contentRevision: messages.length > 0 ? 1 : 0,
    deletionEpoch: 0,
    lastFencingToken: 0,
    activeRun: undefined,
    messages,
    artifactUris: deriveArtifactUris(messages),
    title: legacy.title,
    workspaceId: legacy.workspaceId,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeId(id: string): boolean {
  return /^[\w-]{1,128}$/.test(id)
}

function safeId(id: string): string {
  if (!isSafeId(id)) {
    throw new Error(`Invalid conversation id: ${id}`)
  }
  return id
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
