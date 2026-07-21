import type { AgentRunEvent, AgentRunSnapshot } from "@synapse/agent-protocol"
import type { ImperativePanelHandle } from "react-resizable-panels"
import type { ArtifactAvailability, DisplayMessage, ToolCard } from "./chat-message-model"
import type { PlanStep } from "@/components/PlanPanel"
import type { AiConversationSummary, AiStatus, AiTokenUsage } from "@/lib/electron"
import {
  ArrowUp,
  Boxes,
  Brain,
  BrainCircuit,
  ChevronDown,
  Loader2,
  Mic,
  PanelLeft,
  Paperclip,
  Play,
  Plug,
  Plus,
  Scroll,
  Server,
  Settings,
  Wrench,
} from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AiSettingsDialog } from "@/components/ai-settings-dialog"
import { AssistantOnboarding } from "@/components/assistant-onboarding"
import { ConversationSidebar } from "@/components/conversation-sidebar"
import { Markdown } from "@/components/markdown"
import { McpServersDialog } from "@/components/mcp-servers-dialog"
import { MemoryDialog } from "@/components/memory-dialog"
import { PlanPanel } from "@/components/PlanPanel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Textarea } from "@/components/ui/textarea"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import { useRunSnapshot } from "@/hooks/use-run-snapshot"
import {
  approveAiTool,
  createAiConversation,
  deleteAiConversation,
  getAiConversation,
  getAiStatus,
  getArtifactStatus,
  isElectron,
  listAiConversations,
  listRecoverableRuns,
  onRunEvent,
  sendAiChat,
  setAiKey,
} from "@/lib/electron"
import { cn } from "@/lib/utils"
import {
  applyEvent,
  flushTextIntoBlocks,
  hydrateMessages,
  mergeDurableRunSnapshot,
} from "./chat-message-model"

interface PendingApproval {
  approvalId: string
  toolName: string
}

/**
 * A snapshot deliberately exposes approval ids separately from tool-call
 * summaries. run-projection creates both in checkpoint scan order, so this
 * positional pairing is the shared-protocol equivalent of the live
 * approval_pending event. It never reads or reconstructs host-only tool
 * input.
 */
function firstPendingApproval(
  snapshot: AgentRunSnapshot,
  ignored: ReadonlySet<string>
): PendingApproval | null {
  const pendingCalls = snapshot.toolCalls.filter((call) => call.status === "pending_approval")
  for (const [index, approvalId] of snapshot.pendingApprovalIds.entries()) {
    if (ignored.has(approvalId)) continue
    const call = pendingCalls[index]
    if (call) return { approvalId, toolName: call.safeName }
  }
  return null
}

function isTerminalSnapshot(snapshot: AgentRunSnapshot): boolean {
  return ["completed", "cancelled", "failed"].includes(snapshot.status)
}

function streamingPlaceholderId(snapshot: AgentRunSnapshot): string | undefined {
  if (isTerminalSnapshot(snapshot)) return undefined
  const step = snapshot.currentModelStep
  if (!step || ["response_staged", "budget_settled"].includes(step.state)) return undefined
  return `durable-run:${snapshot.identity.runId}:stream:${step.step}`
}

// AppShell's resume prop is intentionally one-shot: it is cleared after the
// lazy ChatPage consumes it. A renderer reload recreates AppShell, so retain
// the actually active Cortex conversation separately for the same window.
// sessionStorage survives reload but does not make an old conversation the
// default across unrelated app launches.
const ACTIVE_CORTEX_CONVERSATION_KEY = "synapse.active-cortex-conversation"

