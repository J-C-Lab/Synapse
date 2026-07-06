import type { RegisteredToolDescriptor } from "../plugins/types"
import type { AiChatEvent } from "./agent-service"
import type { AiSettingsStore } from "./ai-settings-store"
import type { ApprovalStore } from "./approval-store"
import type { ConversationStore, StoredConversation } from "./conversation-store"
import type { AiCredentialStore } from "./credential-store"
import type { ProviderDescriptor } from "./providers/catalog"
import type { ChatContentBlock, ChatProvider, TokenUsage } from "./providers/types"
import type { ToolHostPort } from "./tool-registry"
import { describe, expect, it, vi } from "vitest"
import { AgentMissingKeyError, AgentService } from "./agent-service"
import { DEFAULT_TOOL_RESILIENCE } from "./ai-settings-store"
import { emptyUsage } from "./providers/types"
import { AiToolRegistry } from "./tool-registry"

function descriptorFor(id: string): ProviderDescriptor {
  return {
    id,
    label: id,
    defaultModel: `${id}-default`,
    models: [`${id}-default`],
    create: () => fakeProvider([{ text: "x" }]),
  }
}

interface ScriptedTurn {
  text?: string
  toolUses?: { id: string; name: string; input: unknown }[]
  usage?: Partial<TokenUsage>
}

