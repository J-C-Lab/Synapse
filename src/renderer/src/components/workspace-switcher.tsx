import type { AiWorkspace } from "@/lib/electron"
import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { createAiWorkspace, listAiWorkspaces } from "@/lib/electron"

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
        // Blur cancels rather than creating, so leaving the field never submits
        // a half-typed name and Enter is the single commit path (no double-fire).
        onBlur={() => {
          setCreating(false)
          setName("")
        }}
      />
    )
  }

  return (
    <select
      aria-label="Workspace"
      className="rounded border bg-transparent px-2 py-1 text-sm"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === "__new__") setCreating(true)
        else onChange(e.target.value)
      }}
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
      {!disabled && <option value="__new__">New workspace…</option>}
    </select>
  )
}
