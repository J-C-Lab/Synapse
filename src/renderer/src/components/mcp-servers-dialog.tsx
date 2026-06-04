import type { McpServerConfig, McpServerStatus } from "@/lib/electron"
import { Loader2, Plus, Server, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
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
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  deleteAiMcpServer,
  getAiMcpServerStatus,
  isElectron,
  listAiMcpServers,
  saveAiMcpServer,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

interface DraftServer {
  id: string
  name: string
  command: string
  argsText: string
  envText: string
  enabled: boolean
}

const emptyDraft: DraftServer = {
  id: "",
  name: "",
  command: "",
  argsText: "",
  envText: "",
  enabled: true,
}

export function McpServersDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [draft, setDraft] = useState<DraftServer | null>(null)
  const [saving, setSaving] = useState(false)

  async function refresh() {
    if (!isElectron()) return
    const [list, status] = await Promise.all([listAiMcpServers(), getAiMcpServerStatus()])
    setServers(list)
    setStatuses(status)
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  async function save() {
    if (!draft || saving) return
    if (!draft.id.trim() || !draft.command.trim()) return
    setSaving(true)
    try {
      const status = await saveAiMcpServer({
        id: draft.id.trim(),
        name: draft.name.trim() || undefined,
        command: draft.command.trim(),
        args: parseArgs(draft.argsText),
        env: parseEnv(draft.envText),
        enabled: draft.enabled,
      })
      setStatuses(status)
      setServers(await listAiMcpServers())
      setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    await deleteAiMcpServer(id)
    await refresh()
  }

  function statusOf(id: string): McpServerStatus | undefined {
    return statuses.find((status) => status.id === id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-4" />
            {t("mcp.title")}
          </DialogTitle>
          <DialogDescription>{t("mcp.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {servers.length === 0 && !draft && (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("mcp.empty")}</p>
          )}
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              status={statusOf(server.id)}
              onEdit={() =>
                setDraft({
                  id: server.id,
                  name: server.name ?? "",
                  command: server.command,
                  argsText: (server.args ?? []).join("\n"),
                  envText: envToText(server.env),
                  enabled: server.enabled !== false,
                })
              }
              onDelete={() => void remove(server.id)}
            />
          ))}
        </div>

        {draft ? (
          <ServerForm
            draft={draft}
            saving={saving}
            isNew={!servers.some((server) => server.id === draft.id)}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => void save()}
          />
        ) : (
          <Button variant="outline" className="w-full" onClick={() => setDraft({ ...emptyDraft })}>
            <Plus className="size-4" />
            {t("mcp.add")}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ServerRow({
  server,
  status,
  onEdit,
  onDelete,
}: {
  server: McpServerConfig
  status?: McpServerStatus
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const state = status?.state ?? (server.enabled === false ? "disconnected" : "connecting")
  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{server.name || server.id}</span>
          <Badge variant="outline" className={cn("text-[10px]", stateClass(state))}>
            {t(`mcp.state.${state}`)}
          </Badge>
          {state === "connected" && (
            <span className="text-[11px] text-muted-foreground">
              {t("mcp.toolCount", { count: status?.toolCount ?? 0 })}
            </span>
          )}
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {server.command} {(server.args ?? []).join(" ")}
        </p>
        {status?.error && <p className="truncate text-[11px] text-red-500">{status.error}</p>}
      </div>
      <Button variant="ghost" size="sm" onClick={onEdit}>
        {t("mcp.edit")}
      </Button>
      <Button variant="ghost" size="icon" onClick={onDelete}>
        <Trash2 className="size-4 text-muted-foreground" />
      </Button>
    </div>
  )
}

function ServerForm({
  draft,
  saving,
  isNew,
  onChange,
  onCancel,
  onSave,
}: {
  draft: DraftServer
  saving: boolean
  isNew: boolean
  onChange: (draft: DraftServer) => void
  onCancel: () => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const set = (patch: Partial<DraftServer>) => onChange({ ...draft, ...patch })
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("mcp.id")} hint={t("mcp.idHint")}>
          <Input
            value={draft.id}
            disabled={!isNew}
            onChange={(event) => set({ id: event.target.value })}
            placeholder="filesystem"
          />
        </Field>
        <Field label={t("mcp.name")}>
          <Input value={draft.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>
      </div>
      <Field label={t("mcp.command")} hint={t("mcp.commandHint")}>
        <Input
          value={draft.command}
          onChange={(event) => set({ command: event.target.value })}
          placeholder="npx"
          className="font-mono"
        />
      </Field>
      <Field label={t("mcp.args")} hint={t("mcp.argsHint")}>
        <Textarea
          value={draft.argsText}
          onChange={(event) => set({ argsText: event.target.value })}
          placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path"}
          className="min-h-20 font-mono text-xs"
        />
      </Field>
      <Field label={t("mcp.env")} hint={t("mcp.envHint")}>
        <Textarea
          value={draft.envText}
          onChange={(event) => set({ envText: event.target.value })}
          placeholder="API_BASE=https://example.com"
          className="min-h-14 font-mono text-xs"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Switch
          id="mcp-enabled"
          checked={draft.enabled}
          onCheckedChange={(checked) => set({ enabled: checked })}
        />
        <Label htmlFor="mcp-enabled">{t("mcp.enabled")}</Label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("mcp.cancel")}
        </Button>
        <Button onClick={onSave} disabled={saving || !draft.id.trim() || !draft.command.trim()}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {t("mcp.save")}
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function stateClass(state: McpServerStatus["state"]): string {
  switch (state) {
    case "connected":
      return "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
    case "error":
      return "border-red-500/40 text-red-600 dark:text-red-400"
    case "connecting":
      return "border-amber-500/40 text-amber-600 dark:text-amber-400"
    default:
      return "text-muted-foreground"
  }
}

function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

function envToText(env: Record<string, string> | undefined): string {
  if (!env) return ""
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}
