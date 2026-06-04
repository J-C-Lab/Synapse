import type { AgentEvent } from "./agent-runtime"
import type {
  ConversationStore,
  ConversationSummary,
  StoredConversation,
} from "./conversation-store"
import type { AiCredentialStore } from "./credential-store"
import type { McpClientManager, McpServerStatus } from "./mcp-client-manager"
import type { McpServerConfig, McpServerConfigStore } from "./mcp-server-config-store"
import type { ChatMessage, ChatProvider, ProviderToolSchema, TokenUsage } from "./providers/types"
import type { AiToolRegistry } from "./tool-registry"
import { AgentRuntime } from "./agent-runtime"
import { decideApproval } from "./approval-gate"
import { DEFAULT_ANTHROPIC_MODEL } from "./providers/anthropic-provider"

// Assembles the P2 pieces (credentials + provider + tools + runtime + store)
// into the surface the IPC layer drives. Owns conversation persistence, the
// approval round-trip (ask the renderer, await the user), cancellation, and
// remembered allow-decisions.

export const ANTHROPIC_PROVIDER_ID = "anthropic"

export type RememberScope = "once" | "conversation" | "always"

/** Events streamed to the renderer for one chat turn. */
export type AiChatEvent =
  | { type: "text"; conversationId: string; delta: string }
  | { type: "tool_call"; conversationId: string; id: string; name: string; input: unknown }
  | { type: "tool_result"; conversationId: string; id: string; isError: boolean }
  | {
      type: "approval_request"
      conversationId: string
      approvalId: string
      toolName: string
      input: unknown
    }
  | { type: "done"; conversationId: string; stopReason: string; usage: TokenUsage }
  | { type: "error"; conversationId: string; message: string }

export interface AgentServiceOptions {
  credentials: AiCredentialStore
  tools: AiToolRegistry
  conversations: ConversationStore
  /** Builds a provider from a decrypted key. Injectable for tests. */
  createProvider: (apiKey: string) => ChatProvider
  sendEvent: (event: AiChatEvent) => void
  model?: string
  now?: () => number
  /** External MCP servers (P5). Omitted in tests that don't exercise MCP. */
  mcp?: {
    configs: McpServerConfigStore
    manager: McpClientManager
  }
}

export class AgentMissingKeyError extends Error {
  constructor() {
    super("No API key configured for the AI provider.")
    this.name = "AgentMissingKeyError"
  }
}

interface PendingApproval {
  resolve: (allow: boolean) => void
  fqName: string
  conversationId: string
}

export interface AiStatus {
  hasKey: boolean
  model: string
}

export class AgentService {
  private readonly aborts = new Map<string, AbortController>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly conversationAllow = new Map<string, Set<string>>()
  private readonly permanentAllow = new Set<string>()
  private approvalCounter = 0

  constructor(private readonly options: AgentServiceOptions) {}

  private get now(): () => number {
    return this.options.now ?? Date.now
  }

  async getStatus(): Promise<AiStatus> {
    return {
      hasKey: await this.options.credentials.has(ANTHROPIC_PROVIDER_ID),
      model: this.options.model ?? DEFAULT_ANTHROPIC_MODEL,
    }
  }

  async setKey(key: string): Promise<void> {
    await this.options.credentials.set(ANTHROPIC_PROVIDER_ID, key)
  }

  async deleteKey(): Promise<void> {
    await this.options.credentials.delete(ANTHROPIC_PROVIDER_ID)
  }

  listTools(): ProviderToolSchema[] {
    return this.options.tools.list()
  }

  /** Connect every configured external MCP server. Call once at startup. */
  async startMcpServers(): Promise<void> {
    if (!this.options.mcp) return
    await this.options.mcp.manager.start(await this.options.mcp.configs.list())
  }

  /** The user's configured external MCP servers (launch definitions). */
  async listMcpServers(): Promise<McpServerConfig[]> {
    return this.options.mcp ? this.options.mcp.configs.list() : []
  }

  /** Live connection state for each configured server. */
  mcpServerStatus(): McpServerStatus[] {
    return this.options.mcp ? this.options.mcp.manager.status() : []
  }

  /** Persist a server config and (re)connect it; returns fresh status. */
  async saveMcpServer(config: McpServerConfig): Promise<McpServerStatus[]> {
    if (!this.options.mcp) throw new Error("MCP client support is not configured.")
    const saved = await this.options.mcp.configs.save(config)
    await this.options.mcp.manager.restart(saved)
    return this.options.mcp.manager.status()
  }

