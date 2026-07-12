import type { AgentEvent, ToolApprovalOutcome } from "./agent-runtime"
import type { AiSettingsStore, ToolResilienceSettings } from "./ai-settings-store"
import type { ApprovalDecision } from "./approval-gate"
import type { ApprovalStore } from "./approval-store"
import type {
  ConversationStore,
  ConversationSummary,
  StoredConversation,
} from "./conversation-store"
import type { AiCredentialStore } from "./credential-store"
import type { WorkspaceRootRecord } from "./execution/types"
import type { McpClientManager, McpServerStatus } from "./mcp-client-manager"
import type { McpServerConfig, McpServerConfigStore } from "./mcp-server-config-store"
import type { PlanStep } from "./plan/plan-types"
import type { RunPlanRegistry } from "./plan/run-plan-registry"
import type { ProviderDescriptor } from "./providers/catalog"
import type { ChatMessage, ChatProvider, ProviderToolSchema, TokenUsage } from "./providers/types"
import type { RunTrace } from "./run-trace-store"
import type { ToolStatSnapshot } from "./tool-circuit-breaker"
import type { AiToolRegistry } from "./tool-registry"
import type { WorkspaceRootStore } from "./workspace/workspace-root-store"
import type { Workspace, WorkspaceStore } from "./workspace/workspace-store"
import { randomUUID } from "node:crypto"
import { logger } from "../logging"
import { AgentRuntime } from "./agent-runtime"
import { DEFAULT_TOOL_RESILIENCE } from "./ai-settings-store"
import { decideApproval } from "./approval-gate"
import { ContextCompressor } from "./context/context-compressor"
import { summarizeViaProvider } from "./context/summarize-via-provider"
import { DEFAULT_ANTHROPIC_MODEL } from "./providers/anthropic-provider"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "./providers/catalog"
import { buildInteractiveRun } from "./run-provenance"
import { DEFAULT_WORKSPACE } from "./workspace/workspace-store"

// Assembles the AI pieces (credentials + provider catalog + tools + runtime +
// stores) into the surface the IPC layer drives. Owns provider selection (BYOK,
// P5b), conversation persistence, the approval round-trip, cancellation, and
// remembered allow-decisions.

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
  | { type: "plan"; conversationId: string; runId: string; steps: PlanStep[] }

export interface ToolApprovalContext {
  conversationId: string
  safeName: string
  fqName: string
  input: unknown
}

export interface AgentServiceOptions {
  credentials: AiCredentialStore
  tools: AiToolRegistry
  conversations: ConversationStore
  workspaces?: Pick<WorkspaceStore, "exists" | "isActive"> &
    Partial<Pick<WorkspaceStore, "list" | "create" | "rename" | "archive" | "unarchive">>
  sendEvent: (event: AiChatEvent) => void
  /** Policy hook that can hard-deny or auto-allow before the annotation gate. */
  approvalResolver?: (context: ToolApprovalContext) => Promise<ApprovalDecision | undefined>
  /** BYOK provider catalog. Defaults to {@link defaultProviderCatalog}. */
  providers?: ProviderDescriptor[]
  /** Active provider + per-provider model. Omitted → in-memory defaults. */
  settings?: AiSettingsStore
  /** Override how a provider is built from a key. Injectable for tests. */
  createProvider?: (providerId: string, apiKey: string) => ChatProvider
  /** Persists "always allow" tool decisions across restarts. Optional in tests. */
  approvals?: ApprovalStore
  now?: () => number
  /** External MCP servers (P5). Omitted in tests that don't exercise MCP. */
  mcp?: {
    configs: McpServerConfigStore
    manager: McpClientManager
  }
  /** Authorized execution roots for a given workspace (drives routing
   *  guidance + tool availability). Caller-scoped — the conversation's own
   *  bound workspace, not a global list. */
  getExecutionWorkspaces?: (workspaceId: string) => Promise<readonly WorkspaceRootRecord[]>
  /** Per-workspace execution root management. Optional in tests that don't
   *  exercise root CRUD. */
  workspaceRoots?: Partial<
    Pick<WorkspaceRootStore, "listAll" | "listForWorkspace" | "create" | "remove" | "setPrimary">
  >
  /** Fired after a root is created or removed, so the execution tool host's
   *  cached "any root exists" visibility gate can be refreshed. */
  onWorkspaceRootsChanged?: () => void
  /** Opens a native folder picker, resolving to the chosen absolute path or
   *  null if cancelled. Electron-main-only — injected rather than
   *  implemented here, since `AgentService` itself has no `dialog` access. */
  pickWorkspaceRootDirectory?: () => Promise<string | null>
  /** Global master switch for local execution. Root CRUD is blocked when false. */
  isAgentShellAllowed?: () => boolean
  /** Sink for per-run summary traces. Omitted in tests that don't assert tracing. */
  recordRun?: (trace: RunTrace) => void
  /** Reads back the most recent plan recorded for a conversation, so reselecting it can restore the Progress card. */
  getLatestPlan?: (conversationId: string) => PlanStep[] | undefined
  /** The in-run plan store, so chat() can clear it per turn and expose getPlan. */
  planRegistry?: RunPlanRegistry
  /** Fired at the start of each interactive turn with the resolved per-run token budget. */
  onTurnStart?: (ctx: { runId: string; budgetTokens: number | undefined }) => void
  /** Fired when an interactive turn ends so per-run budget state can be cleared. */
  onTurnEnd?: (ctx: { runId: string }) => void
  /** Per-tool circuit-breaker health snapshots, surfaced to the renderer. */
  getToolHealth?: () => ToolStatSnapshot[]
  /** Applied when tool-resilience settings change so the live host can retune. */
  onToolResilienceChange?: (settings: ToolResilienceSettings) => void
}

