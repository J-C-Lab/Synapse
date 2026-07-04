import type { McpServerConfig, McpServerStatus, ToolHealth } from "@/lib/electron"
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  deleteAiMcpServer,
  getAiMcpServerStatus,
  getAiToolHealth,
  isElectron,
  listAiMcpServers,
  saveAiMcpServer,
} from "@/lib/electron"
import { cn } from "@/lib/utils"

interface DraftServer {
  id: string
  name: string
  transport: "stdio" | "http"
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
  enabled: boolean
}

const emptyDraft: DraftServer = {
  id: "",
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  envText: "",
  url: "",
  headersText: "",
  enabled: true,
}

function draftIsValid(draft: DraftServer): boolean {
  if (!draft.id.trim()) return false
  return draft.transport === "http" ? draft.url.trim().length > 0 : draft.command.trim().length > 0
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
  const [health, setHealth] = useState<ToolHealth[]>([])
  const [draft, setDraft] = useState<DraftServer | null>(null)
  const [saving, setSaving] = useState(false)

  async function refresh() {
    if (!isElectron()) return
    const [list, status, toolHealth] = await Promise.all([
      listAiMcpServers(),
      getAiMcpServerStatus(),
      getAiToolHealth(),
    ])
    setServers(list)
    setStatuses(status)
    setHealth(toolHealth)
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  async function save() {
    if (!draft || saving || !draftIsValid(draft)) return
    setSaving(true)
    try {
      const base: McpServerConfig = {
        id: draft.id.trim(),
        name: draft.name.trim() || undefined,
        transport: draft.transport,
        enabled: draft.enabled,
      }
      const config: McpServerConfig =
        draft.transport === "http"
          ? { ...base, url: draft.url.trim(), headers: parseEnv(draft.headersText) }
          : {
              ...base,
              command: draft.command.trim(),
              args: parseArgs(draft.argsText),
              env: parseEnv(draft.envText),
            }
      const status = await saveAiMcpServer(config)
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

  // Bulkhead keys group a server's tools under `mcp:<serverId>`.
  function healthOf(id: string): ToolHealth | undefined {
    return health.find((entry) => entry.key === `mcp:${id}`)
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
              health={healthOf(server.id)}
              onEdit={() =>
                setDraft({
                  id: server.id,
                  name: server.name ?? "",
                  transport: server.transport === "http" ? "http" : "stdio",
                  command: server.command ?? "",
                  argsText: (server.args ?? []).join("\n"),
                  envText: envToText(server.env),
                  url: server.url ?? "",
                  headersText: envToText(server.headers),
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
  health,
  onEdit,
  onDelete,
}: {
  server: McpServerConfig
  status?: McpServerStatus
  health?: ToolHealth
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const state = status?.state ?? (server.enabled === false ? "disconnected" : "connecting")
  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{server.name || server.id}</span>
          <Badge variant="outline" className={cn("text-[10px]", stateClass(state))}>
            {t(`mcp.state.${state}`)}
          </Badge>
          {state === "connected" && (
            <span className="text-[11px] text-muted-foreground">
              {t("mcp.toolCount", { count: status?.toolCount ?? 0 })}
            </span>
          )}
          <CircuitBadge health={health} />
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {server.transport === "http"
            ? server.url
            : `${server.command ?? ""} ${(server.args ?? []).join(" ")}`}
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
      <Field label={t("mcp.transport")}>
        <NativeSelect
          value={draft.transport}
          onChange={(event) => set({ transport: event.target.value as DraftServer["transport"] })}
        >
          <NativeSelectOption value="stdio">{t("mcp.transportStdio")}</NativeSelectOption>
          <NativeSelectOption value="http">{t("mcp.transportHttp")}</NativeSelectOption>
        </NativeSelect>
      </Field>

      {draft.transport === "http" ? (
        <>
          <Field label={t("mcp.url")} hint={t("mcp.urlHint")}>
            <Input
              value={draft.url}
              onChange={(event) => set({ url: event.target.value })}
              placeholder="https://example.com/mcp"
              className="font-mono"
            />
          </Field>
          <Field label={t("mcp.headers")} hint={t("mcp.headersHint")}>
            <Textarea
              value={draft.headersText}
              onChange={(event) => set({ headersText: event.target.value })}
              placeholder="Authorization=Bearer …"
              className="min-h-14 font-mono text-xs"
            />
          </Field>
        </>
      ) : (
        <>
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
        </>
      )}
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
        <Button onClick={onSave} disabled={saving || !draftIsValid(draft)}>
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

// Only surfaced when the breaker is degraded (open / recovering). A healthy
// closed circuit is the norm and would just add noise next to the conn badge.
function CircuitBadge({ health }: { health?: ToolHealth }) {
  const { t } = useTranslation()
  if (!health || health.state === "closed") return null
  const detail = t("mcp.circuit.detail", {
    fails: health.consecutiveFailures,
    avg: health.avgLatencyMs,
  })
  return (
    <Badge
      variant="outline"
      title={detail}
      className={cn(
        "text-[10px]",
        health.state === "open"
          ? "border-red-500/40 text-red-600 dark:text-red-400"
          : "border-amber-500/40 text-amber-600 dark:text-amber-400"
      )}
    >
      {t(`mcp.circuit.${health.state}`)}
    </Badge>
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
