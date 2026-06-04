import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { AiStatus, RememberScope } from "../ai/agent-service"
import type { ConversationSummary, StoredConversation } from "../ai/conversation-store"
import type { McpServerStatus } from "../ai/mcp-client-manager"
import type { McpServerConfig } from "../ai/mcp-server-config-store"
import type { ProviderToolSchema, TokenUsage } from "../ai/providers/types"

// IPC surface for the built-in assistant (design §8). Streaming is push-based:
// `ai:chat` kicks off a turn and resolves when it ends, while text / tool /
// approval events arrive out-of-band on `ai:chat:event` (wired in main via the
// AgentService's sendEvent). Keys are set but never read back to the renderer.

export interface AiIpcService {
  getStatus: () => Promise<AiStatus>
  setKey: (key: string) => Promise<void>
  deleteKey: () => Promise<void>
  listTools: () => ProviderToolSchema[]
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<StoredConversation | undefined>
  chat: (conversationId: string, text: string) => Promise<{ stopReason: string; usage: TokenUsage }>
  cancel: (conversationId: string) => void
  resolveApproval: (approvalId: string, allow: boolean, remember?: RememberScope) => void
  listMcpServers: () => Promise<McpServerConfig[]>
  mcpServerStatus: () => McpServerStatus[]
  saveMcpServer: (config: McpServerConfig) => Promise<McpServerStatus[]>
  deleteMcpServer: (id: string) => Promise<void>
}

export interface RegisterAiIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerAiIpc(
  ipcMain: IpcMain,
  service: AiIpcService,
  options: RegisterAiIpcOptions
): void {
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (options.isTrustedSender(event)) return
    console.warn("[ai-ipc] rejected untrusted sender", { channel })
    throw new Error("Untrusted IPC sender.")
  }

  ipcMain.handle("ai:status", (event) => {
    guard(event, "ai:status")
    return service.getStatus()
  })
  ipcMain.handle("ai:set-key", (event, key: unknown) => {
    guard(event, "ai:set-key")
    return service.setKey(requireString(key, "key"))
  })
  ipcMain.handle("ai:delete-key", (event) => {
    guard(event, "ai:delete-key")
    return service.deleteKey()
  })
  ipcMain.handle("ai:list-tools", (event) => {
    guard(event, "ai:list-tools")
    return service.listTools()
  })
  ipcMain.handle("ai:list-conversations", (event) => {
    guard(event, "ai:list-conversations")
    return service.listConversations()
  })
  ipcMain.handle("ai:get-conversation", (event, id: unknown) => {
    guard(event, "ai:get-conversation")
    return service.getConversation(requireString(id, "id"))
  })
  ipcMain.handle("ai:chat", (event, payload: unknown) => {
    guard(event, "ai:chat")
    const { conversationId, text } = coerceChat(payload)
    return service.chat(conversationId, text)
  })
  ipcMain.handle("ai:cancel", (event, id: unknown) => {
    guard(event, "ai:cancel")
    service.cancel(requireString(id, "conversationId"))
  })
  ipcMain.handle("ai:approve", (event, payload: unknown) => {
    guard(event, "ai:approve")
    const { approvalId, allow, remember } = coerceApprove(payload)
    service.resolveApproval(approvalId, allow, remember)
  })
  ipcMain.handle("ai:mcp:list", (event) => {
    guard(event, "ai:mcp:list")
    return service.listMcpServers()
  })
  ipcMain.handle("ai:mcp:status", (event) => {
    guard(event, "ai:mcp:status")
    return service.mcpServerStatus()
  })
  ipcMain.handle("ai:mcp:save", (event, payload: unknown) => {
    guard(event, "ai:mcp:save")
    return service.saveMcpServer(coerceMcpServer(payload))
  })
  ipcMain.handle("ai:mcp:delete", (event, id: unknown) => {
    guard(event, "ai:mcp:delete")
    return service.deleteMcpServer(requireString(id, "id"))
  })
}

export function coerceMcpServer(payload: unknown): McpServerConfig {
  if (!payload || typeof payload !== "object") {
    throw new Error("MCP server payload must be an object.")
  }
  const v = payload as Record<string, unknown>
  const config: McpServerConfig = {
    id: requireString(v.id, "id"),
    command: requireString(v.command, "command"),
  }
  if (typeof v.name === "string") config.name = v.name
  if (typeof v.cwd === "string") config.cwd = v.cwd
  if (typeof v.enabled === "boolean") config.enabled = v.enabled
  if (Array.isArray(v.args)) {
    config.args = v.args.filter((arg): arg is string => typeof arg === "string")
  }
  if (v.env && typeof v.env === "object" && !Array.isArray(v.env)) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(v.env as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value
    }
    config.env = env
  }
  return config
}

export function coerceChat(payload: unknown): { conversationId: string; text: string } {
  if (!payload || typeof payload !== "object") throw new Error("chat payload must be an object.")
  const v = payload as Record<string, unknown>
  return {
    conversationId: requireString(v.conversationId, "conversationId"),
    text: requireString(v.text, "text"),
  }
}

export function coerceApprove(payload: unknown): {
  approvalId: string
  allow: boolean
  remember: RememberScope
} {
  if (!payload || typeof payload !== "object") throw new Error("approve payload must be an object.")
  const v = payload as Record<string, unknown>
  if (typeof v.allow !== "boolean") throw new Error("allow must be a boolean.")
  const remember = v.remember
  if (
    remember !== undefined &&
    remember !== "once" &&
    remember !== "conversation" &&
    remember !== "always"
  ) {
    throw new Error("remember must be once | conversation | always.")
  }
  return {
    approvalId: requireString(v.approvalId, "approvalId"),
    allow: v.allow,
    remember: (remember as RememberScope | undefined) ?? "once",
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string.`)
  return value
}
