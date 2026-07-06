import type { ExecutionWorkspace } from "@/lib/electron"
import { FolderOpen, FolderPlus, Loader2, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  addExecutionWorkspace,
  isElectron,
  listExecutionWorkspaces,
  pickExecutionWorkspaceFolder,
  removeExecutionWorkspace,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

// eslint-disable-next-line react-refresh/only-export-components -- pure helper co-located with its only consumer; exported for unit tests
export function suggestWorkspaceId(folderPath: string, existingIds: string[]): string {
  const segment = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? "workspace"
  const slug =
    segment
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace"
  if (!existingIds.includes(slug)) return slug
  for (let index = 2; index < 100; index++) {
    const candidate = `${slug}-${index}`
    if (!existingIds.includes(candidate)) return candidate
  }
  return `${slug}-${Date.now()}`
}

export function ExecutionWorkspaceDialog({
  open,
  onOpenChange,
  onWorkspacesChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onWorkspacesChange?: (workspaces: ExecutionWorkspace[]) => void
}) {
  const { t } = useTranslation()
  const [workspaces, setWorkspaces] = useState<ExecutionWorkspace[]>([])
  const [workspaceId, setWorkspaceId] = useState("")
  const [rootPath, setRootPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!isElectron()) return
    const next = await listExecutionWorkspaces()
    setWorkspaces(next)
    onWorkspacesChange?.(next)
  }, [onWorkspacesChange])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  async function browseFolder() {
    const picked = await pickExecutionWorkspaceFolder()
    if (!picked) return
    setRootPath(picked)
    setAddError(null)
    setWorkspaceId((current) =>
      current.trim()
        ? current
        : suggestWorkspaceId(
            picked,
            workspaces.map((item) => item.id)
          )
    )
  }

  async function addWorkspace() {
    const id = workspaceId.trim()
    const root = rootPath.trim()
    if (!id || !root || busy) return
    setBusy(true)
    setAddError(null)
    try {
      await addExecutionWorkspace(id, root)
      setWorkspaceId("")
      setRootPath("")
      await refresh()
      toast.success(t("execution.added", { id }))
    } catch (err) {
      const message = err instanceof Error ? err.message : t("execution.addFailed")
      setAddError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  async function revokeWorkspace(id: string) {
    if (busy) return
    setBusy(true)
    try {
      await removeExecutionWorkspace(id)
      await refresh()
      toast.success(t("execution.removed", { id }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("execution.revokeFailed"))
    } finally {
      setBusy(false)
    }
  }

  const canAdd = workspaceId.trim().length > 0 && rootPath.trim().length > 0 && !busy
  const addErrorId = "execution-add-error"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("execution.title")}</DialogTitle>
          <DialogDescription>{t("execution.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <form
            className="space-y-3 rounded-lg border p-3"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault()
              void addWorkspace()
            }}
          >
            <p className="text-sm font-medium">{t("execution.add")}</p>
            <div aria-live="polite" aria-atomic="true" className="sr-only">
              {busy ? t("execution.working") : ""}
            </div>
            <div className="space-y-2">
              <Label htmlFor="execution-workspace-id">{t("execution.id")}</Label>
              <Input
                id="execution-workspace-id"
                value={workspaceId}
                onChange={(event) => {
                  setWorkspaceId(event.target.value)
                  setAddError(null)
                }}
                placeholder={t("execution.idPlaceholder")}
                aria-invalid={addError !== null}
                aria-describedby={
                  addError
                    ? `${addErrorId} execution-workspace-id-hint`
                    : "execution-workspace-id-hint"
                }
              />
              <p id="execution-workspace-id-hint" className="text-xs text-muted-foreground">
                {t("execution.idHint")}
              </p>
              {addError && (
                <p id={addErrorId} role="alert" className="text-sm text-destructive">
                  {addError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label id="execution-workspace-root-label" htmlFor="execution-workspace-root">
                {t("execution.folder")}
              </Label>
              <div className="flex gap-2">
                <div
                  id="execution-workspace-root"
                  role="status"
                  aria-labelledby="execution-workspace-root-label"
                  className={cn(
                    "flex min-h-9 min-w-0 flex-1 items-center rounded-md border border-input bg-muted/30 px-3 py-2 font-mono text-xs",
                    rootPath ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  <span className="truncate">{rootPath || t("execution.folderPlaceholder")}</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void browseFolder()}
                  disabled={busy}
                >
                  <FolderOpen className="size-4" aria-hidden />
                  {t("execution.browse")}
                </Button>
              </div>
            </div>
            <Button type="submit" disabled={!canAdd}>
              {busy ? (
                <Loader2 className="size-4 motion-reduce:animate-none animate-spin" aria-hidden />
              ) : (
                <FolderPlus className="size-4" aria-hidden />
              )}
              {t("execution.authorize")}
            </Button>
          </form>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{t("execution.authorized")}</p>
              <Badge variant="secondary">{workspaces.length}</Badge>
            </div>
            {workspaces.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                {t("execution.empty")}
              </p>
            ) : (
              <ScrollArea className="max-h-56 rounded-lg border">
                <ul className="divide-y">
                  {workspaces.map((workspace) => (
                    <li
                      key={workspace.id}
                      className="flex items-start justify-between gap-3 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">{workspace.id}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {workspace.root}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-10 shrink-0"
                        aria-label={t("execution.revoke", { id: workspace.id })}
                        onClick={() => void revokeWorkspace(workspace.id)}
                        disabled={busy}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
