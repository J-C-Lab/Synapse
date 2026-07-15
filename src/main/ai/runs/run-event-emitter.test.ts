import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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

    // Simulates a fresh process resuming the run — a new emitter instance,
    // seeded from the same durable journal.
    const resumed = await createRunEventEmitter(
      store,
      { runId: "run-2", rootRunId: "run-2" },
      () => 2000
    )
    await resumed.emit({ type: "run_started", origin: "interactive" })

    const events = await store.readAll("run-2")
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3])
  })
})