function readActiveCortexConversation(): string | undefined {
  try {
    return window.sessionStorage.getItem(ACTIVE_CORTEX_CONVERSATION_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function persistActiveCortexConversation(conversationId: string): void {
  try {
    window.sessionStorage.setItem(ACTIVE_CORTEX_CONVERSATION_KEY, conversationId)
  } catch {
    // A locked-down renderer can still run a fresh conversation; persistence
    // is only a reload convenience and must not block chat itself.
  }
}

function clearPersistedActiveCortexConversation(conversationId: string): void {
  try {
    if (window.sessionStorage.getItem(ACTIVE_CORTEX_CONVERSATION_KEY) === conversationId) {
      window.sessionStorage.removeItem(ACTIVE_CORTEX_CONVERSATION_KEY)
    }
  } catch {
    // Best-effort cleanup only; a missing persisted id still remains an
    // unlocked draft in component state even if browser storage is unavailable.
  }
}

export function ChatPage({
  initialConversationId,
  onInitialConversationConsumed,
}: {
  initialConversationId?: string
  onInitialConversationConsumed?: () => void
} = {}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState("")
  const [savingKey, setSavingKey] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<AiTokenUsage | null>(null)
  const [approval, setApproval] = useState<PendingApproval | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [showMcp, setShowMcp] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSidebar, setShowSidebar] = useState(true)
  const [conversations, setConversations] = useState<AiConversationSummary[]>([])
  const restoredConversationIdRef = useRef(initialConversationId ?? readActiveCortexConversation())
  const [conversationId, setConversationId] = useState<string>(
    () => restoredConversationIdRef.current ?? crypto.randomUUID()
  )
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("default")
  const [conversationLocked, setConversationLocked] = useState(false)
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([])
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [liveText, setLiveText] = useState("")
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const liveTextRef = useRef("")
  const liveTextRafRef = useRef<number | null>(null)
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null)
  const mountedRef = useRef(true)
  const conversationIdRef = useRef(conversationId)
  const conversationSelectionGenerationRef = useRef(0)
  const selectingConversationRef = useRef(false)
  const resolvedApprovalIdsRef = useRef<Set<string>>(new Set())
  // Event handlers outlive the render that installed them. Keep the current
  // stream target in a ref as well so a terminal event flushes live text into
  // the reload-created placeholder instead of whichever assistant bubble was
  // appended most recently.
  const streamingMessageIdRef = useRef<string | null>(null)
  const terminalSnapshotRunIdRef = useRef<string | undefined>(undefined)
  const runSnapshot = useRunSnapshot(activeRunId)

  const updateStreamingMessageId = useCallback((id: string | null) => {
    streamingMessageIdRef.current = id
    setStreamingMessageId(id)
  }, [])

  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    persistActiveCortexConversation(conversationId)
  }, [conversationId])

  useEffect(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return
    if (showSidebar) panel.expand()
    else panel.collapse()
  }, [showSidebar])

  const refreshConversations = useCallback(() => {
    if (!isElectron()) return
    void listAiConversations()
      .then((next) => {
        if (mountedRef.current) setConversations(next)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!isElectron()) return
    let alive = true
    void getAiStatus()
      .then((next) => {
        if (alive) setStatus(next)
      })
      .catch(() => {})
    refreshConversations()
    return () => {
      alive = false
    }
  }, [refreshConversations])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  const scheduleLiveTextRender = useCallback(() => {
    if (liveTextRafRef.current !== null) return
    liveTextRafRef.current = requestAnimationFrame(() => {
      liveTextRafRef.current = null
      setLiveText(liveTextRef.current)
    })
  }, [])

  const flushLiveText = useCallback((prev: DisplayMessage[]): DisplayMessage[] => {
    if (!liveTextRef.current) return prev
    const next = prev.slice()
    const streamIndex = streamingMessageIdRef.current
      ? next.findIndex((message) => message.id === streamingMessageIdRef.current)
      : -1
    const lastIndex = streamIndex >= 0 ? streamIndex : next.length - 1
    const last = next[lastIndex]
    if (last?.role === "assistant") {
      next[lastIndex] = { ...last, blocks: flushTextIntoBlocks(last.blocks, liveTextRef.current) }
    }
    liveTextRef.current = ""
    setLiveText("")
    return next
  }, [])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight })
  }, [messages, liveText])

  const handleEvent = useCallback(
    (event: AgentRunEvent) => {
      if (event.conversationId !== conversationIdRef.current) return

      if (event.type === "run_started") {
        setActiveRunId(event.runId)
        resolvedApprovalIdsRef.current.clear()
        terminalSnapshotRunIdRef.current = undefined
      }
      if (event.type === "text_delta") {
        liveTextRef.current += event.text
        scheduleLiveTextRender()
        return
      }

      setMessages((prev) => {
        const flushed = flushLiveText(prev)
        return applyEvent(flushed, event)
      })

      if (event.type === "run_completed" || event.type === "run_failed") {
        terminalSnapshotRunIdRef.current = event.runId
        updateStreamingMessageId(null)
        setApproval(null)
        resolvedApprovalIdsRef.current.clear()
        refreshConversations()
        // Finalization commits the conversation before the terminal event.
        // Refresh the active transcript so a reload-era streaming placeholder
        // is replaced by the canonical, durable assistant message.
        void getAiConversation(event.conversationId)
          .then((stored) => {
            if (
              mountedRef.current &&
              event.conversationId === conversationIdRef.current &&
              stored
            ) {
              setMessages(hydrateMessages(stored.messages))
            }
          })
          .catch(() => {})
      }
      if (event.type === "approval_pending") {
        setApproval(
          (current) =>
            current ?? {
              approvalId: event.approvalId,
              toolName: event.safeName,
            }
        )
      }
      if (event.type === "approval_resolved") {
        resolvedApprovalIdsRef.current.add(event.approvalId)
        setApproval((current) => (current?.approvalId === event.approvalId ? null : current))
      }
      if (event.type === "plan_updated") {
        setPlanSteps(event.plan)
      }
    },
    [flushLiveText, refreshConversations, scheduleLiveTextRender, updateStreamingMessageId]
  )

  useEffect(() => {
    if (!isElectron()) return
    return onRunEvent(handleEvent)
  }, [handleEvent])

  useEffect(() => {
    if (!runSnapshot || runSnapshot.identity.conversationId !== conversationId) return
    const terminal = isTerminalSnapshot(runSnapshot)
    const placeholderId = streamingPlaceholderId(runSnapshot)
    const completedAssistantId = runSnapshot.currentModelStep?.assistantMessageId
    const completedPlaceholderId = runSnapshot.currentModelStep
      ? `durable-run:${runSnapshot.identity.runId}:stream:${runSnapshot.currentModelStep.step}`
      : undefined
    setMessages((previous) => {
      let reconciled = previous
      if (placeholderId && !previous.some((message) => message.id === placeholderId)) {
        reconciled = [...previous, { id: placeholderId, role: "assistant", blocks: [] }]
      } else if (completedAssistantId && completedPlaceholderId) {
        const durableId = `durable-run:${runSnapshot.identity.runId}:message:${completedAssistantId}`
        reconciled = previous.map((message) =>
          message.id === completedPlaceholderId ? { ...message, id: durableId } : message
        )
      }
      return mergeDurableRunSnapshot(reconciled, runSnapshot)
    })
    updateStreamingMessageId(
      placeholderId ??
        (completedAssistantId
          ? `durable-run:${runSnapshot.identity.runId}:message:${completedAssistantId}`
          : null)
    )
    setPlanSteps(runSnapshot.plan ?? [])
    if (terminal) {
      // A reload/selection can attach after finalization committed the
      // conversation but before the live terminal event. The snapshot sees
      // the terminal state, while the conversation is the only source with
      // the canonical host-rich transcript, so replace recovered placeholders
      // exactly once for this terminal run.
      updateStreamingMessageId(null)
      liveTextRef.current = ""
      setLiveText("")
      const runId = runSnapshot.identity.runId
      const terminalConversationId = runSnapshot.identity.conversationId
      if (terminalConversationId && terminalSnapshotRunIdRef.current !== runId) {
        terminalSnapshotRunIdRef.current = runId
        void getAiConversation(terminalConversationId)
          .then((stored) => {
            if (
              mountedRef.current &&
              terminalConversationId === conversationIdRef.current &&
              stored
            ) {
              setMessages(hydrateMessages(stored.messages))
            }
          })
          .catch(() => {})
      }
    } else if (terminalSnapshotRunIdRef.current === runSnapshot.identity.runId) {
      terminalSnapshotRunIdRef.current = undefined
    }
    // A renderer can attach after approval_pending was emitted. Recreate the
    // first unresolved prompt from durable state, keeping any live prompt in
    // front so multiple pending requests remain deterministic.
    for (const id of resolvedApprovalIdsRef.current) {
      if (!runSnapshot.pendingApprovalIds.includes(id)) resolvedApprovalIdsRef.current.delete(id)
    }
    const durableApproval = firstPendingApproval(runSnapshot, resolvedApprovalIdsRef.current)
    setApproval((current) => {
      if (!durableApproval) return null
      return current && runSnapshot.pendingApprovalIds.includes(current.approvalId)
        ? current
        : durableApproval
    })
  }, [runSnapshot, approval, updateStreamingMessageId])

  async function selectConversation(id: string, force = false) {
    if ((!force && id === conversationId) || busy) return
    const generation = ++conversationSelectionGenerationRef.current
    selectingConversationRef.current = true
    conversationIdRef.current = id
    setConversationId(id)
    setUsage(null)
    setApproval(null)
    setSendError(null)
    setPlanSteps([])
    updateStreamingMessageId(null)
    liveTextRef.current = ""
    setLiveText("")
    setActiveRunId(undefined)
    setConversationLocked(false)
    terminalSnapshotRunIdRef.current = undefined
    let stored: Awaited<ReturnType<typeof getAiConversation>>
    try {
      stored = await getAiConversation(id)
    } catch {
      if (generation === conversationSelectionGenerationRef.current && mountedRef.current) {
        setActiveRunId(undefined)
        setConversationLocked(false)
        selectingConversationRef.current = false
      }
      return
    }
    if (generation !== conversationSelectionGenerationRef.current || !mountedRef.current) return
    setMessages(stored ? hydrateMessages(stored.messages) : [])
    setActiveWorkspaceId(stored?.workspaceId ?? "default")
    setPlanSteps(stored?.plan ?? [])
    if (!stored) {
      // sessionStorage can contain a freshly generated, never-created draft
      // id, or an id deleted by another renderer. It is not a durable
      // conversation, so retain it only as an unlocked draft: send() must
      // create a real conversation rather than addressing this absent id.
      clearPersistedActiveCortexConversation(id)
      setActiveRunId(undefined)
      setConversationLocked(false)
      selectingConversationRef.current = false
      return
    }
    // A conversation can have at most one live durable interactive run (its
    // fenced lease). On a renderer restart it will not emit a legacy
    // ai:chat event again, so locate it through the durable recovery scan and
    // let useRunSnapshot rebuild the in-flight cards from checkpoint + event
    // cursor. Terminal traces are intentionally not used for this purpose.
    let recoverable: Awaited<ReturnType<typeof listRecoverableRuns>>
    try {
      recoverable = await listRecoverableRuns()
    } catch {
      if (generation === conversationSelectionGenerationRef.current && mountedRef.current) {
        setActiveRunId(undefined)
        setConversationLocked(true)
        // A rejected lookup from an older selection must not clear the
        // newer selection's send fence while it is still resolving.
        selectingConversationRef.current = false
      }
      return
    }
    if (generation !== conversationSelectionGenerationRef.current || !mountedRef.current) return
    const active = recoverable
      .filter((run) => run.conversationId === id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    setActiveRunId(active?.runId)
    setConversationLocked(true)
    selectingConversationRef.current = false
  }

  useEffect(() => {
    const resumeConversationId = restoredConversationIdRef.current
    if (resumeConversationId) void selectConversation(resumeConversationId, true).catch(() => {})
    // Signal that THIS mount has read `initialConversationId`, regardless of
    // whether it was set — this is what lets AppShell safely clear its
    // one-shot pending id. Clearing must happen only after this component has
    // actually mounted and consumed the prop, not merely "around the same
    // time" as the nav change: ChatPage is lazy-loaded, so on a cold first
    // visit to Cortex there can be an arbitrarily long Suspense-fallback gap
    // between `nav` flipping to "cortex" and this component mounting. A
    // parent-side effect keyed only on `nav` would fire during that gap and
    // clear the id before it was ever read, silently dropping the resume.
    onInitialConversationConsumed?.()
    // Intentionally runs once on mount only: the explicit Home resume id and
    // the session-restored id are both mount-time instructions, not props
    // that should re-trigger a reload if they change later.
    // eslint-disable-next-line react/exhaustive-deps
  }, [])

  function newConversation() {
    if (busy) return
    const id = crypto.randomUUID()
    conversationSelectionGenerationRef.current++
    selectingConversationRef.current = false
    conversationIdRef.current = id
    setConversationId(id)
    setConversationLocked(false)
    setMessages([])
    setUsage(null)
    setApproval(null)
    setSendError(null)
    setPlanSteps([])
    updateStreamingMessageId(null)
    setActiveRunId(undefined)
    liveTextRef.current = ""
    setLiveText("")
  }

  async function removeConversation(id: string) {
    try {
      await deleteAiConversation(id)
      if (id === conversationId) newConversation()
      refreshConversations()
    } catch {
      setSendError(t("chat.startFailed"))
    }
  }

  async function saveKey() {
    if (!keyDraft.trim() || savingKey) return
    setSavingKey(true)
    try {
      await setAiKey(status?.provider ?? "anthropic", keyDraft.trim())
      setKeyDraft("")
      setStatus(await getAiStatus())
    } catch {
      setSendError(t("chat.startFailed"))
    } finally {
      setSavingKey(false)
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || busy || selectingConversationRef.current) return
    setInput("")
    setPlanSteps([])
    setSendError(null)
    const assistantId = crypto.randomUUID()
    updateStreamingMessageId(assistantId)
    liveTextRef.current = ""
    setLiveText("")
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", blocks: [{ kind: "text", text }] },
      { id: assistantId, role: "assistant", blocks: [] },
    ])
    setBusy(true)
    try {
      let id = conversationId
      if (!conversationLocked) {
        const created = await createAiConversation(activeWorkspaceId)
        id = created.id
        conversationIdRef.current = id
        // `sendAiChat` begins synchronously below, before React can commit
        // the state update and run its persistence effect. Persist the newly
        // durable id here so a reload during that gap reattaches to this run
        // rather than the pre-creation draft id.
        persistActiveCortexConversation(id)
        setConversationId(id)
        setConversationLocked(true)
      }
      const result = await sendAiChat(id, text)
      setUsage(result.usage)
    } catch {
      // Setup failures can occur before a durable run exists, so no
      // run_failed event will arrive. Keep the user input visible but remove
      // the speculative assistant bubble and surface a renderer-safe error.
      setMessages((previous) => previous.filter((message) => message.id !== assistantId))
      setSendError(t("chat.startFailed"))
    } finally {
      setBusy(false)
      updateStreamingMessageId(null)
      setMessages((prev) => flushLiveText(prev))
    }
  }

  async function resolveApproval(allow: boolean, remember: "once" | "always") {
    if (!approval) return
    const pending = approval
    const id = pending.approvalId
    resolvedApprovalIdsRef.current.add(id)
    setApproval(null)
    try {
      await approveAiTool(id, allow, remember)
    } catch {
      // Do not permanently hide a durable approval if its IPC request fails.
      resolvedApprovalIdsRef.current.delete(id)
      setApproval(pending)
    }
  }

  if (status && !status.hasKey) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <Header
          onManageMcp={() => setShowMcp(true)}
          onManageMemory={() => setShowMemory(true)}
          onOpenSettings={() => setShowSettings(true)}
        />
        <McpServersDialog open={showMcp} onOpenChange={setShowMcp} />
        <MemoryDialog open={showMemory} onOpenChange={setShowMemory} />
        <AiSettingsDialog
          open={showSettings}
          onOpenChange={setShowSettings}
          status={status}
          onStatusChange={setStatus}
        />
        <AssistantOnboarding
          status={status}
          keyDraft={keyDraft}
          savingKey={savingKey}
          onKeyDraftChange={setKeyDraft}
          onSaveKey={() => void saveKey()}
          onOpenSettings={() => setShowSettings(true)}
        />
      </div>
    )
  }

  return (
    <div className="h-full min-h-0">
      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="synapse-chat-layout"
        className="h-full min-h-0"
      >
        <ResizablePanel
          ref={sidebarPanelRef}
          defaultSize={22}
          minSize={16}
          maxSize={42}
          collapsible
          collapsedSize={0}
          className="min-w-0"
        >
          <ConversationSidebar
            conversations={conversations}
            activeId={conversationId}
            onSelect={(id) => void selectConversation(id).catch(() => {})}
            onNew={newConversation}
            onDelete={(id) => void removeConversation(id)}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel minSize={45} className="relative min-w-0">
          {planSteps.length > 0 && (
            <div className="absolute top-14 right-3 z-10">
              <PlanPanel steps={planSteps} />
            </div>
          )}
          <div className="flex h-full min-h-0 flex-col gap-3 pl-1">
            <Header
              onToggleSidebar={() => setShowSidebar((value) => !value)}
              onManageMcp={() => setShowMcp(true)}
              onManageMemory={() => setShowMemory(true)}
              onOpenSettings={() => setShowSettings(true)}
            />
            <McpServersDialog open={showMcp} onOpenChange={setShowMcp} />
            <MemoryDialog open={showMemory} onOpenChange={setShowMemory} />
            <AiSettingsDialog
              open={showSettings}
              onOpenChange={setShowSettings}
              status={status}
              onStatusChange={setStatus}
            />
            {sendError && (
              <p role="alert" className="mx-auto w-full max-w-3xl px-1 text-sm text-destructive">
                {sendError}
              </p>
            )}

            {messages.length === 0 ? (
              <div className="flex flex-1 min-h-0 items-center justify-center overflow-y-auto px-4">
                <EmptyStateComposer
                  value={input}
                  busy={busy}
                  onChange={setInput}
                  onSend={() => void send()}
                  workspaceValue={activeWorkspaceId}
                  onWorkspaceChange={setActiveWorkspaceId}
                  workspaceLocked={conversationLocked}
                  model={status?.model}
                  onOpenModelSettings={() => setShowSettings(true)}
                />
              </div>
            ) : (
              <>
                <div ref={scrollRef} className="flex-1 overflow-y-auto pr-1">
                  <div className="mx-auto w-full max-w-3xl space-y-6 px-1 py-2">
                    {messages.map((message) => (
                      // eslint-disable-next-line ts/no-use-before-define
                      <MessageBubble
                        key={message.id}
                        message={message}
                        liveSuffix={message.id === streamingMessageId ? liveText : undefined}
                        isStreaming={message.id === streamingMessageId}
                      />
                    ))}
                  </div>
                </div>

                {usage && (
                  <p className="text-right text-[11px] text-muted-foreground">
                    {t("chat.usage", {
                      input: usage.inputTokens,
                      output: usage.outputTokens,
                      cached: usage.cacheReadInputTokens,
                    })}
                    {status && status.budgetTokens > 0 && (
                      <span>
                        {" · "}
                        {t("chat.usageBudget", {
                          used:
                            usage.inputTokens +
                            usage.outputTokens +
                            usage.cacheCreationInputTokens +
                            usage.cacheReadInputTokens,
                          budget: status.budgetTokens,
                        })}
                      </span>
                    )}
                  </p>
                )}

                <ChatComposer
                  value={input}
                  busy={busy}
                  onChange={setInput}
                  onSend={() => void send()}
                  workspaceValue={activeWorkspaceId}
                  onWorkspaceChange={setActiveWorkspaceId}
                  workspaceLocked={conversationLocked}
                  model={status?.model}
                  onOpenModelSettings={() => setShowSettings(true)}
                />
              </>
            )}

            <Dialog
              open={approval !== null}
              onOpenChange={(open) => !open && void resolveApproval(false, "once")}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("chat.approvalTitle")}</DialogTitle>
                  <DialogDescription>
                    {t("chat.approvalBody", { tool: approval?.toolName ?? "" })}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2 sm:justify-between">
                  <Button variant="ghost" onClick={() => void resolveApproval(false, "once")}>
                    {t("chat.deny")}
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => void resolveApproval(true, "always")}>
                      {t("chat.allowAlways")}
                    </Button>
                    <Button onClick={() => void resolveApproval(true, "once")}>
                      {t("chat.allow")}
                    </Button>
                  </div>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

