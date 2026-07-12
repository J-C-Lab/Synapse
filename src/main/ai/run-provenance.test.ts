import type { RunTraceToolCall } from "./run-trace-store"
import { describe, expect, it } from "vitest"
import {
  buildBackgroundAgentRun,
  buildInteractiveRun,
  buildMcpRun,
  buildRunTrace,
  buildSubagentRun,
  toToolCaller,
} from "./run-provenance"

describe("run-provenance constructors", () => {
  it("buildInteractiveRun produces an interactive-origin provenance", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1", workspaceId: "ws-1" })
    expect(p).toEqual({
      origin: "interactive",
      runId: "r1",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-1",
    })
  })

  it("buildInteractiveRun omits workspaceId when not given", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1" })
    expect(p).toEqual({
      origin: "interactive",
      runId: "r1",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
    })
  })

  it("buildBackgroundAgentRun requires and carries workspaceId/triggerInstanceId/invocationId", () => {
    const p = buildBackgroundAgentRun({
      runId: "r2",
      invocationId: "inv-1",
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
    expect(p).toEqual({
      origin: "background-agent",
      runId: "r2",
      invocationId: "inv-1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
  })

  it("buildSubagentRun derives principal.parentRunId from the single parentRunId input", () => {
    const p = buildSubagentRun({
      runId: "r3",
      conversationId: "c1",
      parentRunId: "parent-1",
      workspaceId: "ws-3",
    })
    expect(p).toEqual({
      origin: "subagent",
      runId: "r3",
      conversationId: "c1",
      parentRunId: "parent-1",
      principal: { kind: "subagent", parentRunId: "parent-1" },
      workspaceId: "ws-3",
    })
  })

  it("buildMcpRun carries only runId/workspaceId/clientId — never invocationId or conversationId", () => {
    const p = buildMcpRun({ runId: "r4", workspaceId: "ws-4", clientId: "claude-desktop" })
    expect(p).toEqual({
      origin: "mcp",
      runId: "r4",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-4",
    })
    expect(p).not.toHaveProperty("invocationId")
    expect(p).not.toHaveProperty("conversationId")
  })

  it("buildMcpRun omits clientId on principal when not given", () => {
    const p = buildMcpRun({ runId: "r5" })
    expect(p.principal).toEqual({ kind: "external-mcp" })
  })
})

describe("toToolCaller", () => {
  it("maps interactive origin to kind 'agent' and keeps conversationId, no invocationId", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1", workspaceId: "ws-1" })
    expect(toToolCaller(p)).toEqual({
      kind: "agent",
      runId: "r1",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-1",
    })
  })

  it("maps background-agent origin to kind 'background-agent' with invocationId, no conversationId", () => {
    const p = buildBackgroundAgentRun({
      runId: "r2",
      invocationId: "inv-1",
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
    const caller = toToolCaller(p)
    expect(caller).toMatchObject({
      kind: "background-agent",
      runId: "r2",
      invocationId: "inv-1",
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
    expect(caller).not.toHaveProperty("conversationId")
  })

  it("maps subagent origin to kind 'subagent' with parentRunId equal on both levels", () => {
    const p = buildSubagentRun({
      runId: "r3",
      conversationId: "c1",
      parentRunId: "parent-1",
    })
    const caller = toToolCaller(p)
    expect(caller.kind).toBe("subagent")
    expect(caller.parentRunId).toBe("parent-1")
    expect(caller.principal).toEqual({ kind: "subagent", parentRunId: "parent-1" })
  })

  it("maps mcp origin to kind 'mcp' with neither conversationId nor invocationId", () => {
    const p = buildMcpRun({ runId: "r4", clientId: "claude-desktop" })
    const caller = toToolCaller(p)
    expect(caller).toEqual({
      kind: "mcp",
      runId: "r4",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
    })
  })
})

describe("buildRunTrace", () => {
  const exec = {
    startedAt: 1000,
    endedAt: 2000,
    outcome: "end_turn" as const,
    toolCalls: [{ name: "com.x/greet", startedAt: 1100, ms: 40, ok: true }] as RunTraceToolCall[],
  }

  it("projects an interactive provenance without writing undefined keys", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1" })
    const trace = buildRunTrace(p, exec)
    expect(trace).toEqual({
      runId: "r1",
      origin: "interactive",
      conversationId: "c1",
      principal: { kind: "internal-agent" },
      startedAt: 1000,
      endedAt: 2000,
      outcome: "end_turn",
      toolCalls: exec.toolCalls,
    })
    expect(Object.keys(trace)).not.toContain("invocationId")
    expect(Object.keys(trace)).not.toContain("workspaceId")
  })

  it("projects a background-agent provenance with invocationId/triggerInstanceId, no conversationId", () => {
    const p = buildBackgroundAgentRun({
      runId: "r2",
      invocationId: "inv-1",
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
    })
    const trace = buildRunTrace(p, exec)
    expect(trace).toEqual({
      runId: "r2",
      origin: "background-agent",
      invocationId: "inv-1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-2",
      triggerInstanceId: "inst-1",
      startedAt: 1000,
      endedAt: 2000,
      outcome: "end_turn",
      toolCalls: exec.toolCalls,
    })
  })

  it("includes plan only when given", () => {
    const p = buildInteractiveRun({ runId: "r1", conversationId: "c1" })
    const withoutPlan = buildRunTrace(p, exec)
    expect(withoutPlan).not.toHaveProperty("plan")
    const withPlan = buildRunTrace(p, { ...exec, plan: [{ title: "step 1", status: "pending" }] })
    expect(withPlan.plan).toEqual([{ title: "step 1", status: "pending" }])
  })
})

// Type-invariant checks only — never executed. See "Type-invariant tests
// are typechecked, never executed" in the spec for why this can't be a
// normal @ts-expect-error line at the top level of a test file.
if (false) {
  // @ts-expect-error background-agent requires triggerInstanceId
  buildBackgroundAgentRun({ runId: "r", invocationId: "i", workspaceId: "w" })
  // @ts-expect-error background-agent requires workspaceId
  buildBackgroundAgentRun({ runId: "r", invocationId: "i", triggerInstanceId: "t" })
  // @ts-expect-error background-agent requires invocationId
  buildBackgroundAgentRun({ runId: "r", workspaceId: "w", triggerInstanceId: "t" })
  // @ts-expect-error interactive requires conversationId
  buildInteractiveRun({ runId: "r" })
  // @ts-expect-error subagent requires parentRunId
  buildSubagentRun({ runId: "r", conversationId: "c" })
}
