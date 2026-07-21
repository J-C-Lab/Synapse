import type { RunTrace } from "./run-trace-store"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  getLatestPlan,
  getRunTrace,
  listRuns,
  runTraceDir,
  TraceUpsertCorruptionError,
  upsertRunTrace,
} from "./run-trace-store"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "run-trace-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function trace(overrides: Partial<RunTrace> = {}) {
  return {
    runId: "run-1",
    conversationId: "c1",
    origin: "interactive" as const,
    startedAt: 1000,
    endedAt: 2000,
    outcome: "end_turn" as const,
    toolCalls: [{ name: "com.x/greet", startedAt: 1100, ms: 40, ok: true }],
    ...overrides,
  }
}

/** Test-only writer for historic plain files. Production writes exclusively
 * through upsertRunTrace; this helper exists to exercise the reader's
 * backwards compatibility boundary. */
function upsertFixtureTrace(targetDir: string, value: RunTrace): void {
  upsertRunTrace(targetDir, {
    runId: value.runId,
    finalizationId: `fixture-${value.runId}`,
    traceHash: `fixture-hash-${value.runId}`,
    trace: value,
  })
}

describe("runTraceStore", () => {
  it("reads a historic plain trace by runId without rewriting it", () => {
    writeFileSync(path.join(dir, "run-1.json"), JSON.stringify(trace()))
    expect(getRunTrace(dir, "run-1")).toEqual(trace())
  })

  it("returns undefined for an unknown runId", () => {
    expect(getRunTrace(dir, "missing")).toBeUndefined()
  })

  it("lists runs newest-first and filters by conversationId", () => {
    upsertFixtureTrace(dir, trace({ runId: "a", conversationId: "c1", startedAt: 100 }))
    upsertFixtureTrace(dir, trace({ runId: "b", conversationId: "c2", startedAt: 200 }))
    upsertFixtureTrace(dir, trace({ runId: "c", conversationId: "c1", startedAt: 300 }))

    const all = listRuns(dir)
    expect(all.map((t) => t.runId)).toEqual(["c", "b", "a"])

    const c1 = listRuns(dir, { conversationId: "c1" })
    expect(c1.map((t) => t.runId)).toEqual(["c", "a"])
  })

  it("respects the limit option", () => {
    for (let i = 0; i < 5; i++) upsertFixtureTrace(dir, trace({ runId: `r${i}`, startedAt: i }))
    expect(listRuns(dir, { limit: 2 })).toHaveLength(2)
  })

  it("prunes oldest files once MAX_RUN_FILES is exceeded", () => {
    for (let i = 0; i < 502; i++) {
      upsertFixtureTrace(dir, trace({ runId: `r${String(i).padStart(4, "0")}`, startedAt: i }))
    }
    expect(getRunTrace(dir, "r0000")).toBeUndefined()
    expect(getRunTrace(dir, "r0001")).toBeUndefined()
    expect(getRunTrace(dir, "r0002")).toBeDefined()
    expect(listRuns(dir)).toHaveLength(500)
  })

  it("creates the trace directory for a durable upsert", () => {
    expect(() => upsertFixtureTrace(path.join(dir, "nested", "deep"), trace())).not.toThrow()
  })

  it("refuses a runId containing path separators (no escape from dir)", () => {
    expect(() => upsertFixtureTrace(dir, trace({ runId: "../escape" }))).toThrow()
    expect(getRunTrace(dir, "../escape")).toBeUndefined()
    expect(existsSync(path.join(dir, "..", "escape.json"))).toBe(false)
  })

  it("refuses a runId with a slash or backslash", () => {
    expect(() => upsertFixtureTrace(dir, trace({ runId: "a/b" }))).toThrow()
    expect(() => upsertFixtureTrace(dir, trace({ runId: "a\\b" }))).toThrow()
    expect(listRuns(dir)).toHaveLength(0)
  })

  it("round-trips a trace that carries a plan", () => {
    const withPlan = trace({
      runId: "rp",
      plan: [
        { title: "A", status: "completed" },
        { title: "B", status: "pending" },
      ],
    })
    upsertFixtureTrace(dir, withPlan)
    expect(getRunTrace(dir, "rp")?.plan).toEqual(withPlan.plan)
  })

  it("round-trips a trace with principal, workspaceId, and mcp origin", () => {
    const parityDir = mkdtempSync(path.join(tmpdir(), "run-trace-parity-"))
    const trace: RunTrace = {
      runId: "run-ext-1",
      origin: "mcp",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-external",
      startedAt: 1,
      endedAt: 2,
      outcome: "end_turn",
      toolCalls: [],
    }
    upsertFixtureTrace(parityDir, trace)
    expect(getRunTrace(parityDir, "run-ext-1")).toEqual(trace)
    rmSync(parityDir, { recursive: true, force: true })
  })

  it("filters listRuns by parentRunId", () => {
    upsertFixtureTrace(dir, trace({ runId: "p", startedAt: 1 }))
    upsertFixtureTrace(
      dir,
      trace({ runId: "c1", parentRunId: "p", startedAt: 2, origin: "subagent" })
    )
    upsertFixtureTrace(
      dir,
      trace({ runId: "c2", parentRunId: "p", startedAt: 3, origin: "subagent" })
    )
    upsertFixtureTrace(
      dir,
      trace({ runId: "other", parentRunId: "q", startedAt: 4, origin: "subagent" })
    )

    const children = listRuns(dir, { parentRunId: "p" })
    expect(children.map((t) => t.runId).sort()).toEqual(["c1", "c2"])
  })

  describe("getLatestPlan", () => {
    it("returns the newest run's plan for the conversation", () => {
      upsertFixtureTrace(
        dir,
        trace({
          runId: "older",
          startedAt: 1,
          plan: [{ title: "old step", status: "completed" }],
        })
      )
      upsertFixtureTrace(
        dir,
        trace({
          runId: "newer",
          startedAt: 2,
          plan: [
            { title: "step 1", status: "completed" },
            { title: "step 2", status: "in_progress" },
          ],
        })
      )
      expect(getLatestPlan(dir, "c1")).toEqual([
        { title: "step 1", status: "completed" },
        { title: "step 2", status: "in_progress" },
      ])
    })

    it("skips runs with no plan or an empty plan to find the latest real one", () => {
      upsertFixtureTrace(
        dir,
        trace({ runId: "has-plan", startedAt: 1, plan: [{ title: "a", status: "pending" }] })
      )
      upsertFixtureTrace(dir, trace({ runId: "no-plan", startedAt: 2 }))
      upsertFixtureTrace(dir, trace({ runId: "empty-plan", startedAt: 3, plan: [] }))
      expect(getLatestPlan(dir, "c1")).toEqual([{ title: "a", status: "pending" }])
    })

    it("returns undefined when the conversation has no run with a plan", () => {
      upsertFixtureTrace(dir, trace({ runId: "no-plan" }))
      expect(getLatestPlan(dir, "c1")).toBeUndefined()
    })

    it("returns undefined for a conversation with no runs at all", () => {
      expect(getLatestPlan(dir, "unknown-conversation")).toBeUndefined()
    })

    it("does not leak another conversation's plan", () => {
      upsertFixtureTrace(
        dir,
        trace({
          runId: "other-convo",
          conversationId: "c2",
          startedAt: 5,
          plan: [{ title: "not mine", status: "completed" }],
        })
      )
      expect(getLatestPlan(dir, "c1")).toBeUndefined()
    })
  })

  describe("runTraceDir", () => {
    it("joins userDataDir/logs/runs", () => {
      expect(runTraceDir("/tmp/synapse-data")).toBe(path.join("/tmp/synapse-data", "logs", "runs"))
    })
  })

  describe("listRuns — extended filters", () => {
    it("filters by origin", () => {
      upsertFixtureTrace(dir, trace({ runId: "a", origin: "interactive" }))
      upsertFixtureTrace(dir, trace({ runId: "b", origin: "mcp" }))
      expect(listRuns(dir, { origin: "mcp" }).map((t) => t.runId)).toEqual(["b"])
    })

    it("filters by outcome", () => {
      upsertFixtureTrace(dir, trace({ runId: "a", outcome: "end_turn" }))
      upsertFixtureTrace(dir, trace({ runId: "b", outcome: "error" }))
      expect(listRuns(dir, { outcome: "error" }).map((t) => t.runId)).toEqual(["b"])
    })

    it("filters by workspaceId", () => {
      upsertFixtureTrace(dir, trace({ runId: "a", workspaceId: "ws-1" }))
      upsertFixtureTrace(dir, trace({ runId: "b", workspaceId: "ws-2" }))
      expect(listRuns(dir, { workspaceId: "ws-2" }).map((t) => t.runId)).toEqual(["b"])
    })

    it("filters by triggerInstanceId", () => {
      upsertFixtureTrace(dir, trace({ runId: "a", triggerInstanceId: "inst-1" }))
      upsertFixtureTrace(dir, trace({ runId: "b", triggerInstanceId: "inst-2" }))
      expect(listRuns(dir, { triggerInstanceId: "inst-2" }).map((t) => t.runId)).toEqual(["b"])
    })

    it("combines a new filter with the existing conversationId filter", () => {
      upsertFixtureTrace(dir, trace({ runId: "a", conversationId: "c1", origin: "interactive" }))
      upsertFixtureTrace(dir, trace({ runId: "b", conversationId: "c1", origin: "subagent" }))
      expect(
        listRuns(dir, { conversationId: "c1", origin: "subagent" }).map((t) => t.runId)
      ).toEqual(["b"])
    })

    it("a filter matching nothing returns an empty array, not undefined", () => {
      upsertFixtureTrace(dir, trace({ runId: "a", origin: "interactive" }))
      expect(listRuns(dir, { origin: "mcp" })).toEqual([])
    })
  })

  describe("upsertRunTrace", () => {
    it("writes a new trace and returns revision 1", () => {
      const receipt = upsertRunTrace(dir, {
        runId: "run-1",
        finalizationId: "fin-1",
        traceHash: "hash-1",
        trace: trace(),
      })
      expect(receipt).toEqual({ revision: 1 })
      expect(getRunTrace(dir, "run-1")).toEqual(trace())
    })

    it("an identical retry (same finalizationId + hash) returns the same revision without rewriting", () => {
      upsertRunTrace(dir, {
        runId: "run-1",
        finalizationId: "fin-1",
        traceHash: "hash-1",
        trace: trace(),
      })
      const receipt = upsertRunTrace(dir, {
        runId: "run-1",
        finalizationId: "fin-1",
        traceHash: "hash-1",
        trace: trace(),
      })
      expect(receipt).toEqual({ revision: 1 })
    })

    it("the same finalizationId with a different hash is a typed corruption error", () => {
      upsertRunTrace(dir, {
        runId: "run-1",
        finalizationId: "fin-1",
        traceHash: "hash-1",
        trace: trace(),
      })
      expect(() =>
        upsertRunTrace(dir, {
          runId: "run-1",
          finalizationId: "fin-1",
          traceHash: "hash-2",
          trace: trace({ outcome: "error" }),
        })
      ).toThrow(TraceUpsertCorruptionError)
    })

    it("a different finalizationId is a fresh upsert, bumping the revision", () => {
      upsertRunTrace(dir, {
        runId: "run-1",
        finalizationId: "fin-1",
        traceHash: "hash-1",
        trace: trace(),
      })
      const receipt = upsertRunTrace(dir, {
        runId: "run-1",
        finalizationId: "fin-2",
        traceHash: "hash-2",
        trace: trace({ outcome: "error" }),
      })
      expect(receipt).toEqual({ revision: 2 })
      expect(getRunTrace(dir, "run-1")?.outcome).toBe("error")
    })

    it("is visible through getRunTrace and listRuns like a upsertFixtureTrace trace", () => {
      upsertRunTrace(dir, {
        runId: "run-1",
        finalizationId: "fin-1",
        traceHash: "hash-1",
        trace: trace(),
      })
      expect(getRunTrace(dir, "run-1")).toEqual(trace())
      expect(listRuns(dir).map((t) => t.runId)).toEqual(["run-1"])
    })

    it("stores an on-disk envelope distinct from the plain upsertFixtureTrace format", () => {
      upsertRunTrace(dir, {
        runId: "run-1",
        finalizationId: "fin-1",
        traceHash: "hash-1",
        trace: trace(),
      })
      const raw = JSON.parse(readFileSync(path.join(dir, "run-1.json"), "utf8"))
      expect(raw).toMatchObject({
        envelopeVersion: 1,
        finalizationId: "fin-1",
        traceHash: "hash-1",
      })
    })
  })

  describe("legacy trace compatibility", () => {
    it("reads a pre-S04 trace missing principal/workspaceId without crashing", () => {
      const legacy = {
        runId: "legacy-1",
        origin: "interactive",
        startedAt: 1000,
        endedAt: 2000,
        outcome: "end_turn",
        toolCalls: [],
        // no principal, no workspaceId — a record written before this spec's invariants existed
      }
      writeFileSync(path.join(dir, "legacy-1.json"), JSON.stringify(legacy))
      expect(getRunTrace(dir, "legacy-1")).toEqual(legacy)
    })

    it("reads a pre-S04 background-agent trace missing triggerInstanceId without crashing", () => {
      const legacy = {
        runId: "legacy-2",
        origin: "background-agent",
        startedAt: 1000,
        endedAt: 2000,
        outcome: "end_turn",
        toolCalls: [],
        // no triggerInstanceId, no workspaceId — RunProvenance would require both for a
        // NEW background-agent run, but this file predates that invariant
      }
      writeFileSync(path.join(dir, "legacy-2.json"), JSON.stringify(legacy))
      const all = listRuns(dir)
      expect(all.find((t) => t.runId === "legacy-2")).toEqual(legacy)
    })
  })
})
