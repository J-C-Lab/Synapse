import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { AiStatus, RememberScope } from "../ai/agent-service"
import type { ToolResilienceSettings } from "../ai/ai-settings-store"
import type { ConversationSummary, StoredConversation } from "../ai/conversation-store"
import type { McpServerStatus } from "../ai/mcp-client-manager"
import type { McpServerConfig } from "../ai/mcp-server-config-store"
import type { ProviderToolSchema, TokenUsage } from "../ai/providers/types"
import type { ToolStatSnapshot } from "../ai/tool-circuit-breaker"
import { logger } from "../logging"
import { withCapabilityPromptTarget } from "./capability-prompt-router"

// IPC surface for the built-in assistant (design §8). Streaming is push-based:
// `ai:chat` kicks off a turn and resolves when it ends, while text / tool /
// approval events arrive out-of-band on `ai:chat:event` (wired in main via the
// AgentService's sendEvent). Keys are set but never read back to the renderer.

export interface AiIpcService {
  getStatus: () => Promise<AiStatus>
  setKey: (providerId: string, key: string) => Promise<void>
  deleteKey: (providerId: string) => Promise<void>
  setActiveProvider: (providerId: string) => Promise<void>
  setModel: (providerId: string, model: string) => Promise<void>
  setBudget: (tokens: number) => Promise<void>
  setContextCompression: (value: { enabled: boolean; thresholdTokens: number }) => Promise<void>
  setToolResilience: (value: ToolResilienceSettings) => Promise<void>
  listTools: () => ProviderToolSchema[]
  toolHealth: () => ToolStatSnapshot[]
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<StoredConversation | undefined>
  deleteConversation: (id: string) => Promise<void>
  chat: (conversationId: string, text: string) => Promise<{ stopReason: string; usage: TokenUsage }>
  cancel: (conversationId: string) => void
  resolveApproval: (
    approvalId: string,
    allow: boolean,
    remember?: RememberScope
  ) => void | Promise<void>
  listAllowedTools: () => Promise<string[]>
  revokeTool: (fqName: string) => Promise<void>
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
    logger.child("ai-ipc").warn("rejected untrusted sender", { channel })
    throw new Error("Untrusted IPC sender.")
  }

  ipcMain.handle("ai:status", (event) => {
    guard(event, "ai:status")
    return service.getStatus()
  })
  ipcMain.handle("ai:set-key", (event, payload: unknown) => {
    guard(event, "ai:set-key")
    const { providerId, key } = coerceProviderKey(payload)
    return service.setKey(providerId, key)
  })
  ipcMain.handle("ai:delete-key", (event, providerId: unknown) => {
    guard(event, "ai:delete-key")
    return service.deleteKey(requireString(providerId, "providerId"))
  })
  ipcMain.handle("ai:set-provider", (event, providerId: unknown) => {
    guard(event, "ai:set-provider")
    return service.setActiveProvider(requireString(providerId, "providerId"))
  })
  ipcMain.handle("ai:set-model", (event, payload: unknown) => {
    guard(event, "ai:set-model")
    const { providerId, model } = coerceProviderModel(payload)
    return service.setModel(providerId, model)
  })
  ipcMain.handle("ai:set-budget", (event, tokens: unknown) => {
    guard(event, "ai:set-budget")
    return service.setBudget(coerceBudget(tokens))
  })
  ipcMain.handle("ai:set-context-compression", (event, payload: unknown) => {
    guard(event, "ai:set-context-compression")
    return service.setContextCompression(coerceContextCompression(payload))
  })
  ipcMain.handle("ai:set-tool-resilience", (event, payload: unknown) => {
    guard(event, "ai:set-tool-resilience")
    return service.setToolResilience(coerceToolResilience(payload))
  })
  ipcMain.handle("ai:list-tools", (event) => {
    guard(event, "ai:list-tools")
    return service.listTools()
  })
  ipcMain.handle("ai:tool-health", (event) => {
    guard(event, "ai:tool-health")
    return service.toolHealth()
  })
  ipcMain.handle("ai:list-conversations", (event) => {
    guard(event, "ai:list-conversations")
    return service.listConversations()
  })
  ipcMain.handle("ai:get-conversation", (event, id: unknown) => {
    guard(event, "ai:get-conversation")
    return service.getConversation(requireString(id, "id"))
  })
  ipcMain.handle("ai:delete-conversation", (event, id: unknown) => {
    guard(event, "ai:delete-conversation")
    return service.deleteConversation(requireString(id, "id"))
  })
  ipcMain.handle("ai:chat", (event, payload: unknown) => {
    guard(event, "ai:chat")
    const { conversationId, text } = coerceChat(payload)
    return withCapabilityPromptTarget(event.sender, () => service.chat(conversationId, text))
  })
  ipcMain.handle("ai:cancel", (event, id: unknown) => {
    guard(event, "ai:cancel")
    service.cancel(requireString(id, "conversationId"))
  })
  ipcMain.handle("ai:approve", (event, payload: unknown) => {
    guard(event, "ai:approve")
    const { approvalId, allow, remember } = coerceApprove(payload)
    return service.resolveApproval(approvalId, allow, remember)
  })
  ipcMain.handle("ai:list-allowed-tools", (event) => {
    guard(event, "ai:list-allowed-tools")
    return service.listAllowedTools()
  })
  ipcMain.handle("ai:revoke-tool", (event, fqName: unknown) => {
    guard(event, "ai:revoke-tool")
    return service.revokeTool(requireString(fqName, "fqName"))
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

export function coerceProviderKey(payload: unknown): { providerId: string; key: string } {
  if (!payload || typeof payload !== "object") throw new Error("set-key payload must be an object.")
  const v = payload as Record<string, unknown>
  return { providerId: requireString(v.providerId, "providerId"), key: requireString(v.key, "key") }
}

export function coerceProviderModel(payload: unknown): { providerId: string; model: string } {
  if (!payload || typeof payload !== "object") {
    throw new Error("set-model payload must be an object.")
  }
  const v = payload as Record<string, unknown>
  return {
    providerId: requireString(v.providerId, "providerId"),
    model: requireString(v.model, "model"),
  }
}

export function coerceBudget(tokens: unknown): number {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
    throw new Error("budget must be a non-negative number.")
  }
  return Math.floor(tokens)
}

export function coerceContextCompression(payload: unknown): {
  enabled: boolean
  thresholdTokens: number
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("context compression payload must be an object.")
  }
  const v = payload as Record<string, unknown>
  if (typeof v.enabled !== "boolean") throw new Error("enabled must be a boolean.")
  if (
    typeof v.thresholdTokens !== "number" ||
    !Number.isFinite(v.thresholdTokens) ||
    v.thresholdTokens < 0
  ) {
    throw new Error("thresholdTokens must be a non-negative number.")
  }
  return { enabled: v.enabled, thresholdTokens: Math.floor(v.thresholdTokens) }
}

