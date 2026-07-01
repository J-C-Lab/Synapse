import type { TriggerUse } from "@synapse/plugin-manifest"
import type { RegisteredToolDescriptor } from "../plugins/types"
import type { ChatContentBlock, ChatProvider, TokenUsage } from "./providers/types"
import { describe, expect, it, vi } from "vitest"
import { AgentBudgetLedger } from "../plugins/agent-budget"
import { BackgroundAgentRunner } from "./background-agent-runner"
import { emptyUsage } from "./providers/types"

interface ScriptedTurn {
  text?: string
  toolUses?: { id: string; name: string; input: unknown }[]
  usage?: Partial<TokenUsage>
}

function fakeProvider(turns: ScriptedTurn[]): ChatProvider {
  let index = 0
  return {
    id: "fake",
    async *stream(_req) {
      const turn = turns[index++] ?? { text: "done" }
      const content: ChatContentBlock[] = []
      if (turn.text) content.push({ type: "text", text: turn.text })
      for (const call of turn.toolUses ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input })
      }
      yield {
        type: "message",
        message: { role: "assistant", content },
        usage: { ...emptyUsage(), ...turn.usage },
        stopReason: turn.toolUses?.length ? "tool_use" : "end_turn",
      }
    },
  }
}

function descriptor(
  name: string,
  capabilities: RegisteredToolDescriptor["manifestTool"]["capabilities"]
): RegisteredToolDescriptor {
  return {
    fqName: `com.example.organizer/${name}`,
    pluginId: "com.example.organizer",
    manifestTool: {
      name,
      description: name,
      inputSchema: { type: "object" },
      capabilities,
    },
  }
}

const fsReadUse: TriggerUse = {
  capability: "fs:read",
  scope: { paths: ["~/Downloads/**"] },
  budget: { maxCalls: 5, period: "1h" },
}

const agentBudget = {
  maxRuns: 1,
  period: "1d" as const,
  maxToolCallsPerRun: 1,
  maxTokensPerRun: 50,
  timeoutMs: 1000,
}

describe("backgroundAgentRunner", () => {
  it("exposes only tools whose capabilities are contained by allowedUses", async () => {
    const invoked = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
    const runner = new BackgroundAgentRunner({
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_example_organizer_read", input: {} }] },
        { text: "done" },
      ]),
      tools: {
        listTools: () => [
          descriptor("read", [{ id: "fs:read", scope: { paths: ["~/Downloads/**"] } }]),
          descriptor("write", [{ id: "fs:write", scope: { paths: ["~/Downloads/**"] } }]),
        ],
        invokeTool: invoked,
      },
      ledger: new AgentBudgetLedger(() => 0),
    })

    await runner.run({
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      invocationId: "inv-1",
      event: { relativePath: "report.pdf" },
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Classify the file.",
    })

    expect(invoked).toHaveBeenCalledWith(
      "com.example.organizer/read",
      {},
      expect.objectContaining({
        caller: expect.objectContaining({ kind: "background-agent", invocationId: "inv-1" }),
      })
    )
  })

  it("denies tool calls after maxToolCallsPerRun is spent", async () => {
    const invoked = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
    const runner = new BackgroundAgentRunner({
      provider: fakeProvider([
        {
          toolUses: [
            { id: "t1", name: "com_example_organizer_read", input: { n: 1 } },
            { id: "t2", name: "com_example_organizer_read", input: { n: 2 } },
          ],
        },
        { text: "done" },
      ]),
      tools: {
        listTools: () => [
          descriptor("read", [{ id: "fs:read", scope: { paths: ["~/Downloads/**"] } }]),
        ],
        invokeTool: invoked,
      },
      ledger: new AgentBudgetLedger(() => 0),
    })

    const result = await runner.run({
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Use tools twice.",
    })

    expect(result.stopReason).toBe("end_turn")
    expect(invoked).toHaveBeenCalledTimes(1)
  })

  it("returns budget_exceeded when the run window is exhausted", async () => {
    const ledger = new AgentBudgetLedger(() => 0)
    const runner = new BackgroundAgentRunner({
      provider: fakeProvider([{ text: "done" }]),
      tools: { listTools: () => [], invokeTool: vi.fn() },
      ledger,
    })
    const input = {
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Run.",
    }

    await runner.run(input)
    await expect(runner.run({ ...input, invocationId: "inv-2" })).resolves.toMatchObject({
      stopReason: "budget_exceeded",
    })
  })

  it("records a trace whose runId matches the ledger run and origin is background-agent", async () => {
    const recorded: import("./run-trace-store").RunTrace[] = []
    const runner = new BackgroundAgentRunner({
      provider: fakeProvider([{ text: "done" }]),
      tools: { listTools: () => [], invokeTool: vi.fn() },
      recordRun: (trace) => recorded.push(trace),
    })

    await runner.run({
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Run.",
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0].origin).toBe("background-agent")
    expect(recorded[0].invocationId).toBe("inv-1")
    expect(typeof recorded[0].runId).toBe("string")
  })

  it("records outcome 'budget_exceeded' (not 'aborted') when the token budget is hit", async () => {
    const recorded: import("./run-trace-store").RunTrace[] = []
    const runner = new BackgroundAgentRunner({
      provider: fakeProvider([
        {
          toolUses: [{ id: "t1", name: "com_example_organizer_read", input: {} }],
          usage: { outputTokens: 9999 },
        },
        { text: "should not reach" },
      ]),
      tools: {
        listTools: () => [
          descriptor("read", [{ id: "fs:read", scope: { paths: ["~/Downloads/**"] } }]),
        ],
        invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
      },
      recordRun: (trace) => recorded.push(trace),
    })

    const result = await runner.run({
      pluginId: "com.example.organizer",
      triggerId: "downloads",
      invocationId: "inv-1",
      event: {},
      allowedUses: [fsReadUse],
      agent: agentBudget,
      instruction: "Run.",
    })

    expect(result.stopReason).toBe("budget_exceeded")
    expect(recorded).toHaveLength(1)
    expect(recorded[0].outcome).toBe("budget_exceeded")
  })
})
