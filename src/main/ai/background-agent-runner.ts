import type { AgentTriggerBudget, NormalizedCapability, TriggerUse } from "@synapse/plugin-manifest"
import type { AgentRunResult, AgentRuntimeOptions } from "./agent-runtime"
import type { ChatMessage, ChatProvider, ProviderStreamEvent } from "./providers/types"
import type { RunTrace } from "./run-trace-store"
import type { ToolHostPort } from "./tool-registry"
import type { WorkspaceRootStore } from "./workspace/workspace-root-store"
import {
  declaredCredentialBrokerScopeContains,
  declaredNetworkScopeContains,
  getCapability,
  stableStringify,
} from "@synapse/plugin-manifest"
import { AgentBudgetLedger } from "../plugins/agent-budget"
import { AgentRuntime } from "./agent-runtime"
import { emptyUsage, totalTokens } from "./providers/types"
import { AiToolRegistry } from "./tool-registry"

export interface BackgroundAgentRunInput {
  pluginId: string
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

export type CreateAgentRuntime = (options: AgentRuntimeOptions) => AgentRuntime

export interface BackgroundAgentRunnerOptions {
  provider: ChatProvider
  tools: ToolHostPort
  ledger?: AgentBudgetLedger
  model?: string
  /** Forwarded to AgentRuntime so background runs are traced too. */
  recordRun?: (trace: RunTrace) => void
  /** Registers the per-run token budget for subagent inheritance. */
  runBudgetRegistry?: {
    set: (runId: string, budgetTokens: number | undefined) => void
    clear: (runId: string) => void
  }
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
  /** Test seam: substitute AgentRuntime construction. */
  createAgentRuntime?: CreateAgentRuntime
}

export class BackgroundAgentRunner {
  private readonly ledger: AgentBudgetLedger
  private readonly createAgentRuntime: CreateAgentRuntime

  constructor(private readonly options: BackgroundAgentRunnerOptions) {
    this.ledger = options.ledger ?? new AgentBudgetLedger()
    this.createAgentRuntime = options.createAgentRuntime ?? ((opts) => new AgentRuntime(opts))
  }

  async run(input: BackgroundAgentRunInput): Promise<AgentRunResult> {
    const start = this.ledger.tryStart(
      { pluginId: input.pluginId, triggerId: input.triggerId, workspaceId: input.workspaceId },
      input.agent
    )
    if (!start.ok) {
      return { messages: [], stopReason: "budget_exceeded", usage: emptyUsage() }
    }

    const resolvedRoots = await this.options.workspaceRoots.listForWorkspace(input.workspaceId)

    const runBudget = input.agent.maxTokensPerRun > 0 ? input.agent.maxTokensPerRun : undefined
    this.options.runBudgetRegistry?.set(start.runId, runBudget)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.agent.timeoutMs)
    const abortInput = () => controller.abort()
    input.signal?.addEventListener("abort", abortInput, { once: true })

    let tokenBudgetExceeded = false
    const provider = this.providerWithTokenBudget(input.agent, start.runId, () => {
      tokenBudgetExceeded = true
      controller.abort()
    })
    const recordRun = this.options.recordRun
    const runtime = this.createAgentRuntime({
      provider,
      tools: new AiToolRegistry(this.limitedTools(input.allowedUses)),
      model: this.options.model,
      maxSteps: input.agent.maxToolCallsPerRun + 1,
      budgetTokens: input.agent.maxTokensPerRun,
      workspaceInstructionRoots: () => resolvedRoots,
      recordRun: recordRun
        ? (trace) =>
            recordRun({
              ...trace,
              outcome: tokenBudgetExceeded ? "budget_exceeded" : trace.outcome,
            })
        : undefined,
    })

    try {
      const result = await runtime.run({
        conversationId: input.invocationId,
        messages: [backgroundUserMessage(input)],
        signal: controller.signal,
        runId: start.runId,
        origin: "background-agent",
        workspaceId: input.workspaceId,
        triggerInstanceId: input.instanceId,
        caller: {
          kind: "background-agent",
          invocationId: input.invocationId,
          runId: start.runId,
          workspaceId: input.workspaceId,
          triggerInstanceId: input.instanceId,
        },
        approve: () => ({ allowed: this.ledger.tryDebitToolCall(start.runId, input.agent) }),
      })
      return tokenBudgetExceeded ? { ...result, stopReason: "budget_exceeded" } : result
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abortInput)
      this.ledger.finish(start.runId)
      this.options.runBudgetRegistry?.clear(start.runId)
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

  private providerWithTokenBudget(
    budget: AgentTriggerBudget,
    runId: string,
    onExceeded: () => void
  ): ChatProvider {
    const provider = this.options.provider
    const ledger = this.ledger
    return {
      id: provider.id,
      async *stream(req): AsyncGenerator<ProviderStreamEvent> {
        for await (const event of provider.stream(req)) {
          if (event.type === "message") {
            const tokens = totalTokens(event.usage)
            if (tokens > 0 && !ledger.tryDebitTokens(runId, budget, tokens)) onExceeded()
          }
          yield event
        }
      },
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

function backgroundUserMessage(input: BackgroundAgentRunInput): ChatMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${input.instruction}\n\nTrigger event:\n${JSON.stringify(input.event)}`,
      },
    ],
  }
}