export function coerceToolResilience(payload: unknown): ToolResilienceSettings {
  if (!payload || typeof payload !== "object") {
    throw new Error("tool resilience payload must be an object.")
  }
  const v = payload as Record<string, unknown>
  const num = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number.`)
    }
    return Math.floor(value)
  }
  // The store clamps failureThreshold to ≥ 1; here we only enforce shape.
  return {
    failureThreshold: num(v.failureThreshold, "failureThreshold"),
    recoveryMs: num(v.recoveryMs, "recoveryMs"),
    timeoutMs: num(v.timeoutMs, "timeoutMs"),
  }
}

export function coerceMcpServer(payload: unknown): McpServerConfig {
  if (!payload || typeof payload !== "object") {
    throw new Error("MCP server payload must be an object.")
  }
  const v = payload as Record<string, unknown>
  // Shape-only coercion; the config store validates command-or-url per transport.
  const config: McpServerConfig = { id: requireString(v.id, "id") }
  if (v.transport === "http" || v.transport === "stdio") config.transport = v.transport
  if (typeof v.name === "string") config.name = v.name
  if (typeof v.command === "string") config.command = v.command
  if (typeof v.cwd === "string") config.cwd = v.cwd
  if (typeof v.url === "string") config.url = v.url
  if (typeof v.enabled === "boolean") config.enabled = v.enabled
  if (Array.isArray(v.args)) {
    config.args = v.args.filter((arg): arg is string => typeof arg === "string")
  }
  const env = stringRecord(v.env)
  if (env) config.env = env
  const headers = stringRecord(v.headers)
  if (headers) config.headers = headers
  return config
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
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
