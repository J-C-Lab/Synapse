import { promises as fs, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ConversationCommitCorruptionError,
  ConversationLeaseConflictError,
  ConversationNotFoundError,
  ConversationStore,
  ConversationTombstonedError,
} from "./conversation-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-ai-conv-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function store(now = () => 1000): ConversationStore {
  return new ConversationStore(dir, now)
}

async function seededDefault(s: ConversationStore, id: string): Promise<void> {
  await s.save({ id, workspaceId: "default", messages: [], createdAt: 1, updatedAt: 1 })
}

describe("conversationStore — legacy-compatible projection", () => {
  it("saves and reads back a conversation", async () => {
    const s = store()
    await s.save({
      id: "abc",
      title: "Test",
      workspaceId: "default",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      createdAt: 1,
      updatedAt: 1,
    })
    const loaded = await s.get("abc")
    expect(loaded?.title).toBe("Test")
    expect(loaded?.updatedAt).toBe(1000) // stamped on save
    expect(loaded?.messages[0]?.content[0]).toMatchObject({ type: "text", text: "hi" })
  })

  it("lists summaries newest-first and deletes", async () => {
    let clock = 0
    const s = new ConversationStore(dir, () => ++clock)
    await s.save({ id: "old", workspaceId: "default", messages: [], createdAt: 0, updatedAt: 0 })
    await s.save({ id: "new", workspaceId: "default", messages: [], createdAt: 0, updatedAt: 0 })

    const summaries = await s.list()
    expect(summaries.map((entry) => entry.id)).toEqual(["new", "old"])

    await s.delete("old")
    expect((await s.list()).map((entry) => entry.id)).toEqual(["new"])
  })

  it("returns undefined for a missing conversation and empty list for no dir", async () => {
    expect(await store().get("missing")).toBeUndefined()
    const fresh = new ConversationStore(join(dir, "does-not-exist"))
    expect(await fresh.list()).toEqual([])
  })

  it("rejects unsafe conversation ids", async () => {
    await expect(store().get("../escape")).rejects.toThrow(/Invalid conversation id/)
  })

  it("defaults a missing workspaceId to 'default' on read", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "conv-ws-"))
    writeFileSync(
      join(legacyDir, "c1.json"),
      JSON.stringify({ id: "c1", messages: [], createdAt: 1, updatedAt: 1 })
    )
    const legacyStore = new ConversationStore(legacyDir)
    expect((await legacyStore.get("c1"))?.workspaceId).toBe("default")
  })

  it("round-trips an explicit workspaceId", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "conv-ws2-"))
    const wsStore = new ConversationStore(wsDir)
    await wsStore.save({
      id: "c2",
      workspaceId: "work",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })
    expect((await wsStore.get("c2"))?.workspaceId).toBe("work")
  })

  it("includes workspaceId in list summaries", async () => {
    const s = store()
    await s.save({ id: "c3", workspaceId: "work", messages: [], createdAt: 1, updatedAt: 1 })
    expect((await s.list())[0]).toMatchObject({ id: "c3", workspaceId: "work" })
  })

  it("does not resurrect a deleted conversation via get/list", async () => {
    const s = store()
    await s.save({ id: "gone", workspaceId: "default", messages: [], createdAt: 1, updatedAt: 1 })
    await s.delete("gone")
    expect(await s.get("gone")).toBeUndefined()
    expect(await s.list()).toEqual([])
  })

  it("never resurrects a tombstone through the legacy save path", async () => {
    const s = store()
    await s.save({ id: "gone", workspaceId: "default", messages: [], createdAt: 1, updatedAt: 1 })
    await s.delete("gone")

    await expect(
      s.save({ id: "gone", workspaceId: "default", messages: [], createdAt: 2, updatedAt: 2 })
    ).rejects.toThrow(ConversationTombstonedError)
    expect(await s.get("gone")).toBeUndefined()
  })
})

