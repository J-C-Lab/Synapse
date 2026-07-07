import type { AiConversationSummary } from "@/lib/electron"
import { MessageSquarePlus, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: AiConversationSummary[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 pr-1">
      <Button variant="outline" size="sm" className="justify-start" onClick={onNew}>
        <MessageSquarePlus className="size-4" />
        {t("chat.newConversation")}
      </Button>

      {/* Plain native scroll instead of Radix ScrollArea: ScrollArea wraps its
          children in a `display:table` div (for scroll-size measurement) that
          sizes to content's max-content width, which defeats `truncate`
          no matter how many `min-w-0`s are added downstream — the row simply
          never gets a bounded width to ellipsize within. A native overflow-y
          container has no such quirk (same pattern as chat-page.tsx's message
          list) and truncation genuinely tracks the panel's rendered width. */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="min-w-0 space-y-0.5 pr-1">
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t("chat.noHistory")}
            </p>
          ) : (
            conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={cn(
                  "group flex min-w-0 items-center gap-1 rounded-md pr-1 text-sm",
                  conversation.id === activeId ? "bg-accent" : "hover:bg-accent/50"
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-left"
                  onClick={() => onSelect(conversation.id)}
                >
                  {conversation.title || t("chat.untitled")}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                  aria-label={t("chat.deleteConversation")}
                  onClick={() => onDelete(conversation.id)}
                >
                  <Trash2 className="size-3.5 text-muted-foreground" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