interface ComposerToolbarProps {
  workspaceValue: string
  onWorkspaceChange: (id: string) => void
  workspaceLocked: boolean
}

/** The "+" attachment menu shown from the composer. Entries have no backend
 *  yet, so they're rendered as placeholders that match the target menu shape
 *  and can be wired up later without touching the layout. */
function AttachMenu() {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("chat.attach")}
        >
          <Plus className="size-5 stroke-[1.75]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-60">
        <DropdownMenuItem disabled>
          <Paperclip />
          {t("chat.attachMenu.addFiles")}
          <DropdownMenuShortcut>Ctrl+U</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Scroll />
            {t("chat.attachMenu.skills")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem disabled>{t("chat.attachMenu.empty")}</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Boxes />
            {t("chat.attachMenu.connectors")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem disabled>{t("chat.attachMenu.empty")}</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Plug />
            {t("chat.attachMenu.plugins")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem disabled>{t("chat.attachMenu.empty")}</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The attached footer bar that tucks in behind the elevated input pill. The
 *  negative top margin lets the pill overlap it, and its own muted background +
 *  shadow give the layered "attached bar" hierarchy. Act mode is a disabled
 *  placeholder until it has a backend. */
function ComposerToolbar({
  workspaceValue,
  onWorkspaceChange,
  workspaceLocked,
}: ComposerToolbarProps) {
  const { t } = useTranslation()
  return (
    <div className="-mt-4 rounded-b-[22px] border border-t-0 border-border/50 bg-muted/50 px-4 pt-6 pb-2 shadow-sm dark:bg-white/[0.03]">
      <div className="flex items-center gap-2">
        <WorkspaceSwitcher
          value={workspaceValue}
          onChange={onWorkspaceChange}
          disabled={workspaceLocked}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-full px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          disabled
        >
          <Play className="size-3" />
          {t("chat.actMode")}
          <ChevronDown className="size-3" />
        </Button>
      </div>
    </div>
  )
}

interface ComposerPillProps {
  value: string
  busy: boolean
  onChange: (value: string) => void
  onSend: () => void
  model?: string
  onOpenModelSettings: () => void
  /** Taller textarea for the centered empty-state composer. */
  large?: boolean
}

/** The elevated input box: a full-width textarea stacked above a control row
 *  with the attach (+) menu on the left and the model selector + mic/send on
 *  the right. It floats above the footer bar via z-index + shadow. */
function ComposerPill({
  value,
  busy,
  onChange,
  onSend,
  model,
  onOpenModelSettings,
  large,
}: ComposerPillProps) {
  const { t } = useTranslation()
  const canSend = value.trim().length > 0 && !busy

  return (
    <div
      className={cn(
        "relative z-10 flex flex-col gap-1 rounded-[24px] border border-border/70 bg-background px-2.5 py-2 shadow-lg shadow-black/5",
        large && "px-3 py-2.5"
      )}
    >
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            if (canSend) onSend()
          }
        }}
        placeholder={t("chat.placeholder")}
        rows={large ? 2 : 1}
        className={cn(
          "max-h-[200px] min-h-9 w-full resize-none border-0 bg-transparent px-1.5 py-1.5 text-[15px] leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent",
          large && "min-h-14 text-base"
        )}
      />

      <div className="flex items-center gap-1.5">
        <AttachMenu />

        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-full px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onOpenModelSettings}
          >
            {model ?? "…"}
            <ChevronDown className="size-3" />
          </Button>

          {canSend || busy ? (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              aria-label={t("chat.send")}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                canSend
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "cursor-not-allowed bg-muted text-muted-foreground"
              )}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4 stroke-[2.25]" />
              )}
            </button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("chat.voiceInput")}
              disabled
            >
              <Mic className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