  /** Remove a server config and disconnect it. */
  async deleteMcpServer(id: string): Promise<void> {
    if (!this.options.mcp) return
    await this.options.mcp.configs.delete(id)
    await this.options.mcp.manager.stop(id)
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.options.conversations.list()
  }

  getConversation(id: string): Promise<StoredConversation | undefined> {
    return this.options.conversations.get(id)
  }

  /** Run one chat turn, streaming events. Resolves when the turn completes. */
  async chat(
    conversationId: string,
    text: string
  ): Promise<{ stopReason: string; usage: TokenUsage }> {
    const apiKey = await this.options.credentials.get(ANTHROPIC_PROVIDER_ID)
    if (!apiKey) throw new AgentMissingKeyError()

    const runtime = new AgentRuntime({
      provider: this.options.createProvider(apiKey),
      tools: this.options.tools,
      model: this.options.model,
    })

    const existing = await this.options.conversations.get(conversationId)
    const messages: ChatMessage[] = existing?.messages ? [...existing.messages] : []
    messages.push({ role: "user", content: [{ type: "text", text }] })

    const controller = new AbortController()
    this.aborts.set(conversationId, controller)

    try {
      const result = await runtime.run({
        conversationId,
        messages,
        signal: controller.signal,
        onText: (delta) => this.options.sendEvent({ type: "text", conversationId, delta }),
        onEvent: (event) => this.forwardAgentEvent(conversationId, event),
        approve: (request) => this.approve(conversationId, request.toolName, request.input),
      })
      await this.persist(conversationId, existing, result.messages)
      this.options.sendEvent({
        type: "done",
        conversationId,
        stopReason: result.stopReason,
        usage: result.usage,
      })
      return { stopReason: result.stopReason, usage: result.usage }
    } catch (err) {
      this.options.sendEvent({
        type: "error",
        conversationId,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      this.aborts.delete(conversationId)
      this.failPendingApprovals(conversationId)
    }
  }

  /** Cancel an in-flight turn. */
  cancel(conversationId: string): void {
    this.aborts.get(conversationId)?.abort()
    this.failPendingApprovals(conversationId)
  }

  /** Resolve a pending tool approval requested via an `approval_request` event. */
  resolveApproval(approvalId: string, allow: boolean, remember: RememberScope = "once"): void {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return
    this.pendingApprovals.delete(approvalId)
    if (allow && remember === "always") this.permanentAllow.add(pending.fqName)
    if (allow && remember === "conversation") {
      this.allowSet(pending.conversationId).add(pending.fqName)
    }
    pending.resolve(allow)
  }

  private async approve(
    conversationId: string,
    safeName: string,
    input: unknown
  ): Promise<boolean> {
    const descriptor = this.options.tools.describe(safeName)
    const fqName = descriptor?.fqName ?? safeName

    if (this.permanentAllow.has(fqName) || this.allowSet(conversationId).has(fqName)) return true
    if (decideApproval(descriptor?.manifestTool.annotations) === "allow") return true

    const approvalId = `apr_${++this.approvalCounter}`
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(approvalId, { resolve, fqName, conversationId })
      this.options.sendEvent({
        type: "approval_request",
        conversationId,
        approvalId,
        toolName: fqName,
        input,
      })
    })
  }

  private forwardAgentEvent(conversationId: string, event: AgentEvent): void {
    if (event.type === "tool_call") {
      const fqName = this.options.tools.describe(event.name)?.fqName ?? event.name
      this.options.sendEvent({
        type: "tool_call",
        conversationId,
        id: event.id,
        name: fqName,
        input: event.input,
      })
    } else {
      this.options.sendEvent({
        type: "tool_result",
        conversationId,
        id: event.id,
        isError: event.isError,
      })
    }
  }

  private async persist(
    conversationId: string,
    existing: StoredConversation | undefined,
    messages: ChatMessage[]
  ): Promise<void> {
    await this.options.conversations.save({
      id: conversationId,
      title: existing?.title ?? deriveTitle(messages),
      messages,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    })
  }

  private allowSet(conversationId: string): Set<string> {
    let set = this.conversationAllow.get(conversationId)
    if (!set) {
      set = new Set()
      this.conversationAllow.set(conversationId, set)
    }
    return set
  }

  private failPendingApprovals(conversationId: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.conversationId === conversationId) {
        this.pendingApprovals.delete(id)
        pending.resolve(false)
      }
    }
  }
}

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user")
  const text = firstUser?.content.find((block) => block.type === "text")
  const raw = text && text.type === "text" ? text.text.trim() : ""
  if (!raw) return "New conversation"
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
}
