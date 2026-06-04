import type { RegisteredToolDescriptor } from "../plugins/types"
import type { AiChatEvent } from "./agent-service"
import type { AiSettingsStore } from "./ai-settings-store"
import type { ConversationStore, StoredConversation } from "./conversation-store"
import type { AiCredentialStore } from "./credential-store"
import type { ProviderDescriptor } from "./providers/catalog"
import type { ChatContentBlock, ChatProvider } from "./providers/types"
import type { ToolHostPort } from "./tool-registry"
import { describe, expect, it, vi } from "vitest"
import { AgentMissingKeyError, AgentService } from "./agent-service"
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
        usage: emptyUsage(),
        stopReason: turn.toolUses?.length ? "tool_use" : "end_turn",
      }
    },
  }
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
    get: async () => undefined,
    save: async (conversation: StoredConversation) => {
      saved.push(conversation)
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

function service(options: { provider: ChatProvider; host: ToolHostPort; key?: string }): {
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
    createProvider: () => options.provider,
    sendEvent: (event) => events.push(event),
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
})