interface ChatComposerProps extends ComposerToolbarProps {
  value: string
  busy: boolean
  onChange: (value: string) => void
  onSend: () => void
  model?: string
  onOpenModelSettings: () => void
}

/** The elevated pill plus the attached footer bar as one layered unit. */
function Composer({
  value,
  busy,
  onChange,
  onSend,
  model,
  onOpenModelSettings,
  large,
  ...toolbar
}: ChatComposerProps & { large?: boolean }) {
  return (
    <div className="relative">
      <ComposerPill
        value={value}
        busy={busy}
        onChange={onChange}
        onSend={onSend}
        model={model}
        onOpenModelSettings={onOpenModelSettings}
        large={large}
      />
      <ComposerToolbar {...toolbar} />
    </div>
  )
}

/** Bottom-docked composer for a conversation that already has messages. */
function ChatComposer(props: ChatComposerProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-1">
      <Composer {...props} />
    </div>
  )
}

/** Centered, larger composer shown in place of the message list for a brand
 *  new conversation — matches a "start a task" landing state instead of an
 *  empty scroll region with placeholder text. */
function EmptyStateComposer(props: ChatComposerProps) {
  const { t } = useTranslation()
  return (
    <div className="mx-auto w-full max-w-2xl px-4">
      <h1 className="mb-6 text-center text-2xl font-semibold text-foreground">
        {t("chat.emptyHeadline")}
      </h1>
      <Composer {...props} large />
    </div>
  )
}

