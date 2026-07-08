import type { AiConversationSummary } from "@/lib/electron"
import { BrainCircuit } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { isElectron, listAiConversations } from "@/lib/electron"

export function CortexQuickEntryCard({
  onOpenCortex,
}: {
  onOpenCortex: (conversationId?: string) => void
}) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(() => isElectron())
  const [recent, setRecent] = useState<AiConversationSummary | null>(null)

  useEffect(() => {
    if (!isElectron()) return
    void listAiConversations().then((conversations) => {
      const latest = conversations.reduce<AiConversationSummary | null>((best, current) => {
        if (!best || current.updatedAt > best.updatedAt) return current
        return best
      }, null)
      setRecent(latest)
      setLoading(false)
    })
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BrainCircuit className="size-4 text-primary" aria-hidden />
          {t("home.cortex.title")}
        </CardTitle>
        <CardDescription className="line-clamp-2">
          {loading ? (
            <Skeleton className="h-4 w-48" />
          ) : recent ? (
            (recent.title ?? t("chat.untitled"))
          ) : (
            t("home.cortex.emptyHint")
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-40" />
        ) : (
          <Button onClick={() => onOpenCortex(recent?.id)}>
            {recent ? t("home.cortex.continue") : t("home.cortex.start")}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
