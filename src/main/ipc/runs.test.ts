import { describe, expect, it } from "vitest"
import {
  normalizeRunListQuery,
  normalizeRunTraceForRenderer,
  registerRunsIpc,
  toRunSummary,
} from "./runs"

function validRawTrace(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: "r1",
    origin: "interactive",
    outcome: "end_turn",
    startedAt: 1000,
    endedAt: 2000,
    conversationId: "c1",
    principal: { kind: "internal-agent" },
    toolCalls: [{ name: "probe", startedAt: 1100, ms: 40, ok: true }],
    ...overrides,
  }
}

describe("normalizeRunTraceForRenderer", () => {
  it("round-trips a well-formed trace with every field intact", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace())
    expect(result).toEqual({
      runId: "r1",
      origin: "interactive",
      outcome: "end_turn",
      startedAt: 1000,
      endedAt: 2000,
      conversationId: "c1",
      invocationId: undefined,
      parentRunId: undefined,
      workspaceId: undefined,
      triggerInstanceId: undefined,
      principal: { kind: "internal-agent" },
      toolCalls: [{ name: "probe", startedAt: 1100, ms: 40, ok: true }],
    })
  })

  it("normalizes toolCalls: null to an empty array instead of throwing", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace({ toolCalls: null }))
    expect(result?.toolCalls).toEqual([])
  })

  it("resolves undefined for an unrecognized origin or outcome", () => {
    expect(normalizeRunTraceForRenderer(validRawTrace({ origin: "bogus" }))).toBeUndefined()
    expect(normalizeRunTraceForRenderer(validRawTrace({ outcome: "bogus" }))).toBeUndefined()
  })

  it("drops an unrecognized top-level field instead of passing it through", () => {
    const result = normalizeRunTraceForRenderer(validRawTrace({ secretField: "leak" }))
    expect(result).toBeDefined()
    expect(result).not.toHaveProperty("secretField")
  })

  it("drops one malformed toolCalls entry among valid ones, keeps the rest", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [
          { name: "good", startedAt: 1, ms: 1, ok: true },
          { name: "bad" },
          { name: "good2", startedAt: 2, ms: 2, ok: false },
        ],
      })
    )
    expect(result?.toolCalls.map((c) => c.name)).toEqual(["good", "good2"])
  })

  it("maps a toolCalls error outside the four-item allowlist to legacy-error", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [{ name: "t", startedAt: 1, ms: 1, ok: false, error: "ENOENT: /etc/passwd" }],
      })
    )
    expect(result?.toolCalls[0]?.error).toBe("legacy-error")
  })

  it("keeps an allowed error category unchanged", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({ toolCalls: [{ name: "t", startedAt: 1, ms: 1, ok: false, error: "denied" }] })
    )
    expect(result?.toolCalls[0]?.error).toBe("denied")
  })

  it("caps a plan step's title at 500 characters", () => {
    const longTitle = "x".repeat(1000)
    const result = normalizeRunTraceForRenderer(
      validRawTrace({ plan: [{ title: longTitle, status: "pending" }] })
    )
    expect(result?.plan?.[0]?.title.length).toBe(500)
  })

  it("drops a plan step with an unrecognized status", () => {
    const result = normalizeRunTraceForRenderer(
      validRawTrace({
        plan: [
          { title: "ok", status: "pending" },
          { title: "bad", status: "bogus" },
        ],
      })
    )
    expect(result?.plan?.map((s) => s.title)).toEqual(["ok"])
  })

  it("resolves undefined for a non-object value", () => {
    expect(normalizeRunTraceForRenderer(null)).toBeUndefined()
    expect(normalizeRunTraceForRenderer("a string")).toBeUndefined()
    expect(normalizeRunTraceForRenderer(42)).toBeUndefined()
  })

  it("resolves undefined when a required field is missing or wrongly typed", () => {
    expect(normalizeRunTraceForRenderer(validRawTrace({ runId: 123 }))).toBeUndefined()
    expect(
      normalizeRunTraceForRenderer(validRawTrace({ startedAt: "not a number" }))
    ).toBeUndefined()
  })
})

describe("toRunSummary", () => {
  it("maps every RendererRunTrace field and computes tool-call counts", () => {
    const trace = normalizeRunTraceForRenderer(
      validRawTrace({
        toolCalls: [
          { name: "a", startedAt: 1, ms: 1, ok: true },
          { name: "b", startedAt: 2, ms: 1, ok: false },
          { name: "c", startedAt: 3, ms: 1, ok: false },
        ],
      })
    )!
    const summary = toRunSummary(trace)
    expect(summary.runId).toBe("r1")
    expect(summary.toolCallCount).toBe(3)
    expect(summary.failedToolCallCount).toBe(2)
    expect(summary.hasPlan).toBe(false)
  })

  it("hasPlan is true only for a non-empty plan", () => {
    const withPlan = normalizeRunTraceForRenderer(
      validRawTrace({ plan: [{ title: "step", status: "pending" }] })
    )!
    expect(toRunSummary(withPlan).hasPlan).toBe(true)
    const withEmptyPlan = normalizeRunTraceForRenderer(validRawTrace({ plan: [] }))!
    expect(toRunSummary(withEmptyPlan).hasPlan).toBe(false)
  })
})

describe("normalizeRunListQuery", () => {
  it("accepts undefined and an empty object, returning {}", () => {
    expect(normalizeRunListQuery(undefined)).toEqual({})
    expect(normalizeRunListQuery({})).toEqual({})
  })

  it("accepts a well-formed parentRunId", () => {
    expect(normalizeRunListQuery({ parentRunId: "r1" })).toEqual({ parentRunId: "r1" })
  })

  it("trims a parentRunId", () => {
    expect(normalizeRunListQuery({ parentRunId: "  r1  " })).toEqual({ parentRunId: "r1" })
  })

  it("rejects a non-string, blank, or over-200-char parentRunId", () => {
    expect(() => normalizeRunListQuery({ parentRunId: 123 })).toThrow()
    expect(() => normalizeRunListQuery({ parentRunId: "   " })).toThrow()
    expect(() => normalizeRunListQuery({ parentRunId: "x".repeat(201) })).toThrow()
  })

  it("rejects a non-object payload", () => {
    expect(() => normalizeRunListQuery("not an object")).toThrow("payload must be an object")
    expect(() => normalizeRunListQuery(42)).toThrow()
  })

  it("rejects an array", () => {
    expect(() => normalizeRunListQuery([])).toThrow("payload must be an object")
  })

  it("rejects a payload with an unrecognized key instead of silently returning {}", () => {
    expect(() => normalizeRunListQuery({ parentRunID: "typo" })).toThrow("unexpected field")
  })
})

describe("registerRunsIpc", () => {
  function fakeIpcMain() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    return {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn)
      },
      handlers,
    }
  }

  it("rejects an untrusted sender on both channels", () => {
    const ipcMain = fakeIpcMain()
    registerRunsIpc(ipcMain as never, "/tmp/does-not-matter", { isTrustedSender: () => false })
    expect(() => ipcMain.handlers.get("runs:list")?.({})).toThrow()
    expect(() => ipcMain.handlers.get("runs:get")?.({}, "r1")).toThrow()
  })

  it("runs:get with a path-traversal-shaped runId resolves undefined, not a thrown error", async () => {
    const ipcMain = fakeIpcMain()
    registerRunsIpc(ipcMain as never, "/tmp/does-not-matter", { isTrustedSender: () => true })
    await expect(
      Promise.resolve(ipcMain.handlers.get("runs:get")?.({}, "../escape"))
    ).resolves.toBeUndefined()
  })
})
