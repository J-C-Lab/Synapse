import type { ToolHostPort } from "../tool-registry"
import { describe, expect, it, vi } from "vitest"
import { emptyUsage } from "../providers/types"
import { AiToolRegistry } from "../tool-registry"
import { SubagentRunner } from "./subagent-runner"

function fakeProvider(text: string) {
  return {
    id: "fake",
    async *stream() {
      yield { type: "text" as const, text }
      yield {
        type: "message" as const,
        message: { role: "assistant" as const, content: [{ type: "text" as const, text }] },
        usage: emptyUsage(),
        stopReason: "end_turn" as const,
      }
    },
  }
}

function fakeHost(): ToolHostPort {
  return {
    listTools: () => [
      {
        fqName: "com.x/read",
        pluginId: "com.x",
        provenance: "plugin",
        manifestTool: { name: "read", description: "", inputSchema: { type: "object" } },
      },
    ],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
  }
}

describe("subagentRunner", () => {
  it("runs a nested agent and returns a summary + child run metadata", async () => {
    const recorded: import("../run-trace-store").RunTrace[] = []
    const runner = new SubagentRunner({
      provider: fakeProvider("subtask complete: found 3 items"),
      recordRun: (t) => recorded.push(t),
    })

    const result = await runner.run({
      parentRunId: "parent-1",
      parentConversationId: "c1",
      instruction: "count the items",
      tools: new AiToolRegistry(fakeHost()),
      maxSteps: 3,
    })

    expect(result.summary).toContain("subtask complete")
    expect(typeof result.childRunId).toBe("string")
    expect(result.outcome).toBe("end_turn")
    expect(recorded[0]).toMatchObject({
      origin: "subagent",
      parentRunId: "parent-1",
      principal: { kind: "subagent", parentRunId: "parent-1" },
    })
    expect(recorded[0].runId).toBe(result.childRunId)
  })
})
