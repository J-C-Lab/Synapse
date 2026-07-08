import type { ImperativePanelHandle } from "react-resizable-panels"
import type { DisplayMessage, ToolCard } from "./chat-message-model"
import type { PlanStep } from "@/components/PlanPanel"
import type { AiChatEvent, AiConversationSummary, AiStatus, AiTokenUsage } from "@/lib/electron"
import {
  ArrowUp,
  Bot,
  Boxes,
  Brain,
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
import { applyEvent, flushTextIntoBlocks, hydrateMessages } from "./chat-message-model"

interface PendingApproval {
  approvalId: string
  toolName: string
  input: unknown
}

export function ChatPage({ initialConversationId }: { initialConversationId?: string } = {}) {
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
      next[lastIndex] = { ...last, blocks: flushTextIntoBlocks(last.blocks, liveTextRef.current) }
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
    setPlanSteps(stored?.plan ?? [])
    setConversationLocked(true)
  }

  useEffect(() => {
    if (initialConversationId) void selectConversation(initialConversationId)
    // Intentionally runs once on mount only: `initialConversationId` is a
    // one-shot instruction from Home's "continue conversation" card, not a
    // prop that should re-trigger a reload if it were to change later.
    // eslint-disable-next-line react/exhaustive-deps
  }, [])

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
      <Bot className="size-5 text-primary" />
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
