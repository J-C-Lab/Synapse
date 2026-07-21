import type { AgentArtifactStore } from "../artifacts/artifact-types"
import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { EstimatorQuarantineStore } from "../estimator-quarantine-store"
import type { ChatMessage, ChatProvider } from "../providers/types"
import type { TraceUpsertInput, TraceUpsertReceipt } from "../run-trace-store"
import type { AgentRunStore } from "../runs/agent-run-store"
import type { RunFinalizerDeps } from "../runs/run-finalizer"
import type { SkillPackageLeaseStore } from "../skills/skill-package-leases"
import type { AiToolRegistry } from "../tool-registry"
import { randomUUID } from "node:crypto"
import { releaseArtifactRunResources } from "../artifacts/artifact-retention"
import { DEFAULT_ANTHROPIC_MODEL } from "../providers/anthropic-provider"
import { toChatMessages } from "../runs/durable-messages"
import { runInteractiveTurn } from "../runs/interactive-run-driver"
import { finalizeRun } from "../runs/run-finalizer"
import { resolveSubagentModelProfile, setupSubagentRun } from "../runs/subagent-run-setup"
import { activeSkillInstructionsReader } from "../skills/skill-activation"
import { releaseSkillPackageLeases } from "../skills/skill-package-leases"

const SUMMARY_MAX = 2000

export interface SubagentRunInput {
  parentRunId: string
  instruction: string
  tools: AiToolRegistry
  maxSteps: number
  signal?: AbortSignal
}

export interface SubagentRunResult {
  summary: string
  childRunId: string
  outcome: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
}

export interface SubagentRunnerOptions {
  provider: ChatProvider
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  upsertTrace: (input: TraceUpsertInput) => TraceUpsertReceipt
  model?: string
  now?: () => number
  estimatorQuarantine?: EstimatorQuarantineStore
  /** Recoverable artifact backend (Checkpoint B). Omitted in tests that
   *  don't exercise artifact retention. */
  artifactStore?: AgentArtifactStore
  /** Durable skill-package lease ledger (Task 25). Omitted in tests that
   *  don't exercise skill activation. */
  skillPackageLeases?: SkillPackageLeaseStore
}

export class SubagentRunner {
  private readonly now: () => number

  constructor(private readonly options: SubagentRunnerOptions) {
    this.now = options.now ?? Date.now
  }

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const childRunId = randomUUID()
    const parent = await this.options.runStore.load(input.parentRunId)
    if (!parent.ok) throw new Error(`cannot spawn subagent: parent checkpoint is ${parent.reason}`)
    const providerId = this.options.provider.id
    const model = this.options.model ?? DEFAULT_ANTHROPIC_MODEL
    const resolvedProfile = resolveSubagentModelProfile({ providerId, model })
    if (parent.checkpoint.config.runBudgetTokens !== undefined) {
      await this.options.estimatorQuarantine?.assertAllowed(resolvedProfile)
    }

    const checkpoint = await setupSubagentRun(
      {
        runStore: this.options.runStore,
        budgetStore: this.options.budgetStore,
        tools: input.tools,
        now: this.now,
      },
      {
        runId: childRunId,
        parentRunId: input.parentRunId,
        instruction: input.instruction,
        providerId,
        model,
        maxOutputTokens: 4096,
        maxSteps: input.maxSteps,
      }
    )

    const outcome = await runInteractiveTurn(
      {
        model: {
          runStore: this.options.runStore,
          budgetStore: this.options.budgetStore,
          provider: this.options.provider,
          tools: () => input.tools.list(),
          assertEstimatorAllowed: async (cp) => {
            await this.options.estimatorQuarantine?.assertAllowed(cp.config.resolvedProfile)
          },
          now: this.now,
          maxSteps: checkpoint.config.maxSteps,
          artifactStore: this.options.artifactStore,
          activeSkillInstructions: activeSkillInstructionsReader(this.options.artifactStore),
          signal: input.signal,
        },
        toolBatch: {
          tools: input.tools,
          caller: {
            kind: "subagent",
            runId: childRunId,
            parentRunId: input.parentRunId,
            conversationId: checkpoint.identity.conversationId,
            workspaceId: checkpoint.identity.workspaceId,
          },
          artifactCapture: this.options.artifactStore
            ? { store: this.options.artifactStore }
            : undefined,
          // Matches today's behavior exactly: SubagentRunner never passed an
          // `approve` hook to the old AgentRuntime, and AgentRuntime auto-
          // allows every call when one is absent — a subagent already runs
          // inside a pre-narrowed, least-privilege tool set (see
          // subagent-tool-source.ts), so there is nothing left to prompt for
          // and no UI to prompt on. requestApproval is unreachable in
          // practice; it throws rather than silently allowing/denying if
          // that assumption ever breaks.
          resolver: () => "allow",
          requestApproval: () => {
            throw new Error("subagent runs never prompt for interactive approval")
          },
          now: this.now,
        },
        signal: input.signal,
        finalize: (runId, finalizeInput) => finalizeRun(this.finalizerDeps(), runId, finalizeInput),
        buildResourceReleasePlan: (cp) => ({
          budgetOperationIds: [],
          skillPackageLeaseIds: cp.activatedSkills.map((a) => a.packageLeaseId),
          // Every call here comes from finalizeTerminal
          // (interactive-run-driver.ts) — always a genuine terminal outcome
          // for this subagent run.
          releaseArtifactRunPin: true,
          adoptionLeaseIds: [],
        }),
        quarantineEstimatorProfile: async (failedCheckpoint) => {
          await this.options.estimatorQuarantine?.quarantine(
            failedCheckpoint.config.resolvedProfile
          )
        },
      },
      childRunId
    )

    if (outcome.kind === "suspended_unknown_tool_outcome") {
      // Unreachable for a single-process subagent run — see the identical
      // reasoning in background-agent-runner.ts.
      throw new Error(`subagent run ${childRunId} unexpectedly suspended`)
    }

    return {
      summary: summarize(toChatMessages(outcome.checkpoint.messages), outcome.stopReason),
      childRunId,
      outcome: outcome.stopReason,
    }
  }

  private finalizerDeps(): RunFinalizerDeps {
    return {
      runStore: this.options.runStore,
      upsertTrace: this.options.upsertTrace,
      releaseResources: (plan, context) =>
        releaseArtifactRunResources(this.options.artifactStore, plan, context),
      releaseSkillPackageLeases: (leaseIds) =>
        releaseSkillPackageLeases(this.options.skillPackageLeases, leaseIds),
      now: this.now,
    }
  }
}

function summarize(messages: ChatMessage[], stopReason: string): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant")
  const text =
    last?.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() ?? ""
  const body = text.slice(0, SUMMARY_MAX)
  if (stopReason === "end_turn") return body || "(subtask produced no text)"
  return `${body}\n\n[subtask stopped: ${stopReason}]`.trim()
}
