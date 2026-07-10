import type { WorkspaceRoot } from "@/lib/electron"
import { FolderPlus, Star, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  createWorkspaceRoot,
  getSettings,
  listWorkspaceRoots,
  onSettingsChanged,
  pickWorkspaceRootDirectory,
  removeWorkspaceRoot,
  setPrimaryWorkspaceRoot,
} from "@/lib/electron"

export interface WorkspaceRootManagerProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorkspaceRootManager({
  workspaceId,
  open,
  onOpenChange,
}: WorkspaceRootManagerProps) {
  const { t } = useTranslation()
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [busy, setBusy] = useState(false)
  const [shellAllowed, setShellAllowed] = useState(false)

  useEffect(() => {
    void getSettings().then((settings) => setShellAllowed(settings.allowAgentShell))
    return onSettingsChanged((settings) => setShellAllowed(settings.allowAgentShell))
  }, [])

  useEffect(() => {
    if (!open) return
    void listWorkspaceRoots(workspaceId).then(setRoots)
  }, [open, workspaceId])

  async function handleAdd() {
    const picked = await pickWorkspaceRootDirectory()
    if (!picked) return
    setBusy(true)
    try {
      const name = picked.split(/[/\\]/).filter(Boolean).pop() ?? picked
      const role = roots.some((r) => r.role === "primary") ? "additional" : "primary"
      const created = await createWorkspaceRoot(workspaceId, name, picked, role)
      setRoots((current) => [...current, created])
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(id: string) {
    setBusy(true)
    try {
      await removeWorkspaceRoot(id)
      setRoots((current) => current.filter((r) => r.id !== id))
    } finally {
      setBusy(false)
    }
  }

  async function handleSetPrimary(id: string) {
    setBusy(true)
    try {
      await setPrimaryWorkspaceRoot(id)
      setRoots((current) =>
        current.map((r) => ({ ...r, role: r.id === id ? "primary" : "additional" }))
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.workspaceRoots.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {roots.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.workspaceRoots.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {roots.map((root) => (
                <li
                  key={root.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {root.name}
                      {root.role === "primary" ? (
                        <Badge variant="secondary">
                          {t("settings.workspaceRoots.primaryBadge")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{root.root}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {root.role !== "primary" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleSetPrimary(root.id)}
                      >
                        <Star className="size-4" aria-hidden />
                        {t("settings.workspaceRoots.setPrimary")}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRemove(root.id)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      {t("settings.workspaceRoots.remove")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!shellAllowed ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.workspaceRoots.disabledNotice")}
            </p>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || !shellAllowed}
            onClick={() => void handleAdd()}
          >
            <FolderPlus className="size-4" aria-hidden />
            {t("settings.workspaceRoots.addButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
