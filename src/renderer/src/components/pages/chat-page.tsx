import type { ReactNode } from "react"
import type { ImperativePanelHandle } from "react-resizable-panels"
import type { DisplayMessage, ToolCard } from "./chat-message-model"
import type { PlanStep } from "@/components/PlanPanel"
import type { AiChatEvent, AiConversationSummary, AiStatus, AiTokenUsage } from "@/lib/electron"
import {
  ArrowUp,
  Bot,
  Brain,
  Loader2,
  PanelLeft,
  Plus,
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Textarea } from "@/components/ui/textarea"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import {
  approveAiTool,
  createAiConversation,
  deleteAiConversation,
  getAiConversation,
  getAiStatus,
  isElectron,
  listAiConversations,
  onAiChatEvent,
  sendAiChat,
  setAiKey,
} from "@/lib/electron"
import { cn } from "@/lib/utils"
import { hydrateMessages } from "./chat-message-model"

interface PendingApproval {
  approvalId: string
  toolName: string
  input: unknown
}

export function ChatPage() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState("")
  const [savingKey, setSavingKey] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<AiTokenUsage | null>(null)
  const [approval, setApproval] = useState<PendingApproval | null>(null)
  const [showMcp, setShowMcp] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSidebar, setShowSidebar] = useState(true)
  const [conversations, setConversations] = useState<AiConversationSummary[]>([])
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("default")
  const [conversationLocked, setConversationLocked] = useState(false)
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([])
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [liveText, setLiveText] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const liveTextRef = useRef("")
  const liveTextRafRef = useRef<number | null>(null)
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null)
  const conversationIdRef = useRef(conversationId)

  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  useEffect(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return
    if (showSidebar) panel.expand()
    else panel.collapse()
  }, [showSidebar])

  const refreshConversations = useCallback(() => {
    if (isElectron()) void listAiConversations().then(setConversations)
  }, [])

  useEffect(() => {
    if (!isElectron()) return
    void getAiStatus().then(setStatus)
    refreshConversations()
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
    const lastIndex = next.length - 1
    const last = next[lastIndex]
    if (last?.role === "assistant") {
      next[lastIndex] = { ...last, text: last.text + liveTextRef.current }
    }
    liveTextRef.current = ""
    setLiveText("")
    return next
  }, [])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, liveText])

  const handleEvent = useCallback(
    (event: AiChatEvent) => {
      if (event.conversationId !== conversationIdRef.current) return

      if (event.type === "text") {
        liveTextRef.current += event.delta
        scheduleLiveTextRender()
        return
      }

      setMessages((prev) => {
        const flushed = flushLiveText(prev)
        return event.type === "done" ? flushed : applyEvent(flushed, event)
      })

      if (event.type === "done") {
        setStreamingMessageId(null)
        setUsage(event.usage)
        refreshConversations()
      }
      if (event.type === "approval_request") {
        setApproval({
          approvalId: event.approvalId,
          toolName: event.toolName,
          input: event.input,
        })
      }
      if (event.type === "plan") {
        setPlanSteps(event.steps)
      }
    },
    [flushLiveText, refreshConversations, scheduleLiveTextRender]
  )

  useEffect(() => {
    if (!isElectron()) return
    return onAiChatEvent(handleEvent)
  }, [handleEvent])

  async function selectConversation(id: string) {
    if (id === conversationId || busy) return
    setConversationId(id)
    setUsage(null)
    setApproval(null)
    setPlanSteps([])
    setStreamingMessageId(null)
    liveTextRef.current = ""
    setLiveText("")
    const stored = await getAiConversation(id)
    setMessages(stored ? hydrateMessages(stored.messages) : [])
    setActiveWorkspaceId(stored?.workspaceId ?? "default")
    setConversationLocked(true)
  }

  function newConversation() {
    if (busy) return
    setConversationId(crypto.randomUUID())
    setConversationLocked(false)
    setMessages([])
    setUsage(null)
    setApproval(null)
    setPlanSteps([])
    setStreamingMessageId(null)
    liveTextRef.current = ""
    setLiveText("")
  }

  async function removeConversation(id: string) {
    await deleteAiConversation(id)
    if (id === conversationId) newConversation()
    refreshConversations()
  }

  async function saveKey() {
    if (!keyDraft.trim() || savingKey) return
    setSavingKey(true)
    try {
      await setAiKey(status?.provider ?? "anthropic", keyDraft.trim())
      setKeyDraft("")
      setStatus(await getAiStatus())
    } finally {
      setSavingKey(false)
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput("")
    setPlanSteps([])
    const assistantId = crypto.randomUUID()
    setStreamingMessageId(assistantId)
    liveTextRef.current = ""
    setLiveText("")
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text, tools: [] },
      { id: assistantId, role: "assistant", text: "", tools: [] },
    ])
    setBusy(true)
    try {
      let id = conversationId
      if (!conversationLocked) {
        const created = await createAiConversation(activeWorkspaceId)
        id = created.id
        conversationIdRef.current = id
        setConversationId(id)
        setConversationLocked(true)
      }
      await sendAiChat(id, text)
    } finally {
      setBusy(false)
      setStreamingMessageId(null)
      setMessages((prev) => flushLiveText(prev))
    }
  }

  async function resolveApproval(allow: boolean, remember: "once" | "always") {
    if (!approval) return
    const id = approval.approvalId
    setApproval(null)
    await approveAiTool(id, allow, remember)
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
            onSelect={(id) => void selectConversation(id)}
            onNew={newConversation}
            onDelete={(id) => void removeConversation(id)}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel minSize={45} className="min-w-0">
          <div className="flex h-full min-h-0 flex-col gap-3 pl-1">
            <Header
              model={status?.model}
              onToggleSidebar={() => setShowSidebar((value) => !value)}
              onManageMcp={() => setShowMcp(true)}
              onManageMemory={() => setShowMemory(true)}
              onOpenSettings={() => setShowSettings(true)}
              workspaceSwitcher={
                <WorkspaceSwitcher
                  value={activeWorkspaceId}
                  onChange={setActiveWorkspaceId}
                  disabled={conversationLocked}
                />
              }
            />
            <McpServersDialog open={showMcp} onOpenChange={setShowMcp} />
            <MemoryDialog open={showMemory} onOpenChange={setShowMemory} />
            <AiSettingsDialog
              open={showSettings}
              onOpenChange={setShowSettings}
              status={status}
              onStatusChange={setStatus}
            />

            <div ref={scrollRef} className="flex-1 overflow-y-auto pr-1">
              <div className="mx-auto w-full max-w-3xl space-y-6 px-1 py-2">
                <PlanPanel steps={planSteps} className="mx-auto max-w-3xl" />
                {messages.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    {t("chat.empty")}
                  </p>
                ) : (
                  messages.map((message) => (
                    // eslint-disable-next-line ts/no-use-before-define
                    <MessageBubble
                      key={message.id}
                      message={message}
                      liveSuffix={message.id === streamingMessageId ? liveText : undefined}
                      isStreaming={message.id === streamingMessageId}
                    />
                  ))
                )}
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
            />

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
                {approval && (
                  <pre className="max-h-48 overflow-auto rounded bg-muted p-3 text-xs">
                    {JSON.stringify(approval.input, null, 2)}
                  </pre>
                )}
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

