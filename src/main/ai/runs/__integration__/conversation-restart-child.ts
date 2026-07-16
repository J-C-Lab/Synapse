import { promises as fs } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import {
  ConversationLeaseConflictError,
  ConversationStore,
  ConversationTombstonedError,
} from "../../conversation-store"

type Scenario = "tombstone" | "content-conflict" | "stale-fencing"
type Phase = "seed" | "assert"

const [baseDir, scenario, phase] = process.argv.slice(2) as [string, Scenario, Phase]

if (!baseDir || !scenario || !phase) {
  throw new Error("usage: conversation-restart-child <baseDir> <scenario> <seed|assert>")
}

async function saveBase(store: ConversationStore): Promise<void> {
  await store.save({
    id: "c1",
    workspaceId: "ws-1",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  })
}

async function main(): Promise<void> {
  const now = scenario === "stale-fencing" && phase === "assert" ? () => 31_000 : () => 0
  const store = new ConversationStore(path.join(baseDir, "conversations"), now)

  if (phase === "seed") {
    await saveBase(store)
    if (scenario === "tombstone") {
      await store.tombstone("c1", 0)
    } else if (scenario === "content-conflict") {
      const lease = await store.acquireRunLease("c1", 0, "run-1")
      if (lease.fencingToken !== 1) throw new Error("unexpected initial fencing token")
      await store.save({
        id: "c1",
        workspaceId: "ws-1",
        messages: [{ role: "user", content: [{ type: "text", text: "concurrent edit" }] }],
        createdAt: 0,
        updatedAt: 0,
      })
    } else {
      await store.acquireRunLease("c1", 0, "run-1")
    }
    // A hard process exit models the post-commit process death boundary;
    // the assertion below runs in a brand-new Node process with no locks or
    // in-memory store state carried over.
    process.exit(91)
  }

  if (scenario === "tombstone") {
    await expectRejects(
      () =>
        store.save({
          id: "c1",
          workspaceId: "ws-1",
          messages: [],
          createdAt: 0,
          updatedAt: 0,
        }),
      ConversationTombstonedError
    )
  } else if (scenario === "content-conflict") {
    await expectRejects(
      () =>
        store.commitRun({
          conversationId: "c1",
          runId: "run-1",
          fencingToken: 1,
          baseContentRevision: 0,
          deletionEpoch: 0,
          finalizationId: "finish-1",
          messages: [],
        }),
      ConversationLeaseConflictError
    )
  } else {
    const replacement = await store.acquireRunLease("c1", 0, "run-2")
    if (replacement.fencingToken !== 2) throw new Error("expired lease did not advance fence")
    await expectRejects(() => store.renewRunLease("c1", "run-1", 1), ConversationLeaseConflictError)
  }
  await fs.writeFile(path.join(baseDir, `${scenario}.result.json`), JSON.stringify({ ok: true }))
}

async function expectRejects(
  operation: () => Promise<unknown>,
  expected: new (...args: never[]) => Error
): Promise<void> {
  try {
    await operation()
  } catch (err) {
    if (err instanceof expected) return
    throw err
  }
  throw new Error(`expected ${expected.name}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