function fakeProvider(turns: ScriptedTurn[]): ChatProvider {
  let index = 0
  return {
    id: "fake",
    async *stream() {
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

function streamingProvider(turns: Array<ScriptedTurn & { deltas?: string[] }>): ChatProvider {
  let index = 0
  return {
    id: "streaming-fake",
    async *stream() {
      const turn = turns[index++] ?? { text: "done" }
      const content: ChatContentBlock[] = []
      for (const delta of turn.deltas ?? []) {
        yield { type: "text" as const, text: delta }
      }
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

/** Minimal AiSettingsStore stub with a mutable in-memory state. */
function settingsStub(initial: Partial<{ budgetTokens: number }> = {}) {
  const state = { activeProvider: "anthropic", models: {}, budgetTokens: 0, ...initial }
  return {
    state,
    get: async () => state,
    setActiveProvider: async (id: string) => {
      state.activeProvider = id
    },
    setModel: async () => {},
    setBudget: async (tokens: number) => {
      state.budgetTokens = Math.max(0, Math.floor(tokens))
    },
  } as unknown as AiSettingsStore & { state: { budgetTokens: number } }
}

function descriptor(annotations?: RegisteredToolDescriptor["manifestTool"]["annotations"]) {
  return {
    fqName: "com.x.demo/act",
    pluginId: "com.x.demo",
    manifestTool: {
      name: "act",
      description: "Act",
      inputSchema: { type: "object", properties: {} },
      annotations,
    },
  } satisfies RegisteredToolDescriptor
}

function fakeHost(
  annotations?: RegisteredToolDescriptor["manifestTool"]["annotations"]
): ToolHostPort {
  return {
    listTools: () => [descriptor(annotations)],
    invokeTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] })),
  }
}

function credentials(key: string | undefined): AiCredentialStore {
  return {
    has: async () => key !== undefined,
    get: async () => key,
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: async () => (key ? ["anthropic"] : []),
  } as unknown as AiCredentialStore
}

function conversations(): { store: ConversationStore; saved: StoredConversation[] } {
  const saved: StoredConversation[] = []
  const store = {
    get: async (id: string) => saved.find((c) => c.id === id),
    save: async (conversation: StoredConversation) => {
      const idx = saved.findIndex((c) => c.id === conversation.id)
      if (idx >= 0) saved[idx] = conversation
      else saved.push(conversation)
      return conversation
    },
    list: async () => [],
    delete: async () => {},
  } as unknown as ConversationStore
  return { store, saved }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function service(options: {
  provider: ChatProvider
  host: ToolHostPort
  key?: string
  recordRun?: (trace: import("./run-trace-store").RunTrace) => void
  workspaces?: { exists: (id: string) => Promise<boolean> }
  getToolHealth?: () => import("./tool-circuit-breaker").ToolStatSnapshot[]
}): {
  service: AgentService
  events: AiChatEvent[]
  saved: StoredConversation[]
} {
  const events: AiChatEvent[] = []
  const convo = conversations()
  const svc = new AgentService({
    credentials: credentials("key" in options ? options.key : "sk-test"),
    tools: new AiToolRegistry(options.host),
    conversations: convo.store,
    workspaces: options.workspaces,
    createProvider: () => options.provider,
    sendEvent: (event) => events.push(event),
    recordRun: options.recordRun,
    getToolHealth: options.getToolHealth,
    now: () => 1000,
  })
  return { service: svc, events, saved: convo.saved }
}

describe("agentService", () => {
  it("auto-runs a read-only tool and streams events without asking", async () => {
    const host = fakeHost({ readOnlyHint: true })
    const {
      service: svc,
      events,
      saved,
    } = service({
      host,
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_x_demo_act", input: { a: 1 } }] },
        { text: "all done" },
      ]),
    })

    const result = await svc.chat("c1", "go")

    expect(result.stopReason).toBe("end_turn")
    expect(host.invokeTool).toHaveBeenCalledOnce()
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "done"])
    expect(events.some((event) => event.type === "approval_request")).toBe(false)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.title).toBe("go")
  })

  it("asks for approval on a non-read-only tool and runs it once allowed", async () => {
    const host = fakeHost() // unannotated → must ask
    const { service: svc, events } = service({
      host,
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_x_demo_act", input: {} }] },
        { text: "done" },
      ]),
    })

    const done = svc.chat("c1", "go")
    await flush()

    const request = events.find((event) => event.type === "approval_request")
    expect(request).toBeDefined()
    if (request?.type !== "approval_request") throw new Error("expected approval request")
    expect(request.toolName).toBe("com.x.demo/act")

    svc.resolveApproval(request.approvalId, true)
    await done

    expect(host.invokeTool).toHaveBeenCalledOnce()
  })

  it("denies a tool when approval is rejected", async () => {
    const host = fakeHost()
    const { service: svc, events } = service({
      host,
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_x_demo_act", input: {} }] },
        { text: "ok" },
      ]),
    })

    const done = svc.chat("c1", "go")
    await flush()
    const request = events.find((event) => event.type === "approval_request")
    if (request?.type !== "approval_request") throw new Error("expected approval request")
    svc.resolveApproval(request.approvalId, false)
    await done

    expect(host.invokeTool).not.toHaveBeenCalled()
    const toolResult = events.find((event) => event.type === "tool_result")
    expect(toolResult).toMatchObject({ isError: true })
  })

  it("throws when no API key is configured", async () => {
    const { service: svc } = service({
      host: fakeHost({ readOnlyHint: true }),
      provider: fakeProvider([{ text: "hi" }]),
      key: undefined,
    })
    await expect(svc.chat("c1", "hi")).rejects.toBeInstanceOf(AgentMissingKeyError)
  })

  it("uses the active provider's key, model, and factory", async () => {
    const calls: { providerId: string; apiKey: string }[] = []
    const convo = conversations()
    const settings = {
      state: { activeProvider: "openai", models: { openai: "gpt-4.1" } as Record<string, string> },
      get: async () => settings.state,
      setActiveProvider: async (id: string) => {
        settings.state = { ...settings.state, activeProvider: id }
      },
      setModel: async (id: string, model: string) => {
        settings.state = { ...settings.state, models: { ...settings.state.models, [id]: model } }
      },
    }
    const creds = {
      has: async (id: string) => id === "openai",
      get: async (id: string) => (id === "openai" ? "sk-openai" : undefined),
      set: vi.fn(),
      delete: vi.fn(),
      list: async () => ["openai"],
    } as unknown as AiCredentialStore

    const svc = new AgentService({
      credentials: creds,
      tools: new AiToolRegistry(fakeHost({ readOnlyHint: true })),
      conversations: convo.store,
      providers: [descriptorFor("anthropic"), descriptorFor("openai")],
      settings: settings as unknown as AiSettingsStore,
      createProvider: (providerId, apiKey) => {
        calls.push({ providerId, apiKey })
        return fakeProvider([{ text: "hi" }])
      },
      sendEvent: () => {},
      now: () => 1000,
    })

    await svc.chat("c1", "go")
    expect(calls).toEqual([{ providerId: "openai", apiKey: "sk-openai" }])

    const status = await svc.getStatus()
    expect(status.provider).toBe("openai")
    expect(status.model).toBe("gpt-4.1")
    expect(status.providers.find((provider) => provider.id === "openai")?.hasKey).toBe(true)
    expect(status.providers.find((provider) => provider.id === "anthropic")?.hasKey).toBe(false)
  })

  it("stops a turn with budget_exceeded once the configured token budget is passed", async () => {
    const events: AiChatEvent[] = []
    const svc = new AgentService({
      credentials: credentials("sk-test"),
      tools: new AiToolRegistry(fakeHost({ readOnlyHint: true })),
      conversations: conversations().store,
      settings: settingsStub({ budgetTokens: 50 }),
      createProvider: () =>
        fakeProvider([
          {
            toolUses: [{ id: "a", name: "com_x_demo_act", input: {} }],
            usage: { outputTokens: 80 },
          },
          { text: "should not reach" },
        ]),
      sendEvent: (event) => events.push(event),
      now: () => 1000,
    })

    const result = await svc.chat("c1", "go")

    expect(result.stopReason).toBe("budget_exceeded")
    const done = events.find((event) => event.type === "done")
    expect(done).toMatchObject({ stopReason: "budget_exceeded" })
  })

  it("reports the configured token budget in status and can set it", async () => {
    const settings = settingsStub({ budgetTokens: 2000 })
    const svc = new AgentService({
      credentials: credentials("sk-test"),
      tools: new AiToolRegistry(fakeHost()),
      conversations: conversations().store,
      settings,
      createProvider: () => fakeProvider([{ text: "hi" }]),
      sendEvent: () => {},
      now: () => 1000,
    })

    expect((await svc.getStatus()).budgetTokens).toBe(2000)
    await svc.setBudget(500)
    expect(settings.state.budgetTokens).toBe(500)
    expect((await svc.getStatus()).budgetTokens).toBe(500)
  })

  it("seeds permanent allow from the approval store so a seeded tool runs unasked", async () => {
    const approvals = {
      list: async () => ["com.x.demo/act"],
      add: async () => {},
      remove: async () => {},
    } as unknown as ApprovalStore
    const host = fakeHost() // unannotated → would normally ask
    const convo = conversations()
    const events: AiChatEvent[] = []
    const svc = new AgentService({
      credentials: credentials("sk-test"),
      tools: new AiToolRegistry(host),
      conversations: convo.store,
      createProvider: () =>
        fakeProvider([
          { toolUses: [{ id: "t1", name: "com_x_demo_act", input: {} }] },
          { text: "done" },
        ]),
      approvals,
      sendEvent: (event) => events.push(event),
      now: () => 1000,
    })

    await svc.chat("c1", "go")
    expect(host.invokeTool).toHaveBeenCalledOnce()
    expect(events.some((event) => event.type === "approval_request")).toBe(false)
  })

  it("persists an always-allow decision and can revoke it", async () => {
    const added: string[] = []
    const removed: string[] = []
    const approvals = {
      list: async () => ["x/y"],
      add: async (fqName: string) => {
        added.push(fqName)
      },
      remove: async (fqName: string) => {
        removed.push(fqName)
      },
    } as unknown as ApprovalStore
    const svc = new AgentService({
      credentials: credentials("sk-test"),
      tools: new AiToolRegistry(fakeHost()),
      conversations: conversations().store,
      createProvider: () => fakeProvider([{ text: "hi" }]),
      approvals,
      sendEvent: () => {},
      now: () => 1000,
    })

    expect(await svc.listAllowedTools()).toEqual(["x/y"])
    await svc.revokeTool("x/y")
    expect(removed).toEqual(["x/y"])
    expect(await svc.listAllowedTools()).toEqual([])
    expect(added).toEqual([])
  })

  it("remembers an always-allow decision for the rest of the run", async () => {
    const host = fakeHost()
    const { service: svc, events } = service({
      host,
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: "com_x_demo_act", input: {} }] },
        { toolUses: [{ id: "t2", name: "com_x_demo_act", input: {} }] },
        { text: "done" },
      ]),
    })

    const done = svc.chat("c1", "go")
    await flush()
    const first = events.find((event) => event.type === "approval_request")
    if (first?.type !== "approval_request") throw new Error("expected approval request")
    svc.resolveApproval(first.approvalId, true, "always")
    await done

    // Two tool calls, but only one approval request (second was remembered).
    expect(host.invokeTool).toHaveBeenCalledTimes(2)
    expect(events.filter((event) => event.type === "approval_request")).toHaveLength(1)
  })

  it("forwards a run trace to the configured recorder", async () => {
    const host = fakeHost({ readOnlyHint: true })
    const recorded: import("./run-trace-store").RunTrace[] = []
    const { service: svc } = service({
      provider: fakeProvider([{ text: "hi there" }]),
      host,
      recordRun: (trace) => recorded.push(trace),
    })

    await svc.chat("c1", "hello")

    expect(recorded).toHaveLength(1)
    expect(recorded[0].conversationId).toBe("c1")
    expect(recorded[0].origin).toBe("interactive")
  })

  it("coalesces provider text deltas before sending done", async () => {
    const { service: svc, events } = service({
      host: fakeHost({ readOnlyHint: true }),
      provider: streamingProvider([{ deltas: ["hel", "lo"], text: "hello" }]),
    })

    await svc.chat("c1", "say hi")

    expect(events).toMatchObject([
      { type: "text", delta: "hello" },
      { type: "done", stopReason: "end_turn" },
    ])
  })

  it("flushes batched text before tool events", async () => {
    const { service: svc, events } = service({
      host: fakeHost({ readOnlyHint: true }),
      provider: streamingProvider([
        {
          deltas: ["I will ", "check."],
          toolUses: [{ id: "t1", name: "com_x_demo_act", input: {} }],
        },
        { deltas: ["Done."], text: "Done." },
      ]),
    })

    await svc.chat("c1", "go")

    expect(events.map((event) => event.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "text",
      "done",
    ])
    expect(events[0]).toMatchObject({ type: "text", delta: "I will check." })
    expect(events[3]).toMatchObject({ type: "text", delta: "Done." })
  })

  it("exposes tool health from the injected provider", () => {
    const snapshot = {
      key: "mcp:srv",
      state: "open" as const,
      total: 4,
      ok: 1,
      infraFailures: 3,
      toolErrors: 0,
      consecutiveFailures: 3,
      avgLatencyMs: 12,
      lastTouchedAt: 1000,
    }
    const { service: svc } = service({
      provider: fakeProvider([{ text: "hi" }]),
      host: fakeHost(),
      getToolHealth: () => [snapshot],
    })
    expect(svc.toolHealth()).toEqual([snapshot])
  })

  it("returns an empty tool-health list when no provider is wired", () => {
    const { service: svc } = service({
      provider: fakeProvider([{ text: "hi" }]),
      host: fakeHost(),
    })
    expect(svc.toolHealth()).toEqual([])
  })

  it("reports default tool resilience in status when unset", async () => {
    const { service: svc } = service({
      provider: fakeProvider([{ text: "hi" }]),
      host: fakeHost(),
    })
    expect((await svc.getStatus()).toolResilience).toEqual(DEFAULT_TOOL_RESILIENCE)
  })

  it("persists tool resilience via settings and notifies the host", async () => {
    const setToolResilience = vi.fn(async () => {})
    const applied: unknown[] = []
    const settings = {
      get: async () => ({ activeProvider: "anthropic", models: {}, budgetTokens: 0 }),
      setToolResilience,
    } as unknown as AiSettingsStore
    const svc = new AgentService({
      credentials: credentials("sk-test"),
      tools: new AiToolRegistry(fakeHost()),
      conversations: conversations().store,
      createProvider: () => fakeProvider([{ text: "hi" }]),
      sendEvent: () => {},
      settings,
      onToolResilienceChange: (cfg) => applied.push(cfg),
    })
    const next = { failureThreshold: 3, recoveryMs: 1000, timeoutMs: 5000 }
    await svc.setToolResilience(next)
    expect(setToolResilience).toHaveBeenCalledWith(next)
    expect(applied).toEqual([next])
  })

  it("sources the conversation's workspaceId into the run trace", async () => {
    const traces: import("./run-trace-store").RunTrace[] = []
    const { service: svc, saved } = service({
      host: fakeHost({ readOnlyHint: true }),
      provider: fakeProvider([{ text: "done" }]),
      recordRun: (t) => traces.push(t),
      workspaces: { exists: async (id) => id === "default" || id === "work" },
    })
    saved.push({
      id: "c-work",
      workspaceId: "work",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })

    await svc.chat("c-work", "hello")

    expect(traces.at(-1)?.workspaceId).toBe("work")
  })

  it("defaults a legacy conversation to workspaceId default in the trace", async () => {
    const traces: import("./run-trace-store").RunTrace[] = []
    const { service: svc, saved } = service({
      host: fakeHost({ readOnlyHint: true }),
      provider: fakeProvider([{ text: "done" }]),
      recordRun: (t) => traces.push(t),
    })
    saved.push({
      id: "c-legacy",
      workspaceId: "default",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })

    await svc.chat("c-legacy", "hi")

    expect(traces.at(-1)?.workspaceId).toBe("default")
  })

  it("createConversation binds the chosen workspace and rejects unknown ones", async () => {
    const { service: svc } = service({
      host: fakeHost(),
      provider: fakeProvider([{ text: "x" }]),
      workspaces: { exists: async (id) => id === "default" || id === "work" },
    })
    const created = await svc.createConversation("work")
    expect(created.workspaceId).toBe("work")
    expect((await svc.getConversation(created.id))?.workspaceId).toBe("work")
    await expect(svc.createConversation("ghost")).rejects.toThrow(/Unknown workspace/)
  })
})
