import type { SubagentRunInput, SubagentRunResult } from "./subagent-runner"
import { describe, expect, it, vi } from "vitest"
import { UPDATE_PLAN_FQ } from "../plan/plan-tool-source"
import { AiToolRegistry } from "../tool-registry"
import {
  SPAWN_SUBAGENT_FQ,
  SpawnSubagentToolSource,
  SUBAGENT_FQ_PREFIX,
} from "./subagent-tool-source"

function parentRegistry() {
  return new AiToolRegistry({
    listTools: () => [
      {
        fqName: "com.x/read",
        pluginId: "com.x",
        manifestTool: {
          name: "read",
          description: "",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      },
      {
        fqName: UPDATE_PLAN_FQ,
        pluginId: "plan:core",
        manifestTool: {
          name: "update_plan",
          description: "",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      },
      {
        fqName: "com.x/write",
        pluginId: "com.x",
        manifestTool: { name: "write", description: "", inputSchema: { type: "object" } },
      },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "" }] })),
  })
}

function agentCaller(extra: Record<string, unknown> = {}) {
  return {
    caller: { kind: "agent" as const, conversationId: "c1", runId: "parent-1", ...extra },
    signal: new AbortController().signal,
  }
}

describe("spawnSubagentToolSource", () => {
  it("advertises a confirmation-required descriptor", () => {
    const src = new SpawnSubagentToolSource({ runSubagent: vi.fn(), parentTools: parentRegistry })
    const [desc] = src.listTools()
    expect(desc.fqName).toBe(SPAWN_SUBAGENT_FQ)
    expect(desc.manifestTool.annotations?.requiresConfirmation).toBe(true)
    expect(SUBAGENT_FQ_PREFIX).toBe("agent:")
  })

  it("rejects nesting beyond depth 1", async () => {
    const runSubagent = vi.fn()
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    const result = await src.invokeTool(
      SPAWN_SUBAGENT_FQ,
      { instruction: "x" },
      agentCaller({ kind: "subagent", parentRunId: "grandparent" })
    )
    expect(result.isError).toBe(true)
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it("intersects allowedTools with the parent set and errors on empty intersection", async () => {
    const runSubagent = vi.fn()
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    const result = await src.invokeTool(
      SPAWN_SUBAGENT_FQ,
      { instruction: "x", allowedTools: ["com_x_nonexistent"] },
      agentCaller()
    )
    expect(result.isError).toBe(true)
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it("runs the subagent with the intersected tools and returns its summary", async () => {
    const runSubagent = vi.fn<(input: SubagentRunInput) => Promise<SubagentRunResult>>(
      async () => ({
        summary: "child summary",
        childRunId: "c-1",
        outcome: "end_turn",
      })
    )
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    const result = await src.invokeTool(
      SPAWN_SUBAGENT_FQ,
      { instruction: "count items", allowedTools: ["com_x_read"] },
      agentCaller()
    )
    expect(result.isError ?? false).toBe(false)
    expect(runSubagent).toHaveBeenCalledTimes(1)
    const arg = runSubagent.mock.calls[0]![0]
    expect(arg.parentRunId).toBe("parent-1")
    expect(arg.instruction).toBe("count items")
    expect(arg.tools.list().map((s) => s.name)).toEqual(["com_x_read"])
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("child summary"),
    })
  })

  it("defaults to the parent's read-only tools when allowedTools is omitted", async () => {
    const runSubagent = vi.fn<(input: SubagentRunInput) => Promise<SubagentRunResult>>(
      async () => ({
        summary: "ok",
        childRunId: "c-1",
        outcome: "end_turn",
      })
    )
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    await src.invokeTool(SPAWN_SUBAGENT_FQ, { instruction: "x" }, agentCaller())
    const arg = runSubagent.mock.calls[0]![0]
    expect(arg.tools.list().map((s) => s.name)).toEqual(["com_x_read"])
  })

  it("excludes orchestration tools (update_plan, spawn_subagent) from the default read-only subset", async () => {
    const runSubagent = vi.fn<(input: SubagentRunInput) => Promise<SubagentRunResult>>(
      async () => ({
        summary: "ok",
        childRunId: "c-1",
        outcome: "end_turn",
      })
    )
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: parentRegistry })
    await src.invokeTool(SPAWN_SUBAGENT_FQ, { instruction: "x" }, agentCaller())
    const names = runSubagent.mock.calls[0]![0].tools.list().map((s) => s.name)
    expect(names).toEqual(["com_x_read"])
    expect(names).not.toContain("plan_core_update_plan")
    expect(names).not.toContain("agent_core_spawn_subagent")
  })

  it("strips orchestration tools even when explicitly requested in allowedTools", async () => {
    const parent = parentRegistry()
    const runSubagent = vi.fn<(input: SubagentRunInput) => Promise<SubagentRunResult>>(
      async () => ({
        summary: "ok",
        childRunId: "c-1",
        outcome: "end_turn",
      })
    )
    const src = new SpawnSubagentToolSource({ runSubagent, parentTools: () => parent })
    const result = await src.invokeTool(
      SPAWN_SUBAGENT_FQ,
      {
        instruction: "x",
        allowedTools: ["com_x_read", "plan_core_update_plan", "agent_core_spawn_subagent"],
      },
      agentCaller()
    )
    expect(result.isError ?? false).toBe(false)
    const names = runSubagent.mock.calls[0]![0].tools.list().map((s) => s.name)
    expect(names).toEqual(["com_x_read"])
  })

  it("passes the parent turn budget cap to the subagent runner", async () => {
    const runSubagent = vi.fn<(input: SubagentRunInput) => Promise<SubagentRunResult>>(
      async () => ({
        summary: "ok",
        childRunId: "c-1",
        outcome: "end_turn",
      })
    )
    const src = new SpawnSubagentToolSource({
      runSubagent,
      parentTools: parentRegistry,
      budgetTokens: (runId) => (runId === "parent-1" ? 5000 : undefined),
    })
    await src.invokeTool(SPAWN_SUBAGENT_FQ, { instruction: "x" }, agentCaller())
    expect(runSubagent.mock.calls[0]![0].budgetTokens).toBe(5000)
  })
})
