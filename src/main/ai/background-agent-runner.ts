import type { AgentTriggerBudget, NormalizedCapability, TriggerUse } from "@synapse/plugin-manifest"
import type { GrantIdentity } from "../plugins/grant-store"
import type { RootBudgetLedgerStore } from "./budget/root-budget-ledger"
import type { EstimatorQuarantineStore } from "./estimator-quarantine-store"
import type { ChatMessage, ChatProvider, TokenUsage } from "./providers/types"
import type { RunTrace, TraceUpsertInput, TraceUpsertReceipt } from "./run-trace-store"
import type { AgentRunStore } from "./runs/agent-run-store"
import type { RunFinalizerDeps } from "./runs/run-finalizer"
import type { ToolHostPort } from "./tool-registry"
import type { WorkspaceRootStore } from "./workspace/workspace-root-store"
import {
  declaredCredentialBrokerScopeContains,
  declaredNetworkScopeContains,
  getCapability,
  stableStringify,
} from "@synapse/plugin-manifest"
import { AgentBudgetLedger } from "../plugins/agent-budget"
import { DEFAULT_ANTHROPIC_MODEL } from "./providers/anthropic-provider"
import { resolveModelCapabilityProfile } from "./providers/model-capability-profile"
import { emptyUsage } from "./providers/types"
import { StaleRevisionError } from "./runs/agent-run-store"
import { setupBackgroundRun } from "./runs/background-run-setup"
import { toChatMessages } from "./runs/durable-messages"
import { runInteractiveTurn } from "./runs/interactive-run-driver"
import { finalizeRun } from "./runs/run-finalizer"
import { AiToolRegistry } from "./tool-registry"

export interface BackgroundAgentRunInput {
  pluginId: string
  pluginIdentity: GrantIdentity
  triggerId: string
  instanceId: string
  workspaceId: string
  invocationId: string
  event: unknown
  allowedUses: TriggerUse[]
  agent: AgentTriggerBudget
  instruction: string
  signal?: AbortSignal
}

export interface BackgroundAgentRunResult {
  messages: ChatMessage[]
  stopReason: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
  usage: TokenUsage
}

export interface BackgroundAgentRunnerOptions {
  provider: ChatProvider
  tools: ToolHostPort
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  upsertTrace: (input: TraceUpsertInput) => TraceUpsertReceipt
  ledger?: AgentBudgetLedger
  model?: string
  now?: () => number
  /** Forwarded to run-trace-store so background runs are traced too. */
  recordRun?: (trace: RunTrace) => void
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
  estimatorQuarantine?: EstimatorQuarantineStore
}

export class BackgroundAgentRunner {
  private readonly ledger: AgentBudgetLedger
  private readonly now: () => number

  constructor(private readonly options: BackgroundAgentRunnerOptions) {
    this.ledger = options.ledger ?? new AgentBudgetLedger()
    this.now = options.now ?? Date.now
  }

