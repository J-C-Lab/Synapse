import type { AgentRunEvent, AgentRunSnapshot } from "@synapse/agent-protocol"
import type { PropsWithChildren } from "react"
import type { AiChatMessage } from "@/lib/electron"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatPage } from "./chat-page"

const electron = vi.hoisted(() => ({
  approveAiTool: vi.fn(),
  createAiConversation: vi.fn(),
  deleteAiConversation: vi.fn(),
  getAiConversation: vi.fn(),
  getAiStatus: vi.fn(),
  getArtifactStatus: vi.fn(),
  getRunEventsSince: vi.fn(),
  getRunSnapshot: vi.fn(),
  isElectron: vi.fn(),
  listAiConversations: vi.fn(),
  listRecoverableRuns: vi.fn(),
  onRunEvent: vi.fn(),
  sendAiChat: vi.fn(),
  setAiKey: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { tool?: string }) =>
      key === "chat.approvalBody" ? `approval ${values?.tool ?? ""}` : key,
  }),
}))

vi.mock("@/lib/electron", () => electron)
vi.mock("@/components/ai-settings-dialog", () => ({ AiSettingsDialog: () => null }))
vi.mock("@/components/assistant-onboarding", () => ({ AssistantOnboarding: () => null }))
vi.mock("@/components/conversation-sidebar", () => ({
  ConversationSidebar: ({
    conversations,
    onSelect,
  }: {
    conversations: { id: string; title?: string }[]
    onSelect: (id: string) => void
  }) => (
    <div>
      {conversations.map((conversation) => (
        <button key={conversation.id} type="button" onClick={() => onSelect(conversation.id)}>
          {conversation.title ?? conversation.id}
        </button>
      ))}
    </div>
  ),
}))
vi.mock("@/components/markdown", () => ({
  Markdown: ({ children }: PropsWithChildren) => <>{children}</>,
}))
vi.mock("@/components/mcp-servers-dialog", () => ({ McpServersDialog: () => null }))
vi.mock("@/components/memory-dialog", () => ({ MemoryDialog: () => null }))
vi.mock("@/components/PlanPanel", () => ({ PlanPanel: () => null }))
vi.mock("@/components/ui/resizable", () => ({
  ResizableHandle: () => null,
  ResizablePanel: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))
vi.mock("@/components/workspace-switcher", () => ({ WorkspaceSwitcher: () => null }))

let listeners: Array<(event: AgentRunEvent) => void>
let currentSnapshot: AgentRunSnapshot | undefined
let conversationMessages: AiChatMessage[]

function snapshot(overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
  return {
    identity: {
      runId: "run-1",
      rootRunId: "run-1",
      origin: "interactive",
      conversationId: "c1",
    },
    status: "waiting_approval",
    recovery: { kind: "automatic" },
    lastSequence: 1,
    createdAt: 1,
    updatedAt: 1,
    pendingApprovalIds: ["approval-1"],
    childTasks: [],
    artifacts: [],
    messages: [],
    toolCalls: [
      {
        ordinal: 0,
        modelStep: 0,
        toolUseId: "tool-1",
        safeName: "write_file",
        fqName: "plugin.test/write_file",
        status: "pending_approval",
      },
    ],
    ...overrides,
  }
}

function emit(event: AgentRunEvent): void {
  for (const listener of listeners) listener(event)
}

function runEvent(
  type: AgentRunEvent["type"],
  overrides: Record<string, unknown> = {}
): AgentRunEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${type}`,
    runId: "run-1",
    rootRunId: "run-1",
    conversationId: "c1",
    sequence: 2,
    timestamp: 2,
    persisted: type !== "text_delta",
    type,
    ...overrides,
  } as AgentRunEvent
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  listeners = []
  currentSnapshot = snapshot()
  conversationMessages = []
  electron.isElectron.mockReturnValue(true)
  electron.getAiStatus.mockResolvedValue({ hasKey: true, provider: "anthropic", model: "test" })
  electron.listAiConversations.mockResolvedValue([])
  electron.getAiConversation.mockImplementation(async () => ({
    id: "c1",
    workspaceId: "default",
    messages: conversationMessages,
  }))
  electron.listRecoverableRuns.mockResolvedValue([
    {
      runId: "run-1",
      rootRunId: "run-1",
      origin: "interactive",
      conversationId: "c1",
      status: "waiting_approval",
      recovery: { kind: "automatic" },
      createdAt: 1,
      updatedAt: 1,
    },
  ])
  electron.getRunSnapshot.mockImplementation(async () => currentSnapshot)
  electron.getRunEventsSince.mockResolvedValue([])
  electron.getArtifactStatus.mockResolvedValue({ status: "unavailable", code: "artifact_missing" })
  electron.onRunEvent.mockImplementation((listener: (event: AgentRunEvent) => void) => {
    listeners.push(listener)
    return () => {
      listeners = listeners.filter((candidate) => candidate !== listener)
    }
  })
  electron.createAiConversation.mockResolvedValue({ id: "c1", workspaceId: "default" })
  electron.sendAiChat.mockResolvedValue({ stopReason: "end_turn", usage: {} })
  electron.approveAiTool.mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe("chatPage durable reload recovery", () => {
  it("rebuilds a pending approval from a snapshot when the live event was missed, then approves it", async () => {
    render(<ChatPage initialConversationId="c1" />)

    // No approval_pending event is sent: the only source is the durable
    // snapshot fetched by the renderer after its reload.
    expect(await screen.findByText("chat.approvalTitle")).toBeInTheDocument()
    expect(screen.getByText("approval write_file")).toBeInTheDocument()
    expect(screen.queryByText(/secret|input/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "chat.allow" }))
    await waitFor(() =>
      expect(electron.approveAiTool).toHaveBeenCalledWith("approval-1", true, "once")
    )
  })

  it("restores the active conversation across a renderer reload without an initial prop", async () => {
    const firstRenderer = render(<ChatPage initialConversationId="c1" />)
    expect(await screen.findByText("chat.approvalTitle")).toBeInTheDocument()
    firstRenderer.unmount()

    // AppShell has been recreated by the reload and no longer has its
    // one-shot pending id. ChatPage must still attach to the persisted active
    // conversation and retrieve its live durable run.
    render(<ChatPage />)
    expect(await screen.findByText("chat.approvalTitle")).toBeInTheDocument()
    expect(electron.listRecoverableRuns).toHaveBeenCalledTimes(2)
    expect(electron.getRunSnapshot).toHaveBeenCalledWith("run-1")
  })

  it("keeps an uncreated draft unlocked after reload so send creates a real conversation", async () => {
    electron.getAiConversation.mockResolvedValue(undefined)
    electron.listRecoverableRuns.mockResolvedValue([])

    const firstRenderer = render(<ChatPage />)
    expect(await screen.findByPlaceholderText("chat.placeholder")).toBeInTheDocument()
    firstRenderer.unmount()

    render(<ChatPage />)
    const composer = await screen.findByPlaceholderText("chat.placeholder")
    await userEvent.type(composer, "create after reload")
    await userEvent.click(screen.getByRole("button", { name: "chat.send" }))

    await waitFor(() => expect(electron.createAiConversation).toHaveBeenCalledTimes(1))
    expect(electron.sendAiChat).toHaveBeenCalledWith("c1", "create after reload")
  })

  it("clears a missing persisted conversation id and leaves the draft unlocked", async () => {
    window.sessionStorage.setItem("synapse.active-cortex-conversation", "deleted-conversation")
    electron.getAiConversation.mockResolvedValue(undefined)
    electron.listRecoverableRuns.mockResolvedValue([])

    render(<ChatPage />)
    const composer = await screen.findByPlaceholderText("chat.placeholder")
    await waitFor(() =>
      expect(electron.getAiConversation).toHaveBeenCalledWith("deleted-conversation")
    )
    expect(window.sessionStorage.getItem("synapse.active-cortex-conversation")).toBeNull()

    await userEvent.type(composer, "recreate deleted conversation")
    await userEvent.click(screen.getByRole("button", { name: "chat.send" }))
    await waitFor(() => expect(electron.createAiConversation).toHaveBeenCalledTimes(1))
  })

  it("persists a newly created conversation before starting its first run", async () => {
    let persistedIdWhenRunStarted: string | null = null
    electron.createAiConversation.mockResolvedValue({ id: "created-c1", workspaceId: "default" })
    electron.sendAiChat.mockImplementation(async () => {
      // This callback runs in the same synchronous continuation as
      // createAiConversation's result, before React can commit
      // setConversationId and run its persistence effect.
      persistedIdWhenRunStarted = window.sessionStorage.getItem(
        "synapse.active-cortex-conversation"
      )
      return { stopReason: "end_turn", usage: {} }
    })

    render(<ChatPage />)
    const composer = await screen.findByPlaceholderText("chat.placeholder")
    window.sessionStorage.setItem("synapse.active-cortex-conversation", "uncreated-draft")
    await userEvent.type(composer, "start durable run")
    await userEvent.click(screen.getByRole("button", { name: "chat.send" }))

    await waitFor(() =>
      expect(electron.sendAiChat).toHaveBeenCalledWith("created-c1", "start durable run")
    )
    expect(persistedIdWhenRunStarted).toBe("created-c1")
  })

  it("keeps only the latest conversation selection when earlier IPC reads resolve late", async () => {
    let resolveC2: (value: unknown) => void = () => {}
    let resolveC3: (value: unknown) => void = () => {}
    const c2 = new Promise((resolve) => {
      resolveC2 = resolve
    })
    const c3 = new Promise((resolve) => {
      resolveC3 = resolve
    })
    electron.listAiConversations.mockResolvedValue([
      { id: "c2", title: "c2", workspaceId: "default" },
      { id: "c3", title: "c3", workspaceId: "default" },
    ])
    electron.getAiConversation.mockImplementation((id: string) => {
      if (id === "c2") return c2
      if (id === "c3") return c3
      return Promise.resolve({ id: "c1", workspaceId: "default", messages: [] })
    })
    currentSnapshot = snapshot({ status: "running", pendingApprovalIds: [], toolCalls: [] })

    render(<ChatPage initialConversationId="c1" />)
    fireEvent.click(await screen.findByRole("button", { name: "c2" }))
    fireEvent.click(screen.getByRole("button", { name: "c3" }))

    await act(async () => {
      resolveC3({
        id: "c3",
        workspaceId: "default",
        messages: [{ role: "assistant", content: [{ type: "text", text: "latest c3" }] }],
      })
    })
    expect(await screen.findByText("latest c3")).toBeInTheDocument()

    await act(async () => {
      resolveC2({
        id: "c2",
        workspaceId: "default",
        messages: [{ role: "assistant", content: [{ type: "text", text: "stale c2" }] }],
      })
      await Promise.resolve()
    })
    expect(screen.queryByText("stale c2")).not.toBeInTheDocument()

    act(() => emit(runEvent("approval_pending", { approvalId: "old-c1", safeName: "write_file" })))
    expect(screen.queryByText("chat.approvalTitle")).not.toBeInTheDocument()
  })

  it("keeps the send fence while an older recoverable-run lookup rejects during a newer selection", async () => {
    let rejectC2Recoverable: (reason?: unknown) => void = () => {}
    const c2Recoverable = new Promise<never>((_resolve, reject) => {
      rejectC2Recoverable = reject
    })
    const c3 = new Promise<never>(() => {})
    electron.listAiConversations.mockResolvedValue([
      { id: "c2", title: "c2", workspaceId: "default" },
      { id: "c3", title: "c3", workspaceId: "default" },
    ])
    electron.getAiConversation.mockImplementation((id: string) => {
      if (id === "c2") return Promise.resolve({ id: "c2", workspaceId: "default", messages: [] })
      if (id === "c3") return c3
      return Promise.resolve({ id: "c1", workspaceId: "default", messages: [] })
    })
    let recoverableLookupCount = 0
    electron.listRecoverableRuns.mockImplementation(() => {
      recoverableLookupCount++
      return recoverableLookupCount === 2 ? c2Recoverable : Promise.resolve([])
    })
    currentSnapshot = snapshot({ status: "running", pendingApprovalIds: [], toolCalls: [] })

    render(<ChatPage initialConversationId="c1" />)
    await waitFor(() => expect(electron.listRecoverableRuns).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole("button", { name: "c2" }))
    await waitFor(() => expect(electron.listRecoverableRuns).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole("button", { name: "c3" }))

    await act(async () => {
      rejectC2Recoverable(new Error("c2 recoverable lookup rejected"))
      await Promise.resolve()
    })

    fireEvent.change(screen.getByPlaceholderText("chat.placeholder"), {
      target: { value: "must not send during c3 selection" },
    })
    fireEvent.click(screen.getByRole("button", { name: "chat.send" }))
    expect(electron.createAiConversation).not.toHaveBeenCalled()
    expect(electron.sendAiChat).not.toHaveBeenCalled()
  })

  it("binds a reload-era streaming placeholder to later live deltas and refreshes the canonical transcript at terminal", async () => {
    currentSnapshot = snapshot({
      status: "running",
      pendingApprovalIds: [],
      toolCalls: [],
      currentModelStep: { step: 0, state: "dispatched" },
    })
    render(<ChatPage initialConversationId="c1" />)

    await waitFor(() => expect(electron.getRunSnapshot).toHaveBeenCalledWith("run-1"))
    act(() => emit(runEvent("text_delta", { text: "delta after reload", persisted: false })))
    expect(await screen.findByText("delta after reload")).toBeInTheDocument()

    conversationMessages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "canonical completed response" }] },
    ]
    act(() => emit(runEvent("run_completed", { outcome: "completed" })))
    expect(await screen.findByText("canonical completed response")).toBeInTheDocument()
  })

  it("rehydrates the canonical transcript from a terminal snapshot without a live terminal event", async () => {
    currentSnapshot = snapshot({
      status: "completed",
      pendingApprovalIds: [],
      toolCalls: [],
      messages: [
        {
          messageId: "staged-assistant",
          producedByRunId: "run-1",
          role: "assistant",
          ordinal: 0,
          text: "stale snapshot text",
        },
      ],
    })
    conversationMessages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "canonical after reload" }] },
    ]

    render(<ChatPage initialConversationId="c1" />)

    expect(await screen.findByText("canonical after reload")).toBeInTheDocument()
    // Selection performs one normal transcript read; terminal snapshot
    // recovery performs the second, with no run_completed event injected.
    await waitFor(() =>
      expect(electron.getAiConversation.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
    expect(screen.queryByText("stale snapshot text")).not.toBeInTheDocument()
  })

  it("ignores a terminal transcript read rejected during IPC teardown", async () => {
    render(<ChatPage initialConversationId="c1" />)
    expect(await screen.findByText("chat.approvalTitle")).toBeInTheDocument()
    electron.getAiConversation.mockRejectedValueOnce(new Error("renderer closing"))

    act(() => emit(runEvent("run_completed", { outcome: "completed" })))
    await waitFor(() => expect(electron.getAiConversation).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("ignores an initial run snapshot read rejected during IPC teardown", async () => {
    electron.getRunSnapshot.mockRejectedValue(new Error("renderer closing"))
    render(<ChatPage initialConversationId="c1" />)

    await waitFor(() => expect(electron.getRunSnapshot).toHaveBeenCalledWith("run-1"))
    expect(screen.queryByText("chat.approvalTitle")).not.toBeInTheDocument()
  })

  it("absorbs background conversation, status, and artifact IPC teardown failures", async () => {
    electron.listAiConversations.mockRejectedValue(new Error("renderer closing"))
    electron.getAiStatus.mockRejectedValue(new Error("renderer closing"))
    electron.getArtifactStatus.mockRejectedValue(new Error("renderer closing"))
    conversationMessages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-artifact", name: "read_file", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tool-artifact",
            content: "artifact preview",
            artifact: {
              uri: "artifact://run/run-1/teardown",
              kind: "tool-result",
              mediaType: "text/plain",
              capturedBytes: 16,
              complete: true,
            },
          },
        ],
      },
    ]
    currentSnapshot = snapshot({
      status: "running",
      pendingApprovalIds: [],
      toolCalls: [],
    })

    render(<ChatPage initialConversationId="c1" />)
    await waitFor(() =>
      expect(electron.getArtifactStatus).toHaveBeenCalledWith("artifact://run/run-1/teardown")
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("clears a stale approval when the next durable snapshot has no pending approval", async () => {
    render(<ChatPage initialConversationId="c1" />)
    expect(await screen.findByText("chat.approvalTitle")).toBeInTheDocument()

    currentSnapshot = snapshot({
      identity: {
        runId: "run-2",
        rootRunId: "run-2",
        origin: "interactive",
        conversationId: "c1",
      },
      status: "running",
      pendingApprovalIds: [],
      toolCalls: [],
    })
    // This only changes the active run. It deliberately does not resolve the
    // approval live, so the snapshot effect itself must dismiss the old UI.
    act(() =>
      emit(runEvent("run_started", { runId: "run-2", rootRunId: "run-2", origin: "interactive" }))
    )

    await waitFor(() => expect(electron.getRunSnapshot).toHaveBeenCalledWith("run-2"))
    await waitFor(() => expect(screen.queryByText("chat.approvalTitle")).not.toBeInTheDocument())
  })

  it("handles a pre-run setup rejection without an unhandled promise or empty assistant bubble", async () => {
    electron.listRecoverableRuns.mockResolvedValue([])
    electron.sendAiChat.mockRejectedValue(new Error("provider setup failed"))
    render(<ChatPage />)

    const composer = await screen.findByPlaceholderText("chat.placeholder")
    await userEvent.type(composer, "start a run")
    await userEvent.click(screen.getByRole("button", { name: "chat.send" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("chat.startFailed")
  })
})
