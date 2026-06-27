import type { AiConversationSummary } from "@/lib/electron"
import { MessageSquarePlus, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
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

      <ScrollArea className="flex-1">
        <div className="space-y-0.5 pr-1">
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t("chat.noHistory")}
            </p>
          ) : (
            conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={cn(
                  "group flex items-center gap-1 rounded-md pr-1 text-sm",
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
                  className="size-6 opacity-0 group-hover:opacity-100"
                  aria-label={t("chat.deleteConversation")}
                  onClick={() => onDelete(conversation.id)}
                >
                  <Trash2 className="size-3.5 text-muted-foreground" />
                </Button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