function Header({
  onToggleSidebar,
  onManageMcp,
  onManageMemory,
  onOpenSettings,
}: {
  onToggleSidebar?: () => void
  onManageMcp: () => void
  onManageMemory: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      {onToggleSidebar && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("chat.toggleSidebar")}
          onClick={onToggleSidebar}
        >
          <PanelLeft className="size-4" />
        </Button>
      )}
      <BrainCircuit className="size-5 text-primary" />
      <h2 className="text-lg font-semibold">{t("chat.title")}</h2>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onManageMcp}>
          <Server className="size-4" />
          {t("mcp.manage")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onManageMemory}>
          <Brain className="size-4" />
          {t("memory.manage")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          <Settings className="size-4" />
          {t("providers.title")}
        </Button>
      </div>
    </div>
  )
}

const MessageBubble = memo(
  ({
    message,
    liveSuffix,
    isStreaming,
  }: {
    message: DisplayMessage
    liveSuffix?: string
    isStreaming?: boolean
  }) => {
    const isUser = message.role === "user"

    if (isUser) {
      const text = message.blocks[0]?.kind === "text" ? message.blocks[0].text : ""
      return (
        <div className="flex justify-end">
          <div className="max-w-[min(85%,42rem)] rounded-[22px] bg-muted px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
            <p className="whitespace-pre-wrap wrap-break-word">{text}</p>
          </div>
        </div>
      )
    }

    const lastIndex = message.blocks.length - 1
    const lastBlock = message.blocks[lastIndex]
    return (
      <div className="w-full space-y-3 text-[15px] leading-relaxed text-foreground">
        {message.blocks.map((block, index) => {
          if (block.kind === "tool") return <ToolCardView key={block.id} tool={block} />
          const isLast = index === lastIndex
          const text = isLast && liveSuffix ? block.text + liveSuffix : block.text
          return text ? (
            <Markdown key={`t${index}`} streaming={isStreaming && isLast}>
              {text}
            </Markdown>
          ) : null
        })}
        {liveSuffix && lastBlock?.kind !== "text" && (
          <Markdown streaming={isStreaming}>{liveSuffix}</Markdown>
        )}
      </div>
    )
  }
)

