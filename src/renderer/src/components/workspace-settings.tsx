import type { AiWorkspace } from "@/lib/electron"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  archiveAiWorkspace,
  isElectron,
  listAiWorkspaces,
  renameAiWorkspace,
  unarchiveAiWorkspace,
} from "@/lib/electron"

export function WorkspaceSettings() {
  const { t } = useTranslation()
  const [workspaces, setWorkspaces] = useState<AiWorkspace[]>([])
  const [editingId, setEditingId] = useState<string | undefined>()
  const [draftName, setDraftName] = useState("")
  const [status, setStatus] = useState<string | undefined>()

  async function refresh() {
    const list = await listAiWorkspaces({ includeArchived: true })
    setWorkspaces(list)
  }

  useEffect(() => {
    if (!isElectron()) return
    void refresh()
  }, [])

  if (!isElectron()) return null

  async function onSaveRename(id: string) {
    const name = draftName.trim()
    if (!name) return
    await renameAiWorkspace(id, name)
    setEditingId(undefined)
    setStatus(t("workspaceSettings.renameSuccess"))
    await refresh()
  }

  async function onArchive(id: string) {
    await archiveAiWorkspace(id)
    setStatus(t("workspaceSettings.archiveSuccess"))
    await refresh()
  }

  async function onUnarchive(id: string) {
    await unarchiveAiWorkspace(id)
    setStatus(t("workspaceSettings.unarchiveSuccess"))
    await refresh()
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-base">{t("workspaceSettings.title")}</CardTitle>
        <CardDescription>{t("workspaceSettings.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {workspaces.map((w) => {
          const isDefault = w.id === "default"
          const isEditing = editingId === w.id
          return (
            <div
              key={w.id}
              data-workspace-row
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {isEditing ? (
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    className="h-8"
                  />
                ) : (
                  <span className="truncate text-sm">{w.name}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {w.archived
                    ? t("workspaceSettings.statusArchived")
                    : t("workspaceSettings.statusActive")}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isDefault ? (
                  <span className="text-xs text-muted-foreground">
                    {t("workspaceSettings.defaultWorkspaceHint")}
                  </span>
                ) : isEditing ? (
                  <>
                    <Button size="sm" onClick={() => onSaveRename(w.id)}>
                      {t("workspaceSettings.saveButton")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingId(undefined)}>
                      {t("workspaceSettings.cancelButton")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingId(w.id)
                        setDraftName(w.name)
                      }}
                    >
                      {t("workspaceSettings.renameButton")}
                    </Button>
                    {w.archived ? (
                      <Button size="sm" variant="outline" onClick={() => onUnarchive(w.id)}>
                        {t("workspaceSettings.unarchiveButton")}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => onArchive(w.id)}>
                        {t("workspaceSettings.archiveButton")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
        {status && (
          <p role="status" className="text-sm text-muted-foreground">
            {status}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
