import type { RunTrace } from "./run-trace-store"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getRunTrace, listRuns, recordRun } from "./run-trace-store"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "run-trace-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function trace(overrides: Partial<Parameters<typeof recordRun>[1]> = {}) {
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

describe("runTraceStore", () => {
  it("round-trips a recorded trace by runId", () => {
    recordRun(dir, trace())
    expect(getRunTrace(dir, "run-1")).toEqual(trace())
  })

  it("returns undefined for an unknown runId", () => {
    expect(getRunTrace(dir, "missing")).toBeUndefined()
  })

  it("lists runs newest-first and filters by conversationId", () => {
    recordRun(dir, trace({ runId: "a", conversationId: "c1", startedAt: 100 }))
    recordRun(dir, trace({ runId: "b", conversationId: "c2", startedAt: 200 }))
    recordRun(dir, trace({ runId: "c", conversationId: "c1", startedAt: 300 }))

    const all = listRuns(dir)
    expect(all.map((t) => t.runId)).toEqual(["c", "b", "a"])

    const c1 = listRuns(dir, { conversationId: "c1" })
    expect(c1.map((t) => t.runId)).toEqual(["c", "a"])
  })

  it("respects the limit option", () => {
    for (let i = 0; i < 5; i++) recordRun(dir, trace({ runId: `r${i}`, startedAt: i }))
    expect(listRuns(dir, { limit: 2 })).toHaveLength(2)
  })

  it("prunes oldest files once MAX_RUN_FILES is exceeded", () => {
    for (let i = 0; i < 502; i++) {
      recordRun(dir, trace({ runId: `r${String(i).padStart(4, "0")}`, startedAt: i }))
    }
    expect(getRunTrace(dir, "r0000")).toBeUndefined()
    expect(getRunTrace(dir, "r0001")).toBeUndefined()
    expect(getRunTrace(dir, "r0002")).toBeDefined()
    expect(listRuns(dir)).toHaveLength(500)
  })

  it("never throws on a write to an unwritable dir (best-effort)", () => {
    expect(() => recordRun(path.join(dir, "nested", "deep"), trace())).not.toThrow()
  })

  it("refuses a runId containing path separators (no escape from dir)", () => {
    recordRun(dir, trace({ runId: "../escape" }))
    expect(getRunTrace(dir, "../escape")).toBeUndefined()
    expect(existsSync(path.join(dir, "..", "escape.json"))).toBe(false)
  })

  it("refuses a runId with a slash or backslash", () => {
    recordRun(dir, trace({ runId: "a/b" }))
    recordRun(dir, trace({ runId: "a\\b" }))
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
    recordRun(dir, withPlan)
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
    recordRun(parityDir, trace)
    expect(getRunTrace(parityDir, "run-ext-1")).toEqual(trace)
    rmSync(parityDir, { recursive: true, force: true })
  })

  it("filters listRuns by parentRunId", () => {
    recordRun(dir, trace({ runId: "p", startedAt: 1 }))
    recordRun(dir, trace({ runId: "c1", parentRunId: "p", startedAt: 2, origin: "subagent" }))
    recordRun(dir, trace({ runId: "c2", parentRunId: "p", startedAt: 3, origin: "subagent" }))
    recordRun(dir, trace({ runId: "other", parentRunId: "q", startedAt: 4, origin: "subagent" }))

    const children = listRuns(dir, { parentRunId: "p" })
    expect(children.map((t) => t.runId).sort()).toEqual(["c1", "c2"])
  })
})
