import type { RegisteredToolDescriptor } from "../plugins/types"
import type { ChatContentBlock, ChatMessage, ChatProvider, TokenUsage } from "./providers/types"
import type { RunTrace } from "./run-trace-store"
import type { ToolHostPort } from "./tool-registry"
import { describe, expect, it, vi } from "vitest"
import { AgentRuntime, buildSystemPrompt } from "./agent-runtime"
import { emptyUsage } from "./providers/types"
import { AiToolRegistry } from "./tool-registry"

interface ScriptedTurn {
  text?: string
  toolUses?: { id: string; name: string; input: unknown }[]
  /** Tokens this turn reports, for budget tests. Defaults to none. */
  usage?: Partial<TokenUsage>
}

function fakeProvider(turns: ScriptedTurn[]): ChatProvider {
  let index = 0
  return {
    id: "fake",
    async *stream() {
      const turn = turns[index++] ?? { text: "done" }
      const content: ChatContentBlock[] = []
      if (turn.text) {
        yield { type: "text", text: turn.text }
        content.push({ type: "text", text: turn.text })
      }
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

function descriptor(): RegisteredToolDescriptor {
  return {
    fqName: "com.x.demo/greet",
    pluginId: "com.x.demo",
    manifestTool: {
      name: "greet",
      description: "Greet",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
    },
  }
}

function fakeHost(): ToolHostPort {
  return {
    listTools: () => [descriptor()],
    invokeTool: vi.fn(async (_fq: string, input: unknown) => ({
      content: [{ type: "text" as const, text: `echo:${JSON.stringify(input)}` }],
    })),
  }
}

function userMessage(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

describe("buildSystemPrompt", () => {
  it("always appends the plugin-vs-shell routing guidance", () => {
    const prompt = buildSystemPrompt("BASE", { shellEnabled: false })
    expect(prompt).toContain("BASE")
    expect(prompt).toContain("prefer that plugin")
    expect(prompt).not.toContain("run_shell")
  })

  it("mentions run_shell only when shell is enabled", () => {
    const prompt = buildSystemPrompt("BASE", { shellEnabled: true })
    expect(prompt).toContain("run_shell")
  })

  it("nudges the model to lay out a plan for multi-step tasks", () => {
    const prompt = buildSystemPrompt("BASE", { shellEnabled: false })
    expect(prompt).toContain("update_plan")
  })
})

describe("agentRuntime", () => {
  it("runs a tool call and feeds the result back to the model", async () => {
    const host = fakeHost()
    const runtime = new AgentRuntime({
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_x_demo_greet", input: { name: "Ada" } }] },
        { text: "Hello Ada" },
      ]),
      tools: new AiToolRegistry(host),
    })

    const onText = vi.fn()
    const result = await runtime.run({
      conversationId: "c1",
      messages: [userMessage("greet Ada")],
      onText,
    })

    expect(result.stopReason).toBe("end_turn")
    expect(host.invokeTool).toHaveBeenCalledWith(
      "com.x.demo/greet",
      { name: "Ada" },
      expect.objectContaining({
        caller: expect.objectContaining({ kind: "agent", conversationId: "c1" }),
      })
    )
    expect(onText).toHaveBeenCalledWith("Hello Ada")

    // Conversation should contain: user, assistant(tool_use), user(tool_result), assistant(text)
    const toolResult = result.messages[2]?.content[0]
    expect(toolResult).toMatchObject({
      type: "tool_result",
      toolUseId: "t1",
      content: 'echo:{"name":"Ada"}',
    })
  })

  it("stops at maxSteps when the model keeps calling tools", async () => {
    const host = fakeHost()
    const runtime = new AgentRuntime({
      provider: fakeProvider([
        { toolUses: [{ id: "a", name: "com_x_demo_greet", input: {} }] },
        { toolUses: [{ id: "b", name: "com_x_demo_greet", input: {} }] },
        { toolUses: [{ id: "c", name: "com_x_demo_greet", input: {} }] },
      ]),
      tools: new AiToolRegistry(host),
      maxSteps: 2,
    })

    const result = await runtime.run({ conversationId: "c1", messages: [userMessage("loop")] })
    expect(result.stopReason).toBe("max_steps")
    expect(host.invokeTool).toHaveBeenCalledTimes(2)
  })

  it("stops with budget_exceeded once cumulative usage passes the token budget", async () => {
    const host = fakeHost()
    const runtime = new AgentRuntime({
      provider: fakeProvider([
        {
          toolUses: [{ id: "a", name: "com_x_demo_greet", input: {} }],
          usage: { outputTokens: 80 },
        },
        { toolUses: [{ id: "b", name: "com_x_demo_greet", input: {} }] },
        { text: "should not reach" },
      ]),
      tools: new AiToolRegistry(host),
      budgetTokens: 50,
    })

    const result = await runtime.run({ conversationId: "c1", messages: [userMessage("loop")] })

    expect(result.stopReason).toBe("budget_exceeded")
    // First turn's tools run; the loop bails before the second provider call.
    expect(host.invokeTool).toHaveBeenCalledTimes(1)
  })

  it("does not stop early when usage stays under the token budget", async () => {
    const host = fakeHost()
    const runtime = new AgentRuntime({
      provider: fakeProvider([
        {
          toolUses: [{ id: "a", name: "com_x_demo_greet", input: {} }],
          usage: { outputTokens: 10 },
        },
        { text: "done", usage: { outputTokens: 10 } },
      ]),
      tools: new AiToolRegistry(host),
      budgetTokens: 1000,
    })

    const result = await runtime.run({ conversationId: "c1", messages: [userMessage("hi")] })

    expect(result.stopReason).toBe("end_turn")
    expect(host.invokeTool).toHaveBeenCalledTimes(1)
  })

  it("returns immediately when the signal is already aborted", async () => {
    const host = fakeHost()
    const runtime = new AgentRuntime({
      provider: fakeProvider([{ text: "should not run" }]),
      tools: new AiToolRegistry(host),
    })

    const controller = new AbortController()
    controller.abort()
    const result = await runtime.run({
      conversationId: "c1",
      messages: [userMessage("hi")],
      signal: controller.signal,
    })
    expect(result.stopReason).toBe("aborted")
    expect(host.invokeTool).not.toHaveBeenCalled()
  })

  it("denies a tool call when approval returns false", async () => {
    const host = fakeHost()
    const runtime = new AgentRuntime({
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_x_demo_greet", input: {} }] },
        { text: "ok" },
      ]),
      tools: new AiToolRegistry(host),
    })

    const result = await runtime.run({
      conversationId: "c1",
      messages: [userMessage("greet")],
      approve: () => false,
    })

    expect(host.invokeTool).not.toHaveBeenCalled()
    expect(result.messages[2]?.content[0]).toMatchObject({ type: "tool_result", isError: true })
  })

  it("records a run trace with tool calls and puts runId on the caller", async () => {
    const host = fakeHost()
    const recorded: RunTrace[] = []
    const runtime = new AgentRuntime({
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_x_demo_greet", input: { name: "Ada" } }] },
        { text: "Hello Ada" },
      ]),
      tools: new AiToolRegistry(host),
      recordRun: (trace) => recorded.push(trace),
    })

    const result = await runtime.run({ conversationId: "c1", messages: [userMessage("hi")] })

    expect(result.stopReason).toBe("end_turn")
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      conversationId: "c1",
      origin: "interactive",
      outcome: "end_turn",
    })
    expect(typeof recorded[0].runId).toBe("string")
    expect(recorded[0].runId.length).toBeGreaterThan(0)
    expect(recorded[0].toolCalls).toHaveLength(1)
    expect(recorded[0].toolCalls[0]).toMatchObject({ name: "com.x.demo/greet", ok: true })

    const callerArg = (host.invokeTool as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(callerArg.caller.runId).toBe(recorded[0].runId)
  })

  it("uses a supplied runId verbatim (background-agent path)", async () => {
    const host = fakeHost()
    const recorded: RunTrace[] = []
    const runtime = new AgentRuntime({
      provider: fakeProvider([{ text: "done" }]),
      tools: new AiToolRegistry(host),
      recordRun: (trace) => recorded.push(trace),
    })

    await runtime.run({
      conversationId: "inv-1",
      messages: [userMessage("hi")],
      runId: "supplied-run",
      origin: "background-agent",
    })

    expect(recorded[0].runId).toBe("supplied-run")
    expect(recorded[0].origin).toBe("background-agent")
  })

  it("generates a distinct runId per run() call on the same conversation", async () => {
    const host = fakeHost()
    const recorded: RunTrace[] = []
    const runtime = new AgentRuntime({
      provider: fakeProvider([{ text: "a" }, { text: "b" }]),
      tools: new AiToolRegistry(host),
      recordRun: (trace) => recorded.push(trace),
    })

    await runtime.run({ conversationId: "c1", messages: [userMessage("one")] })
    await runtime.run({ conversationId: "c1", messages: [userMessage("two")] })

    expect(recorded).toHaveLength(2)
    expect(recorded[0].runId).not.toBe(recorded[1].runId)
  })

  it("records an aborted run with outcome 'aborted'", async () => {
    const host = fakeHost()
    const recorded: RunTrace[] = []
    const runtime = new AgentRuntime({
      provider: fakeProvider([{ text: "x" }]),
      tools: new AiToolRegistry(host),
      recordRun: (trace) => recorded.push(trace),
    })
    const controller = new AbortController()
    controller.abort()

    await runtime.run({
      conversationId: "c1",
      messages: [userMessage("hi")],
      signal: controller.signal,
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0].outcome).toBe("aborted")
  })

  it("does not let a throwing recorder break the run (spec §6)", async () => {
    const host = fakeHost()
    const runtime = new AgentRuntime({
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_x_demo_greet", input: {} }] },
        { text: "done" },
      ]),
      tools: new AiToolRegistry(host),
      recordRun: () => {
        throw new Error("recorder boom")
      },
    })

    const result = await runtime.run({ conversationId: "c1", messages: [userMessage("hi")] })
    expect(result.stopReason).toBe("end_turn")
  })

  it("records a subagent run with origin 'subagent' and parentRunId", async () => {
    const host = fakeHost()
    const recorded: RunTrace[] = []
    const runtime = new AgentRuntime({
      provider: fakeProvider([{ text: "child done" }]),
      tools: new AiToolRegistry(host),
      recordRun: (t) => recorded.push(t),
    })

    await runtime.run({
      conversationId: "c1",
      messages: [userMessage("subtask")],
      runId: "child-1",
      origin: "subagent",
      parentRunId: "parent-1",
      caller: { kind: "subagent", conversationId: "c1", runId: "child-1", parentRunId: "parent-1" },
    })

    expect(recorded[0]).toMatchObject({
      runId: "child-1",
      origin: "subagent",
      parentRunId: "parent-1",
    })
  })

  it("folds the run's final plan into the recorded trace", async () => {
    const host = fakeHost()
    const recorded: RunTrace[] = []
    const plan = [{ title: "A", status: "completed" as const }]
    const runtime = new AgentRuntime({
      provider: fakeProvider([{ text: "done" }]),
      tools: new AiToolRegistry(host),
      recordRun: (t) => recorded.push(t),
      getPlan: (runId) => (runId ? plan : undefined),
    })

    await runtime.run({ conversationId: "c1", messages: [userMessage("hi")] })
    expect(recorded[0].plan).toEqual(plan)
  })

  it("sends compacted messages when a compressor is configured", async () => {
    const host = fakeHost()
    const seenLengths: number[] = []
    const provider = {
      id: "fake",
      async *stream(req: { messages: unknown[] }) {
        seenLengths.push(req.messages.length)
        yield {
          type: "message" as const,
          message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
          usage: emptyUsage(),
          stopReason: "end_turn" as const,
        }
      },
    }
    const runtime = new AgentRuntime({
      provider,
      tools: new AiToolRegistry(host),
      compress: async (_system, messages) => ({
        messages: messages.slice(-1),
        summarizerTokens: 0,
      }),
    })

    await runtime.run({
      conversationId: "c1",
      messages: [userMessage("a"), userMessage("b"), userMessage("c")],
    })
    expect(seenLengths[0]).toBe(1)
  })

  it("sends the full history when no compressor is configured", async () => {
    const host = fakeHost()
    const seenLengths: number[] = []
    const provider = {
      id: "fake",
      async *stream(req: { messages: unknown[] }) {
        seenLengths.push(req.messages.length)
        yield {
          type: "message" as const,
          message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
          usage: emptyUsage(),
          stopReason: "end_turn" as const,
        }
      },
    }
    const runtime = new AgentRuntime({ provider, tools: new AiToolRegistry(host) })
    await runtime.run({ conversationId: "c1", messages: [userMessage("a"), userMessage("b")] })
    expect(seenLengths[0]).toBe(2)
  })
})