describe("conversationStore — lazy legacy migration", () => {
  it("keeps legacy readers read-only, then atomically writes stable V2 message ids on the first mutation", async () => {
    writeFileSync(
      join(dir, "legacy1.json"),
      JSON.stringify({
        id: "legacy1",
        workspaceId: "default",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        createdAt: 1,
        updatedAt: 1,
      })
    )
    const s = store()
    const first = await s.get("legacy1")
    expect(first?.messages).toHaveLength(1)

    const raw = JSON.parse(await fs.readFile(join(dir, "legacy1.json"), "utf-8"))
    expect(raw.schemaVersion).toBeUndefined()

    await s.acquireRunLeaseAtCurrentRevision("legacy1", "run-1")
    const migrated = JSON.parse(await fs.readFile(join(dir, "legacy1.json"), "utf-8"))
    expect(migrated.schemaVersion).toBe(2)
    const firstMessageId = migrated.messages[0].messageId
    expect(typeof firstMessageId).toBe("string")

    // Reading again (including from a fresh store instance) must not
    // regenerate the id once the mutation has committed the V2 record.
    await s.get("legacy1")
    await new ConversationStore(dir).get("legacy1")
    const rawAgain = JSON.parse(await fs.readFile(join(dir, "legacy1.json"), "utf-8"))
    expect(rawAgain.messages[0].messageId).toBe(firstMessageId)
  })
})

