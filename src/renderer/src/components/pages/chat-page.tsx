import type { AiChatEvent, AiStatus, AiTokenUsage } from "@/lib/electron"
import { Bot, Loader2, Send, Server, Wrench } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { McpServersDialog } from "@/components/mcp-servers-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  approveAiTool,
  getAiStatus,
  isElectron,
  onAiChatEvent,
  sendAiChat,
  setAiKey,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

interface ToolCard {
  id: string
  name: string
  input: unknown
  status: "running" | "success" | "error"
}

interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  text: string
  tools: ToolCard[]
}

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
  const [conversationId] = useState(() => crypto.randomUUID())
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isElectron()) void getAiStatus().then(setStatus)
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const handleEvent = useCallback(
    (event: AiChatEvent) => {
      if (event.conversationId !== conversationId) return
      setMessages((prev) => applyEvent(prev, event))
      if (event.type === "done") setUsage(event.usage)
      if (event.type === "approval_request") {
        setApproval({
          approvalId: event.approvalId,
          toolName: event.toolName,
          input: event.input,
        })
      }
    },
    [conversationId]
  )

  useEffect(() => {
    if (!isElectron()) return
    return onAiChatEvent(handleEvent)
  }, [handleEvent])

  async function saveKey() {
    if (!keyDraft.trim() || savingKey) return
    setSavingKey(true)
    try {
      await setAiKey(keyDraft.trim())
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
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text, tools: [] },
      { id: crypto.randomUUID(), role: "assistant", text: "", tools: [] },
    ])
    setBusy(true)
    try {
      await sendAiChat(conversationId, text)
    } finally {
      setBusy(false)
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
      <div className="space-y-4">
        <Header onManageMcp={() => setShowMcp(true)} />
        <McpServersDialog open={showMcp} onOpenChange={setShowMcp} />
        <div className="rounded-lg border bg-card p-6">
          <p className="mb-3 text-sm text-muted-foreground">{t("chat.keyPrompt")}</p>
          <div className="flex gap-2">
            <Input
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder="sk-ant-..."
              onKeyDown={(event) => event.key === "Enter" && void saveKey()}
            />
            <Button onClick={() => void saveKey()} disabled={savingKey || !keyDraft.trim()}>
              {t("chat.saveKey")}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3">
      <Header model={status?.model} onManageMcp={() => setShowMcp(true)} />
      <McpServersDialog open={showMcp} onOpenChange={setShowMcp} />

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("chat.empty")}</p>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      {usage && (
        <p className="text-right text-[11px] text-muted-foreground">
          {t("chat.usage", {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cached: usage.cacheReadInputTokens,
          })}
        </p>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={t("chat.placeholder")}
          className="max-h-40 min-h-10 resize-none"
          rows={1}
        />
        <Button onClick={() => void send()} disabled={busy || !input.trim()} size="icon">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>

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
              <Button onClick={() => void resolveApproval(true, "once")}>{t("chat.allow")}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Header({ model, onManageMcp }: { model?: string; onManageMcp: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <Bot className="size-5 text-primary" />
      <h2 className="text-lg font-semibold">{t("chat.title")}</h2>
      <div className="ml-auto flex items-center gap-2">
        {model && <span className="text-xs text-muted-foreground">{model}</span>}
        <Button variant="ghost" size="sm" onClick={onManageMcp}>
          <Server className="size-4" />
          {t("mcp.manage")}
        </Button>
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user"
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] space-y-2 rounded-lg px-3 py-2 text-sm",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        )}
      >
        {message.text && <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>}
        {message.tools.map((tool) => (
          <ToolCardView key={tool.id} tool={tool} />
        ))}
      </div>
    </div>
  )
}

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
    case "text":
      next[lastIndex] = { ...last, text: last.text + event.delta }
      break
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
