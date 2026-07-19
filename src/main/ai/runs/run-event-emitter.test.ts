import type { AgentRunEvent } from "@synapse/agent-protocol"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRunEventEmitter } from "./run-event-emitter"
import { RunEventStore } from "./run-event-store"

let dir: string
let store: RunEventStore

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-run-event-emitter-"))
  store = new RunEventStore(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("createRunEventEmitter", () => {
  it("fills in the envelope and assigns strictly-increasing sequence numbers", async () => {
    const emitter = await createRunEventEmitter(
      store,
      { runId: "run-1", rootRunId: "run-1" },
      () => 1000,
      () => "event-id"
    )

    await emitter.emit({ type: "run_started", origin: "interactive" })
    await emitter.emit({
      type: "model_completed",
      step: 0,
      assistantMessageId: "m1",
      inputTokens: 10,
      outputTokens: 5,
    })

    const events = await store.readAll("run-1")
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      schemaVersion: 1,
      eventId: "event-id",
      runId: "run-1",
      rootRunId: "run-1",
      sequence: 1,
      timestamp: 1000,
      persisted: true,
      type: "run_started",
      origin: "interactive",
    })
    expect(events[1]?.sequence).toBe(2)
  })

  it("threads parentRunId/conversationId through every emitted event", async () => {
    const emitter = await createRunEventEmitter(
      store,
      { runId: "child-1", rootRunId: "root-1", parentRunId: "root-1", conversationId: "conv-1" },
      () => 1000
    )
    await emitter.emit({ type: "run_started", origin: "subagent" })
    const [event] = await store.readAll("child-1")
    expect(event).toMatchObject({
      parentRunId: "root-1",
      conversationId: "conv-1",
    })
  })

  it("resumes the sequence from the journal's last durable event rather than restarting at zero", async () => {
    const first = await createRunEventEmitter(
      store,
      { runId: "run-2", rootRunId: "run-2" },
      () => 1000
    )
    await first.emit({ type: "run_started", origin: "interactive" })
    await first.emit({ type: "run_completed", outcome: "completed" })

    const resumed = await createRunEventEmitter(
      store,
      { runId: "run-2", rootRunId: "run-2" },
      () => 2000
    )
    await resumed.emit({ type: "run_started", origin: "interactive" })

    const events = await store.readAll("run-2")
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3])
  })

  it("re-syncs when an asynchronous child-task projection appends between driver events", async () => {
    const emitter = await createRunEventEmitter(
      store,
      { runId: "run-child", rootRunId: "run-child", conversationId: "conv-1" },
      () => 1000
    )
    await emitter.emit({ type: "run_started", origin: "interactive" })
    await store.append("run-child", {
      schemaVersion: 1,
      eventId: "child-event",
      runId: "run-child",
      rootRunId: "run-child",
      conversationId: "conv-1",
      sequence: 2,
      timestamp: 1001,
      persisted: true,
      type: "child_task_updated",
      child: { childRunId: "child-1", status: "running", label: "Research" },
    })

    await emitter.emit({ type: "run_completed", outcome: "completed" })
    expect((await store.readAll("run-child")).map((event) => event.sequence)).toEqual([1, 2, 3])
  })

  it("persists every concurrent child-task update emitted by short-lived emitters", async () => {
    const emitters = await Promise.all(
      Array.from({ length: 20 }, () =>
        createRunEventEmitter(
          store,
          { runId: "parent-run", rootRunId: "parent-run", conversationId: "conv-1" },
          () => 1000
        )
      )
    )

    await Promise.all(
      emitters.map((emitter, index) =>
        emitter.emit({
          type: "child_task_updated",
          child: { childRunId: `child-${index}`, status: "running", label: `Task ${index}` },
        })
      )
    )

    const events = await store.readAll("parent-run")
    expect(events).toHaveLength(20)
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1)
    )
  })

  it("does not let a projection append failure stop the driver, and reuses the sequence", async () => {
    const append = vi
      .fn<(runId: string, event: AgentRunEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(undefined)
    const onEvent = vi.fn()
    const emitter = await createRunEventEmitter(
      { readAll: async () => [], append },
      { runId: "run-3", rootRunId: "run-3" },
      () => 10,
      () => "event-id",
      onEvent
    )

    await expect(emitter.emit({ type: "text_delta", text: "first" })).resolves.toBeUndefined()
    await expect(emitter.emit({ type: "text_delta", text: "second" })).resolves.toBeUndefined()

    expect(append.mock.calls.map(([, event]) => event.sequence)).toEqual([1, 1])
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ text: "second", sequence: 1 }))
  })

  it("starts the driver when the prior observational journal cannot be read", async () => {
    const append = vi
      .fn<(runId: string, event: AgentRunEvent) => Promise<void>>()
      .mockResolvedValue(undefined)
    const emitter = await createRunEventEmitter(
      { readAll: async () => Promise.reject(new Error("corrupt journal")), append },
      { runId: "run-4", rootRunId: "run-4" },
      () => 10,
      () => "event-id"
    )

    await expect(
      emitter.emit({ type: "run_started", origin: "interactive" })
    ).resolves.toBeUndefined()
    expect(append).toHaveBeenCalledWith("run-4", expect.objectContaining({ sequence: 1 }))
  })
})