describe("conversationStore — durable lease/commit/tombstone", () => {
  async function seeded(s: ConversationStore, id = "c1"): Promise<void> {
    await s.save({ id, workspaceId: "default", messages: [], createdAt: 1, updatedAt: 1 })
  }

  it("acquires a lease at content revision 0 for a freshly created conversation", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken, deletionEpoch } = await s.acquireRunLease("c1", 0, "run-1")
    expect(fencingToken).toBe(1)
    expect(deletionEpoch).toBe(0)
  })

  describe("acquireRunLeaseAtCurrentRevision", () => {
    it("reads the current content revision and acquires a lease against it atomically", async () => {
      const s = store()
      await seeded(s)
      const result = await s.acquireRunLeaseAtCurrentRevision("c1", "run-1")
      expect(result.baseContentRevision).toBe(0)
      expect(result.fencingToken).toBe(1)
      expect(result.deletionEpoch).toBe(0)
      expect(result.messages).toEqual([])

      // The lease is genuinely held — a second acquire attempt conflicts.
      await expect(s.acquireRunLease("c1", 0, "run-2")).rejects.toThrow(
        ConversationLeaseConflictError
      )
    })

    it("picks up the conversation's current messages and revision, not a stale one", async () => {
      const s = store()
      await s.save({
        id: "c1",
        workspaceId: "default",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        createdAt: 1,
        updatedAt: 1,
      })
      const result = await s.acquireRunLeaseAtCurrentRevision("c1", "run-1")
      expect(result.baseContentRevision).toBe(1)
      expect(result.messages).toHaveLength(1)
    })

    it("throws ConversationNotFoundError for a missing conversation", async () => {
      const s = store()
      await expect(s.acquireRunLeaseAtCurrentRevision("nope", "run-1")).rejects.toThrow(
        ConversationNotFoundError
      )
    })

    it("sets the title in the same atomic write when currently unset", async () => {
      const s = store()
      await seeded(s)
      await s.acquireRunLeaseAtCurrentRevision("c1", "run-1", "My new title")
      const record = await s.get("c1")
      expect(record?.title).toBe("My new title")
    })

    it("never overwrites a title that's already set", async () => {
      const s = store()
      await s.save({
        id: "c1",
        title: "Existing title",
        workspaceId: "default",
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })
      await s.acquireRunLeaseAtCurrentRevision("c1", "run-1", "Would-be new title")
      const record = await s.get("c1")
      expect(record?.title).toBe("Existing title")
    })

    it("leaves title unset when titleIfUnset is omitted", async () => {
      const s = store()
      await seeded(s)
      await s.acquireRunLeaseAtCurrentRevision("c1", "run-1")
      const record = await s.get("c1")
      expect(record?.title).toBeUndefined()
    })

    it("throws ConversationLeaseConflictError for a conversation with a live lease already held", async () => {
      const s = store()
      await seeded(s)
      await s.acquireRunLease("c1", 0, "run-1")
      await expect(s.acquireRunLeaseAtCurrentRevision("c1", "run-2")).rejects.toThrow(
        ConversationLeaseConflictError
      )
    })
  })

  it("rejects a second simultaneous lease attempt while the first is still live", async () => {
    const s = store()
    await seeded(s)
    await s.acquireRunLease("c1", 0, "run-1")
    await expect(s.acquireRunLease("c1", 0, "run-2")).rejects.toThrow(
      ConversationLeaseConflictError
    )
  })

  it("under two genuinely concurrent lease attempts, exactly one wins", async () => {
    const s = store()
    await seeded(s)
    const results = await Promise.allSettled([
      s.acquireRunLease("c1", 0, "run-a"),
      s.acquireRunLease("c1", 0, "run-b"),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConversationLeaseConflictError
    )
  })

  it("renews a lease without advancing content revision", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    await s.renewRunLease("c1", "run-1", fencingToken)
    const record = await s.get("c1")
    expect(record?.messages).toEqual([]) // content untouched
    // A second acquire attempt still conflicts — the lease is alive, not cleared.
    await expect(s.acquireRunLease("c1", 0, "run-2")).rejects.toThrow(
      ConversationLeaseConflictError
    )
  })

  it("rejects renewal under a stale fencing token", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    await expect(s.renewRunLease("c1", "run-1", fencingToken + 1)).rejects.toThrow(
      ConversationLeaseConflictError
    )
  })

  it("commits messages and advances content revision, then blocks a stale second commit", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    const durable = [
      {
        messageId: "m1",
        message: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      },
    ]

    const { contentRevision } = await s.commitRun({
      conversationId: "c1",
      runId: "run-1",
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
      messages: durable,
    })
    expect(contentRevision).toBe(1)

    // A concurrent/late commit against the now-stale baseContentRevision=0 must fail.
    await expect(
      s.commitRun({
        conversationId: "c1",
        runId: "run-1",
        fencingToken,
        baseContentRevision: 0,
        deletionEpoch: 0,
        finalizationId: "fin-2",
        messages: durable,
      })
    ).rejects.toThrow(ConversationLeaseConflictError)
  })

  it("makes commitRun idempotent for a retry with the same finalizationId and identical payload", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    const durable = [
      {
        messageId: "m1",
        message: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      },
    ]
    const input = {
      conversationId: "c1",
      runId: "run-1",
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
      messages: durable,
    }
    const first = await s.commitRun(input)
    const retry = await s.commitRun(input)
    expect(retry.contentRevision).toBe(first.contentRevision)
  })

  it("treats a retry under the same finalizationId with a different payload as corruption", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    const base = {
      conversationId: "c1",
      runId: "run-1",
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
    }
    await s.commitRun({
      ...base,
      messages: [
        {
          messageId: "m1",
          message: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        },
      ],
    })
    await expect(
      s.commitRun({
        ...base,
        messages: [
          {
            messageId: "m1",
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: "DIFFERENT" }],
            },
          },
        ],
      })
    ).rejects.toThrow(ConversationCommitCorruptionError)
  })

  it("releases a lease idempotently and rejects release under mismatched preconditions", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    const durable = [
      {
        messageId: "m1",
        message: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      },
    ]
    const { contentRevision } = await s.commitRun({
      conversationId: "c1",
      runId: "run-1",
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
      messages: durable,
    })

    const releaseInput = {
      conversationId: "c1",
      runId: "run-1",
      fencingToken,
      finalizationId: "fin-1",
      committedContentRevision: contentRevision,
    }
    const first = await s.releaseRunLease(releaseInput)
    // Idempotent retry after the lease is already cleared.
    const retry = await s.releaseRunLease(releaseInput)
    expect(retry.recordRevision).toBe(first.recordRevision)

    // A new lease can now be acquired — the prior one was actually released.
    await expect(s.acquireRunLease("c1", contentRevision, "run-2")).resolves.toMatchObject({})
  })

  it("rejects release under a mismatched fencing token", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    await expect(
      s.releaseRunLease({
        conversationId: "c1",
        runId: "run-1",
        fencingToken: fencingToken + 1,
        finalizationId: "fin-1",
        committedContentRevision: 0,
      })
    ).rejects.toThrow(ConversationLeaseConflictError)
  })

  it("tombstones under a matching content revision and blocks a stale tombstone", async () => {
    const s = store()
    await seeded(s)
    await expect(s.tombstone("c1", 1)).rejects.toThrow(ConversationLeaseConflictError)
    await s.tombstone("c1", 0)
    expect(await s.get("c1")).toBeUndefined()
  })

  it("clears an active lease and blocks a bound run's commit when the conversation is deleted mid-run", async () => {
    const s = store()
    await seeded(s)
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    await s.delete("c1")

    await expect(
      s.commitRun({
        conversationId: "c1",
        runId: "run-1",
        fencingToken,
        baseContentRevision: 0,
        deletionEpoch: 0,
        finalizationId: "fin-1",
        messages: [],
      })
    ).rejects.toThrow(ConversationLeaseConflictError)
  })

  it("throws ConversationNotFoundError for lease operations on a missing conversation", async () => {
    const s = store()
    await expect(s.acquireRunLease("nope", 0, "run-1")).rejects.toThrow(ConversationNotFoundError)
  })
})