// Persists across MessageBubble/ToolCardView remounts (e.g. scrolling a
// virtualized list, switching conversations and back), keyed by artifact
// uri — the exact "cache the terminal error state per artifact URI" the
// design calls for. Deliberately module-level rather than component state:
// a status check result belongs to the artifact, not to any one card's
// lifetime. Never re-fetched once a uri has an entry, so a forbidden/missing
// read is never retried as if it were a fresh request.
const artifactAvailabilityCache = new Map<string, ArtifactAvailability>()

/** Lazily resolves and caches one artifact's live status. Returns undefined
 *  until a result (cached or freshly fetched) is known — callers render a
 *  neutral/no-badge state for that case, never an error. */
function useArtifactAvailability(uri: string | undefined): ArtifactAvailability | undefined {
  const [, forceRerender] = useState(0)
  useEffect(() => {
    if (!uri || artifactAvailabilityCache.has(uri)) return
    let cancelled = false
    void getArtifactStatus(uri)
      .then((result) => {
        if (cancelled) return
        artifactAvailabilityCache.set(
          uri,
          result.status === "available" ? "available" : result.code
        )
        forceRerender((n) => n + 1)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [uri])
  return uri ? artifactAvailabilityCache.get(uri) : undefined
}

const ARTIFACT_UNAVAILABLE_LABELS: Record<Exclude<ArtifactAvailability, "available">, string> = {
  checking: "checking…",
  artifact_expired: "expired — no longer recoverable",
  artifact_missing: "unavailable",
  artifact_corrupt: "unavailable (corrupt)",
  artifact_forbidden: "unavailable (access denied)",
  range_invalid: "unavailable",
}

function ToolCardView({ tool }: { tool: ToolCard }) {
  const availability = useArtifactAvailability(tool.artifact?.uri)
  return (
    <div className="rounded-md border bg-background/60 px-2 py-1.5 text-xs text-foreground">
      <div className="flex items-center gap-1.5">
        <Wrench className="size-3" />
        <span className="font-mono">{tool.name}</span>
        <span
          className={cn(
            "ml-auto rounded px-1.5 py-0.5 text-[10px]",
            tool.status === "running" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
            tool.status === "success" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
            tool.status === "error" && "bg-red-500/15 text-red-600 dark:text-red-400"
          )}
        >
          {tool.status}
        </span>
      </div>
      {tool.artifact && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
          {!tool.artifact.complete && (
            <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-600 dark:text-amber-400">
              incomplete
              {tool.artifact.truncationReason ? ` (${tool.artifact.truncationReason})` : ""}
            </span>
          )}
          {availability && availability !== "available" && (
            <span className="rounded bg-red-500/15 px-1 py-0.5 text-red-600 dark:text-red-400">
              {ARTIFACT_UNAVAILABLE_LABELS[availability]}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
