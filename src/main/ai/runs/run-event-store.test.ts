import type { AgentRunEvent } from "@synapse/agent-protocol"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RunEventStore } from "./run-event-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-run-event-store-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function event(sequence: number, overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return {
    schemaVersion: 1,
    eventId: `evt-${sequence}`,
    runId: "run-1",
    rootRunId: "run-1",
    sequence,
    timestamp: sequence,
    persisted: true,
    type: "checkpoint_committed",
    revision: sequence,
    ...overrides,
  } as AgentRunEvent
}

describe("runEventStore — append and read", () => {
  it("returns no events for a run that has never appended anything", async () => {
    const store = new RunEventStore(dir)
    expect(await store.readAll("run-1")).toEqual([])
  })

  it("appends events and reads them back in order", async () => {
    const store = new RunEventStore(dir)
    await store.append("run-1", event(1))
    await store.append("run-1", event(2))
    const events = await store.readAll("run-1")
    expect(events.map((e) => e.sequence)).toEqual([1, 2])
  })

  it("rejects an event whose sequence does not strictly increase", async () => {
    const store = new RunEventStore(dir)
    await store.append("run-1", event(1))
    await expect(store.append("run-1", event(1))).rejects.toThrow(/strictly increase/)
    await expect(store.append("run-1", event(0))).rejects.toThrow(/strictly increase/)
  })

  it("keeps separate runs independent", async () => {
    const store = new RunEventStore(dir)
    await store.append("run-1", event(1))
    await store.append("run-2", event(1, { runId: "run-2", rootRunId: "run-2" }))
    expect(await store.readAll("run-1")).toHaveLength(1)
    expect(await store.readAll("run-2")).toHaveLength(1)
  })

  it("readAfter returns only events past the given sequence", async () => {
    const store = new RunEventStore(dir)
    await store.append("run-1", event(1))
    await store.append("run-1", event(2))
    await store.append("run-1", event(3))
    expect((await store.readAfter("run-1", 1)).map((e) => e.sequence)).toEqual([2, 3])
    expect(await store.readAfter("run-1", 3)).toEqual([])
  })
})

describe("runEventStore — truncation tolerance", () => {
  it("tolerates a missing/truncated final line without losing earlier events", async () => {
    const store = new RunEventStore(dir)
    await store.append("run-1", event(1))
    await store.append("run-1", event(2))
    const filePath = join(dir, "run-1", "events.jsonl")
    // Simulate a crash mid-write: append a partial, unterminated JSON line.
    await fs.appendFile(
      filePath,
      '{"schemaVersion":1,"eventId":"evt-3","sequence":3,"trunc',
      "utf-8"
    )

    const events = await store.readAll("run-1")
    expect(events.map((e) => e.sequence)).toEqual([1, 2])
  })

  it("throws on a corrupt line that is not the final one", async () => {
    const store = new RunEventStore(dir)
    await store.append("run-1", event(1))
    const filePath = join(dir, "run-1", "events.jsonl")
    await fs.appendFile(filePath, "not json at all\n", "utf-8")
    await store.append("run-1", event(2))

    await expect(store.readAll("run-1")).rejects.toThrow(/corrupt/)
  })
})

describe("runEventStore — concurrent appends", () => {
  it("serializes concurrent appends so every sequence is accepted exactly once", async () => {
    const store = new RunEventStore(dir)
    await store.append("run-1", event(1))
    await Promise.all([store.append("run-1", event(2)), store.append("run-1", event(3))])
    const events = await store.readAll("run-1")
    expect(events.map((e) => e.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })
})