describe("conversationStore — artifactUris derivation (Task 21)", () => {
  it("derives artifactUris from tool_result.artifact fields in the same commit", async () => {
    const s = store()
    await seededDefault(s, "c1")
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    const durable = [
      {
        messageId: "m1",
        message: {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId: "t1",
              content: "preview",
              artifact: { uri: "artifact://run/run-1/a1" } as never,
            },
          ],
        },
      },
    ]
    await s.commitRun({
      conversationId: "c1",
      runId: "run-1",
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
      messages: durable,
    })
    const raw = JSON.parse(await fs.readFile(join(dir, "c1.json"), "utf-8"))
    expect(raw.artifactUris).toEqual(["artifact://run/run-1/a1"])
    expect(raw.additionalArtifactUris).toEqual([])
    expect(raw.artifactIndexIntegrityHash).toMatch(/^[a-f0-9]{64}$/)
    expect(raw.artifactIndexVersion).toBe(1)
  })

  it("merges additionalArtifactUris (superseded compaction artifacts) into artifactUris", async () => {
    const s = store()
    await seededDefault(s, "c1")
    const { fencingToken } = await s.acquireRunLease("c1", 0, "run-1")
    await s.commitRun({
      conversationId: "c1",
      runId: "run-1",
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
      messages: [
        {
          messageId: "m1",
          message: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        },
      ],
      additionalArtifactUris: ["artifact://run/run-1/history-2", "artifact://run/run-1/history-1"],
    })
    const raw = JSON.parse(await fs.readFile(join(dir, "c1.json"), "utf-8"))
    expect(raw.artifactUris).toEqual([
      "artifact://run/run-1/history-1",
      "artifact://run/run-1/history-2",
    ])
    expect(raw.additionalArtifactUris).toEqual([
      "artifact://run/run-1/history-1",
      "artifact://run/run-1/history-2",
    ])
  })

  it("upgrades only a record that explicitly predates the artifact index fields", async () => {
    const s = store()
    await seededDefault(s, "legacy-index")
    const path = join(dir, "legacy-index.json")
    const raw = JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>
    delete raw.artifactIndexVersion
    delete raw.additionalArtifactUris
    delete raw.artifactIndexIntegrityHash
    await fs.writeFile(path, JSON.stringify(raw))

    await expect(s.get("legacy-index")).resolves.toMatchObject({ id: "legacy-index" })
    const upgraded = JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>
    expect(upgraded.artifactIndexVersion).toBe(1)
    expect(upgraded.artifactIndexIntegrityHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("does not rewrite a current record whose present artifact index is corrupt", async () => {
    const s = store()
    await seededDefault(s, "corrupt-index")
    const { fencingToken } = await s.acquireRunLease("corrupt-index", 0, "run-1")
    await s.commitRun({
      conversationId: "corrupt-index",
      runId: "run-1",
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
      messages: [],
    })
    const path = join(dir, "corrupt-index.json")
    const tampered = JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>
    tampered.artifactIndexIntegrityHash = "0".repeat(64)
    const serialized = JSON.stringify(tampered)
    await fs.writeFile(path, serialized)

    await expect(s.get("corrupt-index")).rejects.toThrow(/incomplete artifact reference index/)
    expect(await fs.readFile(path, "utf-8")).toBe(serialized)
  })
})

describe("conversationStore.collectReferencedArtifactUris (Task 21)", () => {
  async function commitWithArtifact(
    s: ConversationStore,
    conversationId: string,
    runId: string,
    uri: string
  ): Promise<void> {
    await seededDefault(s, conversationId)
    const { fencingToken } = await s.acquireRunLease(conversationId, 0, runId)
    await s.commitRun({
      conversationId,
      runId,
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
      messages: [
        {
          messageId: "m1",
          message: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        },
      ],
      additionalArtifactUris: [uri],
    })
  }

  it("includes an active conversation's artifactUris", async () => {
    const s = store()
    await commitWithArtifact(s, "active-conv", "run-1", "artifact://run/run-1/a1")
    const referenced = await s.collectReferencedArtifactUris(1000, 60_000)
    expect(referenced.has("artifact://run/run-1/a1")).toBe(true)
  })

  it("includes a tombstoned conversation's artifactUris while inside the grace window", async () => {
    let clock = 1000
    const s = new ConversationStore(dir, () => clock)
    await commitWithArtifact(s, "grace-conv", "run-1", "artifact://run/run-1/a1")
    clock = 2000
    await s.tombstone("grace-conv", 1)

    const referenced = await s.collectReferencedArtifactUris(2500, 60_000)
    expect(referenced.has("artifact://run/run-1/a1")).toBe(true)
  })

  it("excludes a tombstoned conversation's artifactUris once past the grace window", async () => {
    let clock = 1000
    const s = new ConversationStore(dir, () => clock)
    await commitWithArtifact(s, "expired-conv", "run-1", "artifact://run/run-1/a1")
    clock = 2000
    await s.tombstone("expired-conv", 1)

    const referenced = await s.collectReferencedArtifactUris(2000 + 60_000, 60_000)
    expect(referenced.has("artifact://run/run-1/a1")).toBe(false)
  })

  it("returns an empty set when the conversations directory does not exist", async () => {
    const fresh = new ConversationStore(join(dir, "does-not-exist"))
    expect(await fresh.collectReferencedArtifactUris(1000, 60_000)).toEqual(new Set())
  })

  it("fails closed when any canonical conversation is malformed", async () => {
    const s = store()
    await commitWithArtifact(s, "good-conv", "run-1", "artifact://run/run-1/a1")
    await fs.writeFile(join(dir, "damaged-conv.json"), "{ not valid json")
    await expect(s.collectReferencedArtifactUris(1000, 60_000)).rejects.toThrow(/malformed/)
  })

  it("fails closed when a legal JSON record drops a message-derived artifact from its index", async () => {
    const s = store()
    await seededDefault(s, "indexed-conv")
    const { fencingToken } = await s.acquireRunLease("indexed-conv", 0, "run-1")
    await s.commitRun({
      conversationId: "indexed-conv",
      runId: "run-1",
      fencingToken,
      baseContentRevision: 0,
      deletionEpoch: 0,
      finalizationId: "fin-1",
      messages: [
        {
          messageId: "m1",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "t1",
                content: "preview",
                artifact: { uri: "artifact://run/run-1/a1" } as never,
              },
            ],
          },
        },
      ],
    })
    const path = join(dir, "indexed-conv.json")
    const tampered = JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>
    tampered.artifactUris = []
    await fs.writeFile(path, JSON.stringify(tampered))

    await expect(s.collectReferencedArtifactUris(1000, 60_000)).rejects.toThrow(
      /incomplete artifact reference index/
    )
  })

  it("fails closed when an additional history URI or its integrity hash is altered", async () => {
    const s = store()
    await commitWithArtifact(s, "history-index", "run-1", "artifact://run/run-1/history-1")
    const path = join(dir, "history-index.json")
    const tampered = JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>
    tampered.additionalArtifactUris = []
    await fs.writeFile(path, JSON.stringify(tampered))

    await expect(s.collectReferencedArtifactUris(1000, 60_000)).rejects.toThrow(
      /incomplete artifact reference index/
    )
  })
})
