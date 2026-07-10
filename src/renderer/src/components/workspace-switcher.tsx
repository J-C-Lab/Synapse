import type { AiWorkspace } from "@/lib/electron"
import { FolderCog, FolderKanban, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createAiWorkspace, listAiWorkspaces } from "@/lib/electron"
import { WorkspaceRootManager } from "./workspace-root-manager"

const NEW_WORKSPACE_VALUE = "__new__"

export function WorkspaceSwitcher({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const [workspaces, setWorkspaces] = useState<AiWorkspace[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [managingRoots, setManagingRoots] = useState(false)

  useEffect(() => {
    void listAiWorkspaces().then(setWorkspaces)
  }, [])

  async function commitCreate() {
    const trimmed = name.trim()
    setCreating(false)
    setName("")
    if (!trimmed) return
    const created = await createAiWorkspace(trimmed)
    setWorkspaces((prev) => [...prev, created])
    onChange(created.id)
  }

  if (creating) {
    return (
      <>
        <Input
          autoFocus
          aria-label="New workspace name"
          placeholder="New workspace name"
          className="h-8 w-44 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void commitCreate()
            } else if (e.key === "Escape") {
              setCreating(false)
              setName("")
            }
          }}
          onBlur={() => {
            setCreating(false)
            setName("")
          }}
        />
        <Button variant="ghost" size="icon" aria-label="Manage roots" disabled>
          <FolderCog className="size-4" aria-hidden />
        </Button>
      </>
    )
  }

  return (
    <>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === NEW_WORKSPACE_VALUE) setCreating(true)
          else onChange(next)
        }}
      >
        <SelectTrigger aria-label="Workspace" size="sm" className="w-auto gap-1.5 text-sm">
          <FolderKanban className="size-3.5" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
            </SelectItem>
          ))}
          {!disabled && (
            <>
              <SelectSeparator />
              <SelectItem value={NEW_WORKSPACE_VALUE} className="text-primary">
                <Plus className="size-3.5" />
                New workspace…
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Manage roots"
        disabled={disabled}
        onClick={() => setManagingRoots(true)}
      >
        <FolderCog className="size-4" aria-hidden />
      </Button>
      <WorkspaceRootManager
        workspaceId={value}
        open={managingRoots}
        onOpenChange={setManagingRoots}
      />
    </>
  )
}