  async run(input: BackgroundAgentRunInput): Promise<BackgroundAgentRunResult> {
    const providerId = this.options.provider.id
    const model = this.options.model ?? DEFAULT_ANTHROPIC_MODEL
    const runBudget = input.agent.maxTokensPerRun > 0 ? input.agent.maxTokensPerRun : undefined
    // Admission is intentionally before tryStart: a quarantined profile did
    // not start a run and must not consume this trigger's maxRuns window.
    if (runBudget !== undefined) {
      await this.options.estimatorQuarantine?.assertAllowed(
        resolveModelCapabilityProfile(providerId, model)
      )
    }
    const start = this.ledger.tryStart(
      { pluginId: input.pluginId, triggerId: input.triggerId, workspaceId: input.workspaceId },
      input.agent
    )
    if (!start.ok) {
      return { messages: [], stopReason: "budget_exceeded", usage: emptyUsage() }
    }

    const resolvedRoots = await this.options.workspaceRoots.listForWorkspace(input.workspaceId)
    const tools = new AiToolRegistry(this.limitedTools(input.allowedUses))

    const controller = new AbortController()
    const abortInput = () => controller.abort()
    input.signal?.addEventListener("abort", abortInput, { once: true })

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const checkpoint = await setupBackgroundRun(
        {
          runStore: this.options.runStore,
          budgetStore: this.options.budgetStore,
          tools,
          now: this.now,
        },
        {
          runId: start.runId,
          workspaceId: input.workspaceId,
          invocationId: input.invocationId,
          triggerInstanceId: input.instanceId,
          pluginId: input.pluginId,
          pluginIdentity: input.pluginIdentity,
          triggerId: input.triggerId,
          allowedUses: input.allowedUses,
          instruction: input.instruction,
          event: input.event,
          providerId,
          model,
          // Background triggers commonly configure a small maxTokensPerRun
          // (see resources/builtin-plugins/*/synapse.json) — unlike the
          // interactive path's fixed 4096, this must fit within whatever
          // budget was actually configured, or every run would fail closed
          // on its very first admission regardless of how modest the
          // request actually is.
          maxOutputTokens: runBudget !== undefined ? Math.min(4096, runBudget) : 4096,
          runBudgetTokens: runBudget,
          maxSteps: input.agent.maxToolCallsPerRun + 1,
          maxToolCallsPerRun: input.agent.maxToolCallsPerRun,
          timeoutMs: input.agent.timeoutMs,
          executionWorkspaces: resolvedRoots,
        }
      )
      const deadlineAt = checkpoint.config.deadlineAt
      if (deadlineAt !== undefined) {
        timeout = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - this.now()))
      }

      const outcome = await runInteractiveTurn(
        {
          model: {
            runStore: this.options.runStore,
            budgetStore: this.options.budgetStore,
            provider: this.options.provider,
            tools: () => tools.list(),
            assertEstimatorAllowed: async (cp) => {
              await this.options.estimatorQuarantine?.assertAllowed(cp.config.resolvedProfile)
            },
            now: this.now,
            maxSteps: checkpoint.config.maxSteps,
            signal: controller.signal,
          },
          toolBatch: {
            tools,
            caller: {
              kind: "background-agent",
              runId: start.runId,
              workspaceId: input.workspaceId,
              invocationId: input.invocationId,
              triggerInstanceId: input.instanceId,
            },
            // Background runs have no UI to prompt — the whole approval
            // decision is this hard resolver (a per-run tool-call budget
            // check), which always resolves definitively, so
            // requestApproval is unreachable in practice; it throws rather
            // than silently allowing/denying if that assumption ever breaks.
            resolver: async () => {
              // Persist the debit before a call can be dispatched. A process
              // death can waste one slot, but can never mint a fresh allowance.
              for (;;) {
                const loaded = await this.options.runStore.load(start.runId)
                if (!loaded.ok)
                  throw new Error(`background run ${start.runId} checkpoint is ${loaded.reason}`)
                const consumed = loaded.checkpoint.backgroundExecutionLedger?.toolCallsConsumed
                if (consumed === undefined || consumed >= input.agent.maxToolCallsPerRun)
                  return "deny"
                try {
                  await this.options.runStore.mutate(
                    start.runId,
                    loaded.checkpoint.revision,
                    (cp) => ({
                      ...cp,
                      backgroundExecutionLedger: { toolCallsConsumed: consumed + 1 },
                      updatedAt: this.now(),
                    })
                  )
                  return "allow"
                } catch (err) {
                  if (!(err instanceof StaleRevisionError)) throw err
                }
              }
            },
            requestApproval: () => {
              throw new Error("background-agent runs never prompt for interactive approval")
            },
            now: this.now,
          },
          signal: controller.signal,
          finalize: (runId, finalizeInput) =>
            finalizeRun(this.finalizerDeps(), runId, finalizeInput),
          buildResourceReleasePlan: () => ({
            budgetOperationIds: [],
            skillPackageLeaseIds: [],
            releaseArtifactRunPin: false,
            adoptionLeaseIds: [],
          }),
          quarantineEstimatorProfile: async (failedCheckpoint) => {
            await this.options.estimatorQuarantine?.quarantine(
              failedCheckpoint.config.resolvedProfile
            )
          },
        },
        start.runId
      )

      const trace = outcome.checkpoint.finalization?.trace
      if (trace) this.options.recordRun?.(trace)

      if (outcome.kind === "suspended_unknown_tool_outcome") {
        // Unreachable for a single-process background run: execution errors
        // are always caught and resolved synchronously (see
        // tool-batch-runner.ts's executionPhase), so a call is only ever
        // left "started" by a genuine process crash mid-invocation, which
        // requires a separate resume call this method never makes.
        throw new Error(`background run ${start.runId} unexpectedly suspended`)
      }

      return {
        messages: toChatMessages(outcome.checkpoint.messages),
        stopReason: outcome.stopReason,
        usage: outcome.checkpoint.usage,
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abortInput)
      this.ledger.finish(start.runId)
    }
  }

  private finalizerDeps(): RunFinalizerDeps {
    return {
      runStore: this.options.runStore,
      upsertTrace: this.options.upsertTrace,
      releaseResources: async () => {},
      now: this.now,
    }
  }

  private limitedTools(allowedUses: TriggerUse[]): ToolHostPort {
    return {
      listTools: () =>
        this.options.tools
          .listTools()
          .filter((tool) =>
            toolCapabilitiesAllowed(tool.manifestTool.capabilities ?? [], allowedUses)
          ),
      invokeTool: (fqName, input, options) => this.options.tools.invokeTool(fqName, input, options),
    }
  }
}

function toolCapabilitiesAllowed(
  capabilities: readonly NormalizedCapability[],
  allowedUses: readonly TriggerUse[]
): boolean {
  return capabilities.every((capability) =>
    allowedUses.some((use) => triggerUseContainsCapability(use, capability))
  )
}

function triggerUseContainsCapability(use: TriggerUse, requested: NormalizedCapability): boolean {
  if (use.capability !== requested.id) return false
  const descriptor = getCapability(requested.id)
  if (!descriptor) return false
  if (!descriptor.scopeEnforced) return true
  if (!descriptor.scopeAdapter) return false
  if (use.scope === undefined || requested.scope === undefined) return false
  const allowedScope = descriptor.scopeAdapter.canonicalize(use.scope)
  const requestedScope = descriptor.scopeAdapter.canonicalize(requested.scope)
  if (stableStringify(allowedScope) === stableStringify(requestedScope)) return true
  if (requested.id === "network:https") {
    return declaredNetworkScopeContains(use.scope, requested.scope)
  }
  if (requested.id === "credentials:broker") {
    return declaredCredentialBrokerScopeContains(use.scope, requested.scope)
  }
  return descriptor.scopeAdapter.contains(allowedScope, requested.scope)
}