function ChatComposer({
  value,
  busy,
  onChange,
  onSend,
}: {
  value: string
  busy: boolean
  onChange: (value: string) => void
  onSend: () => void
}) {
  const { t } = useTranslation()
  const canSend = value.trim().length > 0 && !busy

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-1">
      <div
        className={cn(
          "flex items-end gap-0.5 rounded-[28px] border border-border/80 bg-background px-2 py-1.5",
          "shadow-sm ring-1 ring-border/40"
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mb-0.5 size-9 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("chat.attach")}
          disabled
        >
          <Plus className="size-5 stroke-[1.75]" />
        </Button>

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
          rows={1}
          className="max-h-[200px] min-h-9 flex-1 resize-none border-0 bg-transparent px-1 py-2.5 text-[15px] leading-6 shadow-none focus-visible:ring-0"
        />

        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          aria-label={t("chat.send")}
          className={cn(
            "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "cursor-not-allowed bg-muted text-muted-foreground"
          )}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowUp className="size-5 stroke-[2.25]" />
          )}
        </button>
      </div>
    </div>
  )
}

function Header({
  model,
  onToggleSidebar,
  onManageMcp,
  onManageMemory,
  onOpenSettings,
  workspaceSwitcher,
}: {
  model?: string
  onToggleSidebar?: () => void
  onManageMcp: () => void
  onManageMemory: () => void
  onOpenSettings: () => void
  workspaceSwitcher?: ReactNode
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
      <Bot className="size-5 text-primary" />
      <h2 className="text-lg font-semibold">{t("chat.title")}</h2>
      {workspaceSwitcher}
      <div className="ml-auto flex items-center gap-2">
        {model && <span className="text-xs text-muted-foreground">{model}</span>}
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
    const displayText = liveSuffix ? message.text + liveSuffix : message.text

    if (isUser) {
      return (
        <div className="flex justify-end">
          <div className="max-w-[min(85%,42rem)] rounded-[22px] bg-muted px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
            <p className="whitespace-pre-wrap wrap-break-word">{displayText}</p>
          </div>
        </div>
      )
    }

    return (
      <div className="w-full space-y-3 text-[15px] leading-relaxed text-foreground">
        {displayText && <Markdown streaming={isStreaming}>{displayText}</Markdown>}
        {message.tools.map((tool) => (
          <ToolCardView key={tool.id} tool={tool} />
        ))}
      </div>
    )
  }
)

function ToolCardView({ tool }: { tool: ToolCard }) {
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
    </div>
  )
}

function applyEvent(messages: DisplayMessage[], event: AiChatEvent): DisplayMessage[] {
  const next = messages.slice()
  const lastIndex = next.length - 1
  const last = next[lastIndex]
  if (!last || last.role !== "assistant") return next

  switch (event.type) {
    case "tool_call":
      next[lastIndex] = {
        ...last,
        tools: [
          ...last.tools,
          { id: event.id, name: event.name, input: event.input, status: "running" },
        ],
      }
      break
    case "tool_result":
      next[lastIndex] = {
        ...last,
        tools: last.tools.map((tool) =>
          tool.id === event.id ? { ...tool, status: event.isError ? "error" : "success" } : tool
        ),
      }
      break
    case "error":
      next[lastIndex] = {
        ...last,
        text: last.text ? `${last.text}\n\n⚠️ ${event.message}` : `⚠️ ${event.message}`,
      }
      break
    default:
      break
  }
  return next
}
