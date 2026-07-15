import type { RegisteredToolDescriptor } from "../plugins/types"
import type { AgentServiceOptions, AiChatEvent } from "./agent-service"
import type { AiSettingsStore } from "./ai-settings-store"
import type { ApprovalStore } from "./approval-store"
import type { AiCredentialStore } from "./credential-store"
import type { ProviderDescriptor } from "./providers/catalog"
import type { ChatContentBlock, ChatProvider, TokenUsage } from "./providers/types"
import type { ToolHostPort } from "./tool-registry"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { AgentMissingKeyError, AgentService } from "./agent-service"
import { DEFAULT_TOOL_RESILIENCE } from "./ai-settings-store"
import { RootBudgetLedgerStore } from "./budget/root-budget-ledger"
import { ConversationStore } from "./conversation-store"
import { emptyUsage } from "./providers/types"
import { upsertRunTrace } from "./run-trace-store"
import { AgentRunStore } from "./runs/agent-run-store"
import { AiToolRegistry, modelToolName } from "./tool-registry"

// The durable pipeline (Task 13) needs a real, temp-dir-backed
// ConversationStore/AgentRunStore/RootBudgetLedgerStore per test — the lease/
// CAS/admission semantics under test are exactly what a hand-rolled in-memory
// fake would have to reimplement (and could silently get wrong). One shared
// tracking array + a single afterAll keeps every individual test's fixture
// setup synchronous, matching every other test in this file.
const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup only
    }
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function runStores(): Pick<AgentServiceOptions, "runStore" | "budgetStore" | "upsertTrace"> {
  const dir = tempDir("synapse-agent-service-runs-")
  return {
    runStore: new AgentRunStore(join(dir, "runs")),
    budgetStore: new RootBudgetLedgerStore(join(dir, "budget")),
    upsertTrace: (input) => upsertRunTrace(join(dir, "traces"), input),
  }
}

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
    provenance: "plugin",
    manifestTool: {
      name: "act",
      description: "Act",
      inputSchema: { type: "object", properties: {} },
      annotations,
    },
  } satisfies RegisteredToolDescriptor
}

const ACT_TOOL_NAME = modelToolName({ fqName: "com.x.demo/act", provenance: "plugin" })

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

function conversations(): { store: ConversationStore } {
  const dir = tempDir("synapse-agent-service-conv-")
  return { store: new ConversationStore(dir, () => 1000) }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Waits for an in-flight chat() to reach its first approval_request event.
 *  The durable pipeline does several real, sequentially-awaited fs writes
 *  (checkpoint create, batch create, approval-pending write) before ever
 *  emitting the event — a single event-loop tick isn't reliably enough, so
 *  this polls briefly rather than assuming one macrotask suffices. */
async function flush(events: AiChatEvent[], timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!events.some((event) => event.type === "approval_request")) {
    if (Date.now() - start > timeoutMs) return
    await tick()
  }
}

function service(options: {
  provider: ChatProvider
  host: ToolHostPort
  key?: string
  recordRun?: (trace: import("./run-trace-store").RunTrace) => void
  workspaces?: AgentServiceOptions["workspaces"]
  getToolHealth?: () => import("./tool-circuit-breaker").ToolStatSnapshot[]
  getLatestPlan?: (conversationId: string) => import("./plan/plan-types").PlanStep[] | undefined
  getExecutionWorkspaces?: (
    workspaceId: string
  ) => Promise<readonly import("./execution/types").WorkspaceRootRecord[]>
}): {
  service: AgentService
  events: AiChatEvent[]
  store: ConversationStore
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
    getLatestPlan: options.getLatestPlan,
    getExecutionWorkspaces: options.getExecutionWorkspaces,
    now: () => 1000,
    ...runStores(),
  })
  return { service: svc, events, store: convo.store }
}

