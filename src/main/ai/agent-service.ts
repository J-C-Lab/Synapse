import type { AgentRunEvent } from "@synapse/agent-protocol"
import type { AiSettingsStore, ToolResilienceSettings } from "./ai-settings-store"
import type { ApprovalDecision } from "./approval-gate"
import type { ApprovalStore } from "./approval-store"
import type { RootBudgetLedgerStore } from "./budget/root-budget-ledger"
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
import type { ChatProvider, ProviderToolSchema, TokenUsage } from "./providers/types"
import type { RunTrace, TraceUpsertInput, TraceUpsertReceipt } from "./run-trace-store"
import type { AgentRunStore } from "./runs/agent-run-store"
import type { AgentRunCheckpointV1 } from "./runs/checkpoint-schema"
import type { DurableApprovalPolicyInput } from "./runs/durable-approval"
import type { RunEventStore } from "./runs/run-event-store"
import type { RunFinalizerDeps } from "./runs/run-finalizer"
import type { ToolStatSnapshot } from "./tool-circuit-breaker"
import type { AiToolRegistry } from "./tool-registry"
import type { WorkspaceRootStore } from "./workspace/workspace-root-store"
import type { Workspace, WorkspaceStore } from "./workspace/workspace-store"
import { randomUUID } from "node:crypto"
import { logger } from "../logging"
import { DEFAULT_TOOL_RESILIENCE } from "./ai-settings-store"
import { DEFAULT_ANTHROPIC_MODEL } from "./providers/anthropic-provider"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "./providers/catalog"
import { runInteractiveTurn } from "./runs/interactive-run-driver"
import { setupInteractiveRun } from "./runs/interactive-run-setup"
import { createRunEventEmitter } from "./runs/run-event-emitter"
import { finalizeRun } from "./runs/run-finalizer"
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
  /** Durable checkpoint store — every interactive turn's run of record. */
  runStore: AgentRunStore
  /** Durable per-root-run token budget ledger. */
  budgetStore: RootBudgetLedgerStore
  /** Durable append-only event journal — renderer-facing run projections
   *  (Task 15) read from this. */
  eventStore: RunEventStore
  /** Real-time push side of the subscribeRun channel (P1-2) — fired for
   *  every event as it's durably appended, so a subscribed renderer window
   *  never has to poll. Optional: omitting it keeps event emission fully
   *  poll-only (getRunEventsSince still works), matching every pre-P1-2
   *  caller. */
  onRunEvent?: (event: AgentRunEvent) => void
  /** Strict, idempotent terminal-finalization trace write (design §"Terminal
   *  finalization across stores"). Distinct from `recordRun` below, which is
   *  a best-effort convenience callback fired with the same trace. */
  upsertTrace: (input: TraceUpsertInput) => TraceUpsertReceipt
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
  resolve: (outcome: { allowed: boolean; remember: RememberScope }) => void
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
  /** runId → its AbortController. Run-id-keyed (not conversation-id-keyed):
   *  cancellation now targets the specific durable run in flight, consulted
   *  via `conversationRuns` below rather than assumed unique per conversation. */
  private readonly runAborts = new Map<string, AbortController>()
  /** conversationId → the runId currently active for it, so `cancel()`'s
   *  public conversation-scoped API can find the right AbortController. */
  private readonly conversationRuns = new Map<string, string>()
  /** runId → conversationId for the currently active turn(s). */
  private readonly activeRunConversations = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly conversationAllow = new Map<string, Set<string>>()
  private readonly permanentAllow = new Set<string>()
  private permanentAllowLoaded = false
  private startupReconciliation: Promise<void> | undefined

  constructor(private readonly options: AgentServiceOptions) {}

  /**
   * Startup readiness barrier (design §"Run recovery service and startup
   * UX"): runs the recovery scan at most once and makes every later chat()
   * call await it, so a stale/terminalizing conversation lease from a prior
   * process is never raced by a fresh interactive turn. Never called by
   * default — every caller that doesn't wire a recovery service keeps
   * working exactly as before; chat() just skips the (unset) barrier.
   */
  async reconcileRunsAtStartup(recovery: {
    listRecoverable: () => Promise<unknown>
  }): Promise<void> {
    if (!this.startupReconciliation) {
      this.startupReconciliation = recovery.listRecoverable().then(() => undefined)
    }
    await this.startupReconciliation
  }

  private async ensureStartupReconciled(): Promise<void> {
    if (this.startupReconciliation) await this.startupReconciliation
  }

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

  /** Delete is a durable user decision: write the tombstone before signalling
   * an in-process cancellation, so a crash between the two can never let the
   * old run revive the conversation on startup. */
  async deleteConversation(id: string): Promise<void> {
    await this.options.conversations.delete(id)
    this.cancel(id)
  }

  /** Run one chat turn, streaming events. Resolves when the turn completes.
   *
   *  Runs through the durable pipeline (design §"Replace AgentService.chat()'s
   *  in-memory run setup"): setupInteractiveRun() acquires the conversation
   *  lease and creates the checkpoint, runInteractiveTurn() drives it to a
   *  terminal outcome and finalizes it (commits the conversation, upserts the
   *  trace, releases resources) via finalizeRun(). A conversation that never
   *  existed is created empty first, matching the old persist()-based
   *  get-or-create behavior — chat() has never required an explicit
   *  createConversation() call first. */
  async chat(
    conversationId: string,
    text: string
  ): Promise<{ stopReason: string; usage: TokenUsage }> {
    await this.ensureStartupReconciled()
    const { providerId, model } = await this.selection()
    const apiKey = await this.options.credentials.get(providerId)
    if (!apiKey) throw new AgentMissingKeyError()

    const settings = this.options.settings ? await this.options.settings.get() : undefined
    const budgetTokens = settings?.budgetTokens ?? 0
    const resolvedBudget = budgetTokens > 0 ? budgetTokens : undefined
    const cfg = settings?.contextCompression

    const existing = await this.options.conversations.get(conversationId)
    const workspaceId = existing?.workspaceId ?? "default"
    if (!existing) {
      await this.options.conversations.save({
        id: conversationId,
        workspaceId,
        messages: [],
        createdAt: this.now(),
        updatedAt: this.now(),
      })
    }
    const resolvedExecutionRoots = (await this.options.getExecutionWorkspaces?.(workspaceId)) ?? []

    const runId = randomUUID()

    try {
      const checkpoint = await setupInteractiveRun(
        {
          runStore: this.options.runStore,
          budgetStore: this.options.budgetStore,
          conversations: this.options.conversations,
          tools: this.options.tools,
          now: this.now,
        },
        {
          runId,
          conversationId,
          workspaceId,
          text,
          providerId,
          model,
          maxOutputTokens: 4096,
          runBudgetTokens: resolvedBudget,
          maxSteps: 10,
          contextCompression: {
            enabled: cfg?.enabled ?? false,
            thresholdTokens: cfg?.thresholdTokens ?? 0,
            keepRecentFraction: 0.5,
            hardReserveTokens: 0,
          },
          executionWorkspaces: resolvedExecutionRoots,
        }
      )

      return await this.driveRun({
        runId,
        conversationId,
        checkpoint,
        providerId,
        apiKey,
        emitRunStarted: { workspaceId },
      })
    } catch (err) {
      this.options.sendEvent({
        type: "error",
        conversationId,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /** Re-drives an already-persisted, non-terminal interactive checkpoint from
   *  wherever it left off — the real continuation `AgentRunRecoveryService
   *  .resume()` never performed on its own (that method only flips the
   *  durable status field back to "running"). Reconstructs the provider from
   *  the checkpoint's own FROZEN providerId/model (design intent: a resume
   *  replays what the run already committed to, not whatever the live
   *  settings happen to be today) rather than `this.selection()`. Called by
   *  the startup auto-resume orchestrator and by the `runs:resume` IPC
   *  handler, never awaited by their callers — a slow resumed turn must never
   *  block the caller. */
  async continueRun(runId: string): Promise<{ stopReason: string; usage: TokenUsage }> {
    const result = await this.options.runStore.load(runId)
    if (!result.ok) {
      throw new Error(`cannot continue run ${runId}: checkpoint is ${result.reason}`)
    }
    const checkpoint = result.checkpoint
    if (checkpoint.identity.origin !== "interactive") {
      throw new Error(
        `continueRun is for interactive-origin runs only (run ${runId} is ${checkpoint.identity.origin})`
      )
    }
    const conversationId = checkpoint.identity.conversationId
    if (!conversationId) {
      throw new Error(`interactive run ${runId} has no bound conversationId — cannot continue it`)
    }
    const { providerId } = checkpoint.config
    const apiKey = await this.options.credentials.get(providerId)
    if (!apiKey) throw new AgentMissingKeyError()

    try {
      return await this.driveRun({ runId, conversationId, checkpoint, providerId, apiKey })
    } catch (err) {
      this.options.sendEvent({
        type: "error",
        conversationId,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /** The shared turn body every interactive run (fresh or resumed) drives
   *  through: provider + event-emitter construction, the durable outer loop,
   *  and renderer event forwarding. `emitRunStarted` is only passed for a
   *  genuinely new run — a resumed run's `run_started` event was already
   *  emitted the first time it was created. */
  private async driveRun(params: {
    runId: string
    conversationId: string
    checkpoint: AgentRunCheckpointV1
    providerId: string
    apiKey: string
    emitRunStarted?: { workspaceId: string }
  }): Promise<{ stopReason: string; usage: TokenUsage }> {
    const { runId, conversationId, checkpoint, providerId, apiKey } = params
    this.registerRun(runId, conversationId)
    this.conversationRuns.set(conversationId, runId)

    const controller = new AbortController()
    this.runAborts.set(runId, controller)
    let stopLeaseHeartbeat: (() => void) | undefined

    const textBatcher = createTextDeltaBatcher((delta) =>
      this.options.sendEvent({ type: "text", conversationId, delta })
    )

    try {
      const provider = this.createProviderFor(providerId, apiKey)
      const eventEmitter = await createRunEventEmitter(
        this.options.eventStore,
        {
          runId,
          rootRunId: checkpoint.identity.rootRunId,
          conversationId,
        },
        this.now,
        undefined,
        this.options.onRunEvent
      )
      const lease = checkpoint.conversationCommit
      if (lease) {
        // The store lease lasts 30 seconds. Renew well inside that window;
        // a stale fencing token means another owner won, so immediately stop
        // this driver before it can issue another provider/tool operation.
        let renewing = false
        const timer = setInterval(() => {
          if (renewing || controller.signal.aborted) return
          renewing = true
          void this.options.conversations
            .renewRunLease(conversationId, runId, lease.leaseFencingToken)
            .catch(() => controller.abort())
            .finally(() => {
              renewing = false
            })
        }, 10_000)
        stopLeaseHeartbeat = () => clearInterval(timer)
      }
      if (params.emitRunStarted) {
        await eventEmitter.emit({
          type: "run_started",
          origin: "interactive",
          workspaceId: params.emitRunStarted.workspaceId,
        })
      }

      const outcome = await runInteractiveTurn(
        {
          model: {
            runStore: this.options.runStore,
            budgetStore: this.options.budgetStore,
            provider,
            tools: () => this.options.tools.list(),
            now: this.now,
            maxSteps: checkpoint.config.maxSteps,
            onTextDelta: (delta) => textBatcher.push(delta),
            eventEmitter,
          },
          toolBatch: {
            tools: this.options.tools,
            caller: { kind: "agent", conversationId, runId },
            resolver: (policyInput) =>
              this.resolveDurableApprovalPolicy(conversationId, policyInput),
            requestApproval: (approvalId, policyInput) =>
              this.requestDurableApproval(conversationId, approvalId, policyInput, textBatcher),
            now: this.now,
            onToolCall: (call) => {
              textBatcher.flush()
              const fqName = this.options.tools.describe(call.name)?.fqName ?? call.name
              this.options.sendEvent({
                type: "tool_call",
                conversationId,
                id: call.id,
                name: fqName,
                input: call.input,
              })
            },
            onToolResult: (result) => {
              textBatcher.flush()
              this.options.sendEvent({
                type: "tool_result",
                conversationId,
                id: result.id,
                isError: result.isError,
              })
            },
            eventEmitter,
          },
          signal: controller.signal,
          finalize: (rid, input) => finalizeRun(this.finalizerDeps(eventEmitter), rid, input),
          buildResourceReleasePlan: () => ({
            budgetOperationIds: [],
            skillPackageLeaseIds: [],
            releaseArtifactRunPin: false,
            adoptionLeaseIds: [],
          }),
        },
        runId
      )

      const trace = outcome.checkpoint.finalization?.trace
      if (trace) this.options.recordRun?.(trace)

      const stopReason: string =
        outcome.kind === "suspended_unknown_tool_outcome" ? "suspended" : outcome.stopReason
      const usage = outcome.checkpoint.usage
      this.options.sendEvent({ type: "done", conversationId, stopReason, usage })
      return { stopReason, usage }
    } finally {
      stopLeaseHeartbeat?.()
      textBatcher.flush()
      textBatcher.dispose()
      this.runAborts.delete(runId)
      if (this.conversationRuns.get(conversationId) === runId) {
        this.conversationRuns.delete(conversationId)
      }
      this.failPendingApprovals(conversationId)
      this.activeRunConversations.delete(runId)
      this.options.planRegistry?.clear(runId)
    }
  }

  private finalizerDeps(eventEmitter?: RunFinalizerDeps["eventEmitter"]): RunFinalizerDeps {
    return {
      runStore: this.options.runStore,
      conversation: this.options.conversations,
      upsertTrace: this.options.upsertTrace,
      releaseResources: async () => {},
      now: this.now,
      eventEmitter,
    }
  }

  /** The durable tool-batch runner's hard-policy resolver — permanent/
   *  conversation "always allow" and the injected approvalResolver policy
   *  hook, ahead of the annotation heuristic. Mirrors the first stages of
   *  the old in-memory approve() exactly. */
  private async resolveDurableApprovalPolicy(
    conversationId: string,
    policyInput: DurableApprovalPolicyInput
  ): Promise<ApprovalDecision | undefined> {
    await this.ensurePermanentAllowLoaded()
    if (
      this.permanentAllow.has(policyInput.fqName) ||
      this.allowSet(conversationId).has(policyInput.fqName)
    ) {
      return "allow"
    }
    const policyDecision = await this.options.approvalResolver?.({
      conversationId,
      safeName: policyInput.safeName,
      fqName: policyInput.fqName,
      input: policyInput.input,
    })
    if (policyDecision === "deny" || policyDecision === "allow") return policyDecision
    return undefined
  }

  /** Only reached for a call the policy resolver and annotation heuristic
   *  both left as "ask" — persists the pending approval and emits the same
   *  approval_request event the renderer already handles. */
  private requestDurableApproval(
    conversationId: string,
    approvalId: string,
    policyInput: DurableApprovalPolicyInput,
    textBatcher: TextDeltaBatcher
  ): Promise<{ allowed: boolean; remember: RememberScope }> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, {
        resolve,
        fqName: policyInput.fqName,
        conversationId,
        input: policyInput.input,
      })
      textBatcher.flush()
      this.options.sendEvent({
        type: "approval_request",
        conversationId,
        approvalId,
        toolName: policyInput.fqName,
        input: policyInput.input,
      })
    })
  }

  /** Cancel an in-flight turn. */
  cancel(conversationId: string): void {
    const runId = this.conversationRuns.get(conversationId)
    if (runId) this.runAborts.get(runId)?.abort()
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
    pending.resolve({ allowed: allow, remember })
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
        pending.resolve({ allowed: false, remember: "once" })
      }
    }
  }
}

interface TextDeltaBatcher {
  push: (delta: string) => void
  flush: () => void
  dispose: () => void
}

/** Coalesce high-frequency provider text deltas before IPC to the renderer. */
function createTextDeltaBatcher(send: (delta: string) => void, intervalMs = 32): TextDeltaBatcher {
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
