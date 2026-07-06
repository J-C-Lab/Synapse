import type { MemoryEntry, MemorySource } from "@/lib/electron"
import { Brain, FileText, Loader2, Trash2, Upload } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  deleteMemory,
  deleteMemorySource,
  ingestMemoryDocument,
  isElectron,
  listMemories,
  listMemorySources,
} from "@/lib/electron"

const SOURCE_TAG_PREFIX = "source:"

function formatScope(
  scope: MemoryEntry["scope"],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (scope.visibility === "workspace" && scope.workspaceId) {
    return t("memory.scopeWorkspace", { id: scope.workspaceId })
  }
  if (scope.visibility === "conversation") {
    return t("memory.scopeConversation")
  }
  return t("memory.scopeGlobal")
}

// Direct, user-driven management of long-term memory (the agent reaches the same
// store through its memory tools). Import a document — read in the renderer via
// the File API, chunked + embedded in the main process — and review or delete
// imported documents and standalone facts.

export function MemoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [sources, setSources] = useState<MemorySource[]>([])
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    if (!isElectron()) return
    const [nextSources, nextMemories] = await Promise.all([listMemorySources(), listMemories()])
    setSources(nextSources)
    setMemories(nextMemories)
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // Standalone facts: memories that are not chunks of an imported document.
  const facts = memories.filter(
    (entry) => !entry.tags.some((tag) => tag.startsWith(SOURCE_TAG_PREFIX))
  )

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = "" // allow re-importing the same file
    if (!file) return
    setBusy(true)
    try {
      const text = await file.text()
      const result = await ingestMemoryDocument({ source: file.name, text })
      toast.success(t("memory.imported", { source: result.source, chunks: result.chunks }))
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("memory.importFailed"))
    } finally {
      setBusy(false)
    }
  }

  async function removeSource(source: string) {
    await deleteMemorySource(source)
    await refresh()
  }

  async function removeFact(id: string) {
    await deleteMemory(id)
    await refresh()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain className="size-4" />
            {t("memory.title")}
          </DialogTitle>
          <DialogDescription>{t("memory.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{t("memory.documents")}</span>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {t("memory.import")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.markdown,.json,.csv,.log,text/plain"
            className="hidden"
            onChange={(event) => void onFileChosen(event)}
          />
        </div>

        {sources.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("memory.noDocuments")}</p>
        ) : (
          <div className="space-y-1">
            {sources.map((entry) => (
              <div
                key={entry.source}
                className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.source}</span>
                <span className="shrink-0 text-muted-foreground">
                  {entry.count} {t("memory.chunks")}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t("memory.delete")}
                  onClick={() => void removeSource(entry.source)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="border-t pt-3">
          <span className="text-xs font-medium text-muted-foreground">{t("memory.facts")}</span>
          {facts.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{t("memory.noFacts")}</p>
          ) : (
            <ScrollArea className="mt-1 max-h-48">
              <div className="space-y-1 pr-3">
                {facts.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2 rounded-md border px-2 py-1 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground">
                        {formatScope(entry.scope, t)}
                      </p>
                      <p>{entry.text}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      aria-label={t("memory.delete")}
                      onClick={() => void removeFact(entry.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