function minimalService(overrides: Partial<AgentServiceOptions>): AgentService {
  return new AgentService({
    credentials: credentials("sk-test"),
    tools: new AiToolRegistry(fakeHost()),
    conversations: conversations().store,
    ...runStores(),
    sendEvent: () => {},
    ...overrides,
  })
}

describe("agentService", () => {
  it("auto-runs a read-only tool and streams events without asking", async () => {
    const host = fakeHost({ readOnlyHint: true })
    const {
      service: svc,
      events,
      store,
    } = service({
      host,
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: ACT_TOOL_NAME, input: { a: 1 } }] },
        { text: "all done" },
      ]),
    })

    const result = await svc.chat("c1", "go")

    expect(result.stopReason).toBe("end_turn")
    expect(host.invokeTool).toHaveBeenCalledOnce()
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "done"])
    expect(events.some((event) => event.type === "approval_request")).toBe(false)
    expect(await store.list()).toHaveLength(1)
    expect((await store.get("c1"))?.title).toBe("go")
  })

  it("asks for approval on a non-read-only tool and runs it once allowed", async () => {
    const host = fakeHost() // unannotated → must ask
    const { service: svc, events } = service({
      host,
      provider: fakeProvider([
        { toolUses: [{ id: "t1", name: ACT_TOOL_NAME, input: {} }] },
        { text: "done" },
      ]),
    })

    const done = svc.chat("c1", "go")
    await flush(events)

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
        { toolUses: [{ id: "t1", name: ACT_TOOL_NAME, input: {} }] },
        { text: "ok" },
      ]),
    })

    const done = svc.chat("c1", "go")
    await flush(events)
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
      ...runStores(),
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
            toolUses: [{ id: "a", name: ACT_TOOL_NAME, input: {} }],
            usage: { outputTokens: 80 },
          },
          { text: "should not reach" },
        ]),
      sendEvent: (event) => events.push(event),
      now: () => 1000,
      ...runStores(),
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
      ...runStores(),
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
          { toolUses: [{ id: "t1", name: ACT_TOOL_NAME, input: {} }] },
          { text: "done" },
        ]),
      approvals,
      sendEvent: (event) => events.push(event),
      now: () => 1000,
      ...runStores(),
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
      ...runStores(),
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
        { toolUses: [{ id: "t1", name: ACT_TOOL_NAME, input: {} }] },
        { toolUses: [{ id: "t2", name: ACT_TOOL_NAME, input: {} }] },
        { text: "done" },
      ]),
    })

    const done = svc.chat("c1", "go")
    await flush(events)
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
          toolUses: [{ id: "t1", name: ACT_TOOL_NAME, input: {} }],
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
      ...runStores(),
    })
    const next = { failureThreshold: 3, recoveryMs: 1000, timeoutMs: 5000 }
    await svc.setToolResilience(next)
    expect(setToolResilience).toHaveBeenCalledWith(next)
    expect(applied).toEqual([next])
  })

  it("sources the conversation's workspaceId into the run trace", async () => {
    const traces: import("./run-trace-store").RunTrace[] = []
    const { service: svc, store } = service({
      host: fakeHost({ readOnlyHint: true }),
      provider: fakeProvider([{ text: "done" }]),
      recordRun: (t) => traces.push(t),
      workspaces: {
        isActive: async (id) => id === "default" || id === "work",
        exists: async (id) => id === "default" || id === "work",
      },
    })
    await store.save({
      id: "c-work",
      workspaceId: "work",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })

    await svc.chat("c-work", "hello")

    expect(traces.at(-1)?.workspaceId).toBe("work")
  })

  it("chat() scopes executionWorkspaces to the conversation's own workspace", async () => {
    const seen: string[] = []
    const { service: svc, store } = service({
      host: fakeHost({ readOnlyHint: true }),
      provider: fakeProvider([{ text: "done" }]),
      getExecutionWorkspaces: async (workspaceId) => {
        seen.push(workspaceId)
        return workspaceId === "work"
          ? [
              {
                id: "root-a",
                workspaceId,
                name: "a",
                root: "/a",
                role: "primary" as const,
                createdAt: 1,
              },
            ]
          : []
      },
    })
    await store.save({
      id: "c-work",
      workspaceId: "work",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })

    await svc.chat("c-work", "hello")

    expect(seen).toEqual(["work"])
  })

  it("defaults a legacy conversation to workspaceId default in the trace", async () => {
    const traces: import("./run-trace-store").RunTrace[] = []
    const { service: svc, store } = service({
      host: fakeHost({ readOnlyHint: true }),
      provider: fakeProvider([{ text: "done" }]),
      recordRun: (t) => traces.push(t),
    })
    await store.save({
      id: "c-legacy",
      workspaceId: "default",
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })

    await svc.chat("c-legacy", "hi")

    expect(traces.at(-1)?.workspaceId).toBe("default")
  })

  it("createConversation binds the chosen workspace and rejects inactive ones", async () => {
    const { service: svc } = service({
      host: fakeHost(),
      provider: fakeProvider([{ text: "x" }]),
      workspaces: {
        isActive: async (id) => id === "default" || id === "work",
        exists: async (id) => id === "default" || id === "work",
      },
    })
    const created = await svc.createConversation("work")
    expect(created.workspaceId).toBe("work")
    expect((await svc.getConversation(created.id))?.workspaceId).toBe("work")
    await expect(svc.createConversation("ghost")).rejects.toThrow("Workspace is not active: ghost")
  })

  describe("workspace lifecycle wrappers", () => {
    const baseWorkspaces = {
      exists: async () => true,
      isActive: async () => true,
    }

    it("renameWorkspace delegates to the store", async () => {
      const renamed = { id: "w1", name: "Renamed", createdAt: 1 }
      const rename = vi.fn(async () => renamed)
      const svc = minimalService({ workspaces: { ...baseWorkspaces, rename } })
      await expect(svc.renameWorkspace("w1", "Renamed")).resolves.toEqual(renamed)
      expect(rename).toHaveBeenCalledWith("w1", "Renamed")
    })

    it("archiveWorkspace/unarchiveWorkspace delegate to the store", async () => {
      const archived = { id: "w1", name: "Work", createdAt: 1, archived: true as const }
      const unarchived = { id: "w1", name: "Work", createdAt: 1 }
      const archive = vi.fn(async () => archived)
      const unarchive = vi.fn(async () => unarchived)
      const svc = minimalService({ workspaces: { ...baseWorkspaces, archive, unarchive } })
      await expect(svc.archiveWorkspace("w1")).resolves.toEqual(archived)
      await expect(svc.unarchiveWorkspace("w1")).resolves.toEqual(unarchived)
      expect(archive).toHaveBeenCalledWith("w1")
      expect(unarchive).toHaveBeenCalledWith("w1")
    })

    it("listWorkspaces forwards includeArchived", async () => {
      const list = vi.fn(async () => [])
      const svc = minimalService({ workspaces: { ...baseWorkspaces, list } })
      await svc.listWorkspaces({ includeArchived: true })
      expect(list).toHaveBeenCalledWith({ includeArchived: true })
    })
  })

  describe("createConversation — archived workspace", () => {
    it("rejects creating a conversation in an archived workspace", async () => {
      const { service: svc } = service({
        host: fakeHost(),
        provider: fakeProvider([{ text: "x" }]),
        workspaces: {
          isActive: async (id) => id !== "archived-ws",
          exists: async () => true,
        },
      })
      await expect(svc.createConversation("archived-ws")).rejects.toThrow(
        "Workspace is not active: archived-ws"
      )
    })
  })

  describe("workspace root management", () => {
    it("listWorkspaceRoots delegates to the store", async () => {
      const calls: string[] = []
      const svc = minimalService({
        workspaceRoots: {
          listForWorkspace: async (id: string) => {
            calls.push(id)
            return [
              {
                id: "r1",
                workspaceId: id,
                name: "R",
                root: "/r",
                role: "primary" as const,
                createdAt: 1,
              },
            ]
          },
        },
      })
      const roots = await svc.listWorkspaceRoots("w1")
      expect(calls).toEqual(["w1"])
      expect(roots).toHaveLength(1)
    })

    it("createWorkspaceRoot delegates to the store and refreshes execution tool visibility", async () => {
      let refreshed = false
      const svc = minimalService({
        workspaceRoots: {
          create: async (workspaceId, name, root, role) => ({
            id: "new",
            workspaceId,
            name,
            root,
            role,
            createdAt: 1,
          }),
        },
        onWorkspaceRootsChanged: () => {
          refreshed = true
        },
        isAgentShellAllowed: () => true,
      })
      const record = await svc.createWorkspaceRoot("w1", "Root", "/root", "primary")
      expect(record.id).toBe("new")
      expect(refreshed).toBe(true)
    })

    it("createWorkspaceRoot rejects when agent shell is disabled", async () => {
      const svc = minimalService({
        workspaceRoots: {
          create: async () => ({
            id: "new",
            workspaceId: "w1",
            name: "R",
            root: "/r",
            role: "primary" as const,
            createdAt: 1,
          }),
        },
        isAgentShellAllowed: () => false,
      })
      await expect(svc.createWorkspaceRoot("w1", "Root", "/root", "primary")).rejects.toThrow(
        /agent shell is disabled/
      )
    })

    it("removeWorkspaceRoot delegates to the store and refreshes execution tool visibility", async () => {
      let refreshed = false
      let removedId: string | undefined
      const svc = minimalService({
        workspaceRoots: {
          remove: async (id: string) => {
            removedId = id
          },
        },
        onWorkspaceRootsChanged: () => {
          refreshed = true
        },
      })
      await svc.removeWorkspaceRoot("r1")
      expect(removedId).toBe("r1")
      expect(refreshed).toBe(true)
    })

    it("setPrimaryWorkspaceRoot delegates to the store", async () => {
      let promotedId: string | undefined
      const svc = minimalService({
        workspaceRoots: {
          setPrimary: async (id: string) => {
            promotedId = id
          },
        },
      })
      await svc.setPrimaryWorkspaceRoot("r1")
      expect(promotedId).toBe("r1")
    })
  })

  it("getConversation attaches the latest recorded plan for that conversation", async () => {
    const plan = [
      { title: "step 1", status: "completed" as const },
      { title: "step 2", status: "in_progress" as const },
    ]
    const { service: svc } = service({
      host: fakeHost(),
      provider: fakeProvider([{ text: "x" }]),
      getLatestPlan: (id) => (id === "c1" ? plan : undefined),
    })
    await svc.chat("c1", "go")

    expect((await svc.getConversation("c1"))?.plan).toEqual(plan)
  })

  it("getConversation omits plan when getLatestPlan finds nothing", async () => {
    const { service: svc } = service({
      host: fakeHost(),
      provider: fakeProvider([{ text: "x" }]),
      getLatestPlan: () => undefined,
    })
    await svc.chat("c1", "go")

    expect((await svc.getConversation("c1"))?.plan).toBeUndefined()
  })

  it("getConversation works when getLatestPlan is not configured at all", async () => {
    const { service: svc } = service({
      host: fakeHost(),
      provider: fakeProvider([{ text: "x" }]),
    })
    await svc.chat("c1", "go")

    expect((await svc.getConversation("c1"))?.plan).toBeUndefined()
  })

  describe("startup readiness barrier", () => {
    it("chat() works unchanged when reconcileRunsAtStartup was never called", async () => {
      const { service: svc } = service({
        host: fakeHost(),
        provider: fakeProvider([{ text: "x" }]),
      })
      const result = await svc.chat("c1", "go")
      expect(result.stopReason).toBeDefined()
    })

    it("chat() awaits an in-flight reconcileRunsAtStartup() before starting a new turn", async () => {
      const { service: svc } = service({
        host: fakeHost(),
        provider: fakeProvider([{ text: "x" }]),
      })
      const order: string[] = []
      let resolveScan: () => void = () => {}
      const scanPromise = new Promise<void>((resolve) => {
        resolveScan = () => {
          order.push("scan-resolved")
          resolve()
        }
      })

      const reconciled = svc.reconcileRunsAtStartup({
        listRecoverable: async () => {
          order.push("scan-started")
          await scanPromise
          return []
        },
      })

      const chatPromise = svc.chat("c1", "go").then((r) => {
        order.push("chat-resolved")
        return r
      })

      // Give the scan a tick to actually start before releasing it.
      await Promise.resolve()
      await Promise.resolve()
      resolveScan()

      await reconciled
      await chatPromise
      expect(order).toEqual(["scan-started", "scan-resolved", "chat-resolved"])
    })

    it("reconcileRunsAtStartup() only runs the scan once across repeated calls", async () => {
      const { service: svc } = service({
        host: fakeHost(),
        provider: fakeProvider([{ text: "x" }]),
      })
      const listRecoverable = vi.fn(async () => [])
      await svc.reconcileRunsAtStartup({ listRecoverable })
      await svc.reconcileRunsAtStartup({ listRecoverable })
      await svc.chat("c1", "go")
      expect(listRecoverable).toHaveBeenCalledTimes(1)
    })
  })

  describe("durable pipeline — concurrency, cancellation, and restart", () => {
    function hangingProvider(): ChatProvider & { started: Promise<void> } {
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      return {
        id: "hanging",
        started,
        async *stream(req) {
          markStarted()
          await new Promise((_, reject) => {
            if (req.signal?.aborted) {
              reject(req.signal.reason ?? new Error("aborted"))
              return
            }
            req.signal?.addEventListener("abort", () =>
              reject(req.signal!.reason ?? new Error("aborted"))
            )
          })
          yield {
            type: "message" as const,
            message: { role: "assistant" as const, content: [] },
            usage: emptyUsage(),
            stopReason: "end_turn",
          }
        },
      }
    }

    it("rejects a second concurrent chat() on the same conversation while the first is in flight", async () => {
      const { service: svc } = service({
        host: fakeHost({ readOnlyHint: true }),
        provider: fakeProvider([{ text: "first done" }]),
      })

      const first = svc.chat("c1", "go")
      // The first call's setupInteractiveRun (which acquires the lease) races
      // its own async fs writes against this second call — give it a couple
      // of ticks to actually acquire the lease before racing the second.
      await tick()
      await tick()
      const second = svc.chat("c1", "also go")
      // Observed immediately so Node doesn't flag it unhandled while `first`
      // (which takes the whole turn) is still pending below.
      second.catch(() => {})

      await expect(first).resolves.toMatchObject({ stopReason: "end_turn" })
      await expect(second).rejects.toThrow()
    })

    it("cancel() during an in-flight provider call makes chat() settle instead of hanging, without breaking later turns", async () => {
      let currentProvider: ChatProvider = hangingProvider()
      const events: AiChatEvent[] = []
      const svc = new AgentService({
        credentials: credentials("sk-test"),
        tools: new AiToolRegistry(fakeHost({ readOnlyHint: true })),
        conversations: conversations().store,
        createProvider: () => currentProvider,
        sendEvent: (event) => events.push(event),
        now: () => 1000,
        ...runStores(),
      })

      const done = svc.chat("c1", "go")
      await (currentProvider as ChatProvider & { started: Promise<void> }).started
      svc.cancel("c1")

      await expect(done).rejects.toThrow()
      expect(events.some((event) => event.type === "error")).toBe(true)

      // The service as a whole is still healthy: an unrelated conversation
      // can still complete a normal turn afterward.
      currentProvider = fakeProvider([{ text: "hi" }])
      const result = await svc.chat("c2", "hello")
      expect(result.stopReason).toBe("end_turn")
    })

    it("deleteConversation cancels an in-flight turn and still removes the conversation", async () => {
      let currentProvider: ChatProvider = hangingProvider()
      const convo = conversations()
      const svc = new AgentService({
        credentials: credentials("sk-test"),
        tools: new AiToolRegistry(fakeHost({ readOnlyHint: true })),
        conversations: convo.store,
        createProvider: () => currentProvider,
        sendEvent: () => {},
        now: () => 1000,
        ...runStores(),
      })

      const done = svc.chat("c1", "go")
      // Observed immediately: deleteConversation's own real fs delete()
      // introduces enough of a delay before we await `done` below that
      // Node can otherwise flag its (eventually-handled) rejection.
      done.catch(() => {})
      await (currentProvider as ChatProvider & { started: Promise<void> }).started
      await svc.deleteConversation("c1")

      await expect(done).rejects.toThrow()
      expect(await convo.store.get("c1")).toBeUndefined()

      // The service is still healthy afterward.
      currentProvider = fakeProvider([{ text: "hi" }])
      const result = await svc.chat("c2", "hello")
      expect(result.stopReason).toBe("end_turn")
    })

    it("resolveApproval is a safe no-op when called again (e.g. after a renderer reload re-sends the click)", async () => {
      const host = fakeHost() // unannotated → must ask
      const { service: svc, events } = service({
        host,
        provider: fakeProvider([
          { toolUses: [{ id: "t1", name: ACT_TOOL_NAME, input: {} }] },
          { text: "done" },
        ]),
      })

      const done = svc.chat("c1", "go")
      await flush(events)
      const request = events.find((event) => event.type === "approval_request")
      if (request?.type !== "approval_request") throw new Error("expected approval request")

      // Simulates the renderer reloading and losing track of whether it
      // already resolved this approval — resolving twice must not throw or
      // double-invoke the tool.
      await expect(svc.resolveApproval(request.approvalId, true)).resolves.toBeUndefined()
      await expect(svc.resolveApproval(request.approvalId, true)).resolves.toBeUndefined()
      await done

      expect(host.invokeTool).toHaveBeenCalledOnce()
    })

    it("restart (a fresh AgentService over the same stores) sees a completed turn with no duplicated messages", async () => {
      const convo = conversations()
      const stores = runStores()
      const events1: AiChatEvent[] = []
      const svc1 = new AgentService({
        credentials: credentials("sk-test"),
        tools: new AiToolRegistry(fakeHost({ readOnlyHint: true })),
        conversations: convo.store,
        createProvider: () => fakeProvider([{ text: "first reply" }]),
        sendEvent: (event) => events1.push(event),
        now: () => 1000,
        ...stores,
      })

      await svc1.chat("c1", "first message")
      const afterFirst = await convo.store.get("c1")
      expect(afterFirst?.messages).toHaveLength(2)

      // A brand-new AgentService instance, as if the app restarted, reusing
      // the same durable stores.
      const events2: AiChatEvent[] = []
      const svc2 = new AgentService({
        credentials: credentials("sk-test"),
        tools: new AiToolRegistry(fakeHost({ readOnlyHint: true })),
        conversations: convo.store,
        createProvider: () => fakeProvider([{ text: "second reply" }]),
        sendEvent: (event) => events2.push(event),
        now: () => 2000,
        ...stores,
      })

      expect((await svc2.getConversation("c1"))?.messages).toHaveLength(2)

      await svc2.chat("c1", "second message")
      const afterSecond = await convo.store.get("c1")
      expect(afterSecond?.messages).toHaveLength(4)
      expect(afterSecond?.messages.map((m) => m.content[0])).toEqual([
        { type: "text", text: "first message" },
        { type: "text", text: "first reply" },
        { type: "text", text: "second message" },
        { type: "text", text: "second reply" },
      ])
    })
  })
})
