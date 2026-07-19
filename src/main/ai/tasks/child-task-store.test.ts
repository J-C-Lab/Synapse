import type { ChildTaskRecord } from "./child-task-types"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ChildTaskCorruptionError,
  ChildTaskNotFoundError,
  ChildTaskStore,
  IllegalChildTaskStatusTransitionError,
  ImmutableChildTaskFieldError,
  StaleChildTaskRevisionError,
} from "./child-task-store"

let dir: string
let store: ChildTaskStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-child-task-store-"))
  store = new ChildTaskStore(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function record(overrides: Partial<ChildTaskRecord> = {}): ChildTaskRecord {
  return {
    schemaVersion: 1,
    revision: 0,
    taskId: "task-1",
    conversationId: "c1",
    originRunId: "origin-1",
    rootRunId: "origin-1",
    currentRunId: "child-1",
    name: "count files",
    description: "count the files in the workspace",
    status: "queued",
    budgetAccountId: "child-1",
    allocationOperationId: "reserve-subagent:child-1",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe("childTaskStore.create/get", () => {
  it("persists a task and reads it back with revision 1", async () => {
    const created = await store.create(record())
    expect(created.revision).toBe(1)
    const loaded = await store.get("task-1")
    expect(loaded).toEqual(created)
  })

  it("rejects creating the same taskId twice", async () => {
    await store.create(record())
    await expect(store.create(record())).rejects.toThrow(/already exists/)
  })

  it("throws ChildTaskNotFoundError for an unknown task", async () => {
    await expect(store.get("nope")).rejects.toBeInstanceOf(ChildTaskNotFoundError)
  })

  it("throws ChildTaskCorruptionError for malformed on-disk JSON", async () => {
    await fs.mkdir(join(dir, "task-1"), { recursive: true })
    await fs.writeFile(join(dir, "task-1", "task.json"), "{not json", "utf-8")
    await expect(store.get("task-1")).rejects.toBeInstanceOf(ChildTaskCorruptionError)
  })

  it("rejects an unsafe taskId before ever touching the filesystem", async () => {
    await expect(store.get("../escape")).rejects.toThrow(/invalid child task id/)
  })
})

describe("childTaskStore.mutate", () => {
  it("advances status through a legal transition and bumps revision", async () => {
    const created = await store.create(record())
    const running = await store.mutate(created.taskId, created.revision, (r) => ({
      ...r,
      status: "running",
      updatedAt: 2000,
    }))
    expect(running.status).toBe("running")
    expect(running.revision).toBe(2)
  })

  it("rejects a stale revision (CAS)", async () => {
    const created = await store.create(record())
    await expect(
      store.mutate(created.taskId, created.revision + 1, (r) => ({ ...r, status: "running" }))
    ).rejects.toBeInstanceOf(StaleChildTaskRevisionError)
  })

  it("rejects an illegal status transition (e.g. queued -> succeeded, skipping running)", async () => {
    const created = await store.create(record())
    await expect(
      store.mutate(created.taskId, created.revision, (r) => ({ ...r, status: "succeeded" }))
    ).rejects.toBeInstanceOf(IllegalChildTaskStatusTransitionError)
  })

  it("rejects any transition out of a terminal status", async () => {
    const created = await store.create(record())
    const running = await store.mutate(created.taskId, created.revision, (r) => ({
      ...r,
      status: "running",
    }))
    const cancelled = await store.mutate(running.taskId, running.revision, (r) => ({
      ...r,
      status: "cancelled",
    }))
    await expect(
      store.mutate(cancelled.taskId, cancelled.revision, (r) => ({ ...r, status: "running" }))
    ).rejects.toBeInstanceOf(IllegalChildTaskStatusTransitionError)
  })

  it("rejects a mutator that changes an immutable identity field", async () => {
    const created = await store.create(record())
    await expect(
      store.mutate(created.taskId, created.revision, (r) => ({
        ...r,
        conversationId: "some-other-conversation",
      }))
    ).rejects.toBeInstanceOf(ImmutableChildTaskFieldError)
  })

  it("serializes concurrent mutate() calls against the same task", async () => {
    const created = await store.create(record())
    const results = await Promise.allSettled([
      store.mutate(created.taskId, created.revision, (r) => ({ ...r, status: "running" })),
      store.mutate(created.taskId, created.revision, (r) => ({ ...r, status: "cancelled" })),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    // Both callers read revision 1; exactly one write wins and the other
    // sees a stale-revision CAS conflict — never a silently lost update.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })
})

describe("childTaskStore query surface", () => {
  it("lists tasks for a conversation, excluding other conversations", async () => {
    await store.create(record({ taskId: "t1", conversationId: "c1" }))
    await store.create(record({ taskId: "t2", conversationId: "c1", currentRunId: "child-2" }))
    await store.create(record({ taskId: "t3", conversationId: "c2", currentRunId: "child-3" }))
    const forC1 = await store.listForConversation("c1")
    expect(forC1.map((r) => r.taskId).sort()).toEqual(["t1", "t2"])
  })

  it("finds a task by its one child run id", async () => {
    await store.create(record({ taskId: "t1", currentRunId: "child-1" }))
    await store.create(record({ taskId: "t2", currentRunId: "child-2" }))
    const found = await store.findByRunId("child-2")
    expect(found?.taskId).toBe("t2")
    expect(await store.findByRunId("child-missing")).toBeUndefined()
  })

  it("scan() filters by status", async () => {
    const t1 = await store.create(record({ taskId: "t1" }))
    await store.mutate(t1.taskId, t1.revision, (r) => ({ ...r, status: "running" }))
    await store.create(record({ taskId: "t2", currentRunId: "child-2" }))
    const queued = await store.scan({ status: ["queued"] })
    expect(queued.map((r) => r.taskId)).toEqual(["t2"])
    const running = await store.scan({ status: ["running"] })
    expect(running.map((r) => r.taskId)).toEqual(["t1"])
  })

  it("scan() returns an empty list when the store directory does not exist yet", async () => {
    const empty = new ChildTaskStore(join(dir, "never-created"))
    expect(await empty.scan()).toEqual([])
  })
})