export class AgentMissingKeyError extends Error {
  constructor() {
    super("No API key configured for the AI provider.")
    this.name = "AgentMissingKeyError"
  }
}

interface PendingApproval {
  resolve: (outcome: ToolApprovalOutcome) => void
  fqName: string
  conversationId: string
  input: unknown
}

export interface AiProviderStatus {
  id: string
  label: string
  hasKey: boolean
  model: string
  models: string[]
}

export interface AiStatus {
  /** Active provider id. */
  provider: string
  /** Whether the active provider has a key (drives the key-entry empty state). */
  hasKey: boolean
  /** Active provider's selected model. */
  model: string
  providers: AiProviderStatus[]
  /** Per-run token budget; 0 means unlimited. */
  budgetTokens: number
  contextCompression: { enabled: boolean; thresholdTokens: number }
  toolResilience: ToolResilienceSettings
}

export class AgentService {
  private readonly aborts = new Map<string, AbortController>()
  /** runId → conversationId for the currently active turn(s). */
  private readonly activeRunConversations = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly conversationAllow = new Map<string, Set<string>>()
  private readonly permanentAllow = new Set<string>()
  private permanentAllowLoaded = false
  private approvalCounter = 0

  constructor(private readonly options: AgentServiceOptions) {}

  /** Seed permanentAllow from the persisted store once (lazy). */
  private async ensurePermanentAllowLoaded(): Promise<void> {
    if (this.permanentAllowLoaded) return
    this.permanentAllowLoaded = true
    if (!this.options.approvals) return
    for (const fqName of await this.options.approvals.list()) this.permanentAllow.add(fqName)
  }

  private get now(): () => number {
    return this.options.now ?? Date.now
  }

  private get catalog(): ProviderDescriptor[] {
    return this.options.providers ?? defaultProviderCatalog()
  }

  private get defaultProviderId(): string {
    return this.catalog[0]?.id ?? DEFAULT_PROVIDER_ID
  }

  /** Resolve the active provider id and the model it should run. */
  private async selection(): Promise<{ providerId: string; model: string }> {
    const settings = this.options.settings ? await this.options.settings.get() : undefined
    const providerId = settings?.activeProvider ?? this.defaultProviderId
    const descriptor = this.catalog.find((provider) => provider.id === providerId)
    const model =
      settings?.models[providerId] ?? descriptor?.defaultModel ?? DEFAULT_ANTHROPIC_MODEL
    return { providerId, model }
  }

  private createProviderFor(providerId: string, apiKey: string): ChatProvider {
    if (this.options.createProvider) return this.options.createProvider(providerId, apiKey)
    const descriptor = this.catalog.find((provider) => provider.id === providerId)
    if (!descriptor) throw new Error(`Unknown provider: ${providerId}`)
    return descriptor.create(apiKey)
  }

  async createBackgroundAgentProvider(): Promise<{ provider: ChatProvider; model: string }> {
    const { providerId, model } = await this.selection()
    const apiKey = await this.options.credentials.get(providerId)
    if (!apiKey) throw new AgentMissingKeyError()
    return { provider: this.createProviderFor(providerId, apiKey), model }
  }

  async getStatus(): Promise<AiStatus> {
    const { providerId, model } = await this.selection()
    const settings = this.options.settings ? await this.options.settings.get() : undefined
    const providers = await Promise.all(
      this.catalog.map(async (provider) => ({
        id: provider.id,
        label: provider.label,
        hasKey: await this.options.credentials.has(provider.id),
        model: settings?.models[provider.id] ?? provider.defaultModel,
        models: provider.models,
      }))
    )
    const active = providers.find((provider) => provider.id === providerId)
    return {
      provider: providerId,
      hasKey: active?.hasKey ?? false,
      model,
      providers,
      budgetTokens: settings?.budgetTokens ?? 0,
      contextCompression: settings?.contextCompression ?? { enabled: false, thresholdTokens: 0 },
      toolResilience: settings?.toolResilience ?? DEFAULT_TOOL_RESILIENCE,
    }
  }

  async setKey(providerId: string, key: string): Promise<void> {
    await this.options.credentials.set(providerId, key)
  }

  async deleteKey(providerId: string): Promise<void> {
    await this.options.credentials.delete(providerId)
  }

  /** Switch the active provider used for new turns. */
  async setActiveProvider(providerId: string): Promise<void> {
    if (!this.catalog.some((provider) => provider.id === providerId)) {
      throw new Error(`Unknown provider: ${providerId}`)
    }
    if (this.options.settings) await this.options.settings.setActiveProvider(providerId)
  }

  /** Choose the model a provider should use. */
  async setModel(providerId: string, model: string): Promise<void> {
    if (this.options.settings) await this.options.settings.setModel(providerId, model)
  }

  /** Set the per-run token budget (0 = unlimited). */
  async setBudget(tokens: number): Promise<void> {
    if (this.options.settings) await this.options.settings.setBudget(tokens)
  }

  async setContextCompression(value: { enabled: boolean; thresholdTokens: number }): Promise<void> {
    if (this.options.settings) await this.options.settings.setContextCompression(value)
  }

  async setToolResilience(value: ToolResilienceSettings): Promise<void> {
    if (this.options.settings) await this.options.settings.setToolResilience(value)
    this.options.onToolResilienceChange?.(value)
  }

  /** Called by chat() at turn start so plan events can resolve the conversation. */
  registerRun(runId: string, conversationId: string): void {
    this.activeRunConversations.set(runId, conversationId)
  }

  /** Wired to the plan tool source; resolves the conversation and pushes a plan event. */
  emitPlanForRun(runId: string, steps: PlanStep[]): void {
    const conversationId = this.activeRunConversations.get(runId)
    if (!conversationId) return
    try {
      this.options.sendEvent({ type: "plan", conversationId, runId, steps })
    } catch {
      // A UI-push failure must never break the turn.
    }
  }

  private getPlan(runId: string): PlanStep[] | undefined {
    return this.options.planRegistry?.get(runId)
  }

  listTools(): ProviderToolSchema[] {
    return this.options.tools.list()
  }

  /** Per-tool circuit-breaker health (state, success rate, latency). */
  toolHealth(): ToolStatSnapshot[] {
    return this.options.getToolHealth?.() ?? []
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

  async getConversation(
    id: string
  ): Promise<(StoredConversation & { plan?: PlanStep[] }) | undefined> {
    const stored = await this.options.conversations.get(id)
    if (!stored) return undefined
    const plan = this.options.getLatestPlan?.(id)
    return plan && plan.length > 0 ? { ...stored, plan } : stored
  }

  listWorkspaces(options?: { includeArchived?: boolean }): Promise<Workspace[]> {
    if (!this.options.workspaces?.list) return Promise.resolve([DEFAULT_WORKSPACE])
    return this.options.workspaces.list(options)
  }

  createWorkspace(name: string): Promise<Workspace> {
    if (!this.options.workspaces?.create) throw new Error("Workspace store not configured")
    return this.options.workspaces.create(name)
  }

  renameWorkspace(id: string, name: string): Promise<Workspace> {
    if (!this.options.workspaces?.rename) throw new Error("Workspace store not configured")
    return this.options.workspaces.rename(id, name)
  }

  archiveWorkspace(id: string): Promise<Workspace> {
    if (!this.options.workspaces?.archive) throw new Error("Workspace store not configured")
    return this.options.workspaces.archive(id)
  }

  unarchiveWorkspace(id: string): Promise<Workspace> {
    if (!this.options.workspaces?.unarchive) throw new Error("Workspace store not configured")
    return this.options.workspaces.unarchive(id)
  }

  async listWorkspaceRoots(workspaceId: string): Promise<WorkspaceRootRecord[]> {
    if (!this.options.workspaceRoots?.listForWorkspace) return []
    return this.options.workspaceRoots.listForWorkspace(workspaceId)
  }

  async createWorkspaceRoot(
    workspaceId: string,
    name: string,
    root: string,
    role: "primary" | "additional"
  ): Promise<WorkspaceRootRecord> {
    if (this.options.isAgentShellAllowed && !this.options.isAgentShellAllowed()) {
      throw new Error("agent shell is disabled")
    }
    if (!this.options.workspaceRoots?.create) throw new Error("Workspace root store not configured")
    const record = await this.options.workspaceRoots.create(workspaceId, name, root, role)
    this.options.onWorkspaceRootsChanged?.()
    return record
  }

  async removeWorkspaceRoot(id: string): Promise<void> {
    if (!this.options.workspaceRoots?.remove) throw new Error("Workspace root store not configured")
    await this.options.workspaceRoots.remove(id)
    this.options.onWorkspaceRootsChanged?.()
  }

  async setPrimaryWorkspaceRoot(id: string): Promise<void> {
    if (!this.options.workspaceRoots?.setPrimary) {
      throw new Error("Workspace root store not configured")
    }
    await this.options.workspaceRoots.setPrimary(id)
  }

  async pickWorkspaceRootDirectory(): Promise<string | null> {
    if (!this.options.pickWorkspaceRootDirectory) return null
    return this.options.pickWorkspaceRootDirectory()
  }

  async createConversation(workspaceId: string): Promise<{ id: string; workspaceId: string }> {
    const active =
      (await this.options.workspaces?.isActive(workspaceId)) ?? workspaceId === "default"
    if (!active) throw new Error(`Workspace is not active: ${workspaceId}`)
    const id = randomUUID()
    await this.options.conversations.save({
      id,
      workspaceId,
      messages: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    })
    return { id, workspaceId }
  }

  /** Delete a stored conversation. Cancels it first if a turn is in flight. */
  async deleteConversation(id: string): Promise<void> {
    this.cancel(id)
    await this.options.conversations.delete(id)
  }

  /** Run one chat turn, streaming events. Resolves when the turn completes. */
  async chat(
    conversationId: string,
    text: string
  ): Promise<{ stopReason: string; usage: TokenUsage }> {
    const { providerId, model } = await this.selection()
    const apiKey = await this.options.credentials.get(providerId)
    if (!apiKey) throw new AgentMissingKeyError()

    const settings = this.options.settings ? await this.options.settings.get() : undefined
    const budgetTokens = settings?.budgetTokens ?? 0
    const resolvedBudget = budgetTokens > 0 ? budgetTokens : undefined

    const runId = randomUUID()
    this.registerRun(runId, conversationId)
    this.options.onTurnStart?.({ runId, budgetTokens: resolvedBudget })

    const cfg = settings?.contextCompression
    const compressor =
      cfg?.enabled && cfg.thresholdTokens > 0
        ? new ContextCompressor({
            thresholdTokens: cfg.thresholdTokens,
            summarize: async (older) => {
              const provider = this.createProviderFor(providerId, apiKey)
              return summarizeViaProvider(provider, model, older)
            },
          })
        : undefined

    const existing = await this.options.conversations.get(conversationId)
    const workspaceId = existing?.workspaceId ?? "default"
    const provenance = buildInteractiveRun({ runId, conversationId, workspaceId })
    const resolvedExecutionRoots = (await this.options.getExecutionWorkspaces?.(workspaceId)) ?? []

    const runtime = new AgentRuntime({
      provider: this.createProviderFor(providerId, apiKey),
      tools: this.options.tools,
      model,
      budgetTokens: resolvedBudget,
      executionWorkspaces: () => resolvedExecutionRoots,
      recordRun: this.options.recordRun,
      getPlan: (id) => this.getPlan(id),
      compress: compressor ? compressor.compress.bind(compressor) : undefined,
    })
    const messages: ChatMessage[] = existing?.messages ? [...existing.messages] : []
    messages.push({ role: "user", content: [{ type: "text", text }] })

    const controller = new AbortController()
    this.aborts.set(conversationId, controller)

    const textBatcher = createTextDeltaBatcher((delta) =>
      this.options.sendEvent({ type: "text", conversationId, delta })
    )

    try {
      const result = await runtime.run({
        provenance,
        messages,
        signal: controller.signal,
        onText: (delta) => textBatcher.push(delta),
        onEvent: (event) => {
          textBatcher.flush()
          this.forwardAgentEvent(conversationId, event)
        },
        approve: (request) => this.approve(conversationId, request.toolName, request.input),
      })
      textBatcher.flush()
      await this.persist(conversationId, existing, result.messages, workspaceId)
      this.options.sendEvent({
        type: "done",
        conversationId,
        stopReason: result.stopReason,
        usage: result.usage,
      })
      return { stopReason: result.stopReason, usage: result.usage }
    } catch (err) {
      textBatcher.flush()
      this.options.sendEvent({
        type: "error",
        conversationId,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      textBatcher.dispose()
      this.aborts.delete(conversationId)
      this.failPendingApprovals(conversationId)
      this.activeRunConversations.delete(runId)
      this.options.planRegistry?.clear(runId)
      this.options.onTurnEnd?.({ runId })
    }
  }

  /** Cancel an in-flight turn. */
  cancel(conversationId: string): void {
    this.aborts.get(conversationId)?.abort()
    this.failPendingApprovals(conversationId)
  }

  /** Resolve a pending tool approval requested via an `approval_request` event. */
  async resolveApproval(
    approvalId: string,
    allow: boolean,
    remember: RememberScope = "once"
  ): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return
    this.pendingApprovals.delete(approvalId)
    // A user-denied execution tool still gets an audit entry, via the resolver.
    if (!allow && pending.fqName.startsWith("execution:")) {
      await this.options.approvalResolver?.({
        conversationId: pending.conversationId,
        safeName: pending.fqName,
        fqName: pending.fqName,
        input: { userDenied: true, originalInput: pending.input },
      })
    }
    if (allow && remember === "always") {
      this.permanentAllow.add(pending.fqName)
      void this.options.approvals
        ?.add(pending.fqName)
        .catch((err) => logger.child("ai").error("failed to persist always-allow", { err }))
    }
    if (allow && remember === "conversation") {
      this.allowSet(pending.conversationId).add(pending.fqName)
    }
    pending.resolve(
      allow ? { allowed: true, executionAuditDecision: "approved" } : { allowed: false }
    )
  }

  /** Tools the user has permanently allowed (persisted "always" decisions). */
  async listAllowedTools(): Promise<string[]> {
    await this.ensurePermanentAllowLoaded()
    return [...this.permanentAllow].sort()
  }

  /** Revoke a permanent allow: the tool will require approval again. */
  async revokeTool(fqName: string): Promise<void> {
    await this.ensurePermanentAllowLoaded()
    this.permanentAllow.delete(fqName)
    await this.options.approvals?.remove(fqName)
  }

  private async approve(
    conversationId: string,
    safeName: string,
    input: unknown
  ): Promise<ToolApprovalOutcome> {
    await this.ensurePermanentAllowLoaded()
    const descriptor = this.options.tools.describe(safeName)
    const fqName = descriptor?.fqName ?? safeName

    if (this.permanentAllow.has(fqName) || this.allowSet(conversationId).has(fqName)) {
      return { allowed: true, executionAuditDecision: "allow" }
    }

    // Deterministic policy runs before the annotation gate: it can hard-deny a
    // command (never prompting) or auto-allow a recognized safe one.
    const policyDecision = await this.options.approvalResolver?.({
      conversationId,
      safeName,
      fqName,
      input,
    })
    if (policyDecision === "deny") return { allowed: false }
    if (policyDecision === "allow") return { allowed: true, executionAuditDecision: "allow" }

    if (decideApproval(descriptor?.manifestTool.annotations) === "allow") {
      return { allowed: true, executionAuditDecision: "allow" }
    }

    const approvalId = `apr_${++this.approvalCounter}`
    return new Promise<ToolApprovalOutcome>((resolve) => {
      this.pendingApprovals.set(approvalId, { resolve, fqName, conversationId, input })
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
    messages: ChatMessage[],
    workspaceId: string
  ): Promise<void> {
    await this.options.conversations.save({
      id: conversationId,
      title: existing?.title ?? deriveTitle(messages),
      workspaceId: existing?.workspaceId ?? workspaceId,
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
        pending.resolve({ allowed: false })
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

/** Coalesce high-frequency provider text deltas before IPC to the renderer. */
function createTextDeltaBatcher(
  send: (delta: string) => void,
  intervalMs = 32
): { push: (delta: string) => void; flush: () => void; dispose: () => void } {
  let buffer = ""
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!buffer) return
    const delta = buffer
    buffer = ""
    send(delta)
  }

  const push = (delta: string): void => {
    buffer += delta
    if (timer) return
    timer = setTimeout(flush, intervalMs)
  }

  return { push, flush, dispose: flush }
}
