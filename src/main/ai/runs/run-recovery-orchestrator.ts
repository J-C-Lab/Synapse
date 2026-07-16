import type { AgentRunEvent } from "@synapse/agent-protocol"
import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { ChatProvider } from "../providers/types"
import type { RunTrace, TraceUpsertInput, TraceUpsertReceipt } from "../run-trace-store"
import type { ToolHostPort } from "../tool-registry"
import type { AgentRunRecoveryService } from "./agent-run-recovery-service"
import type { AgentRunStore } from "./agent-run-store"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { RunEventStore } from "./run-event-store"
import { AiToolRegistry } from "../tool-registry"
import { freezeToolAuthority, toolIdentityMatches } from "./authority-snapshot"
import { runInteractiveTurn } from "./interactive-run-driver"
import { createRunEventEmitter } from "./run-event-emitter"
import { finalizeRun } from "./run-finalizer"

// Origin-aware recovery orchestrator (Task 16 gate, P1-1): the piece
// AgentRunRecoveryService never had. resume() (Task 12) only flips a
// checkpoint's durable status field back to "running" — nothing then drives
// the checkpoint's actual outer loop forward. This module is that missing
// "actually keep running it" half, for both the startup scan and a manual
// runs:resume click.
//
// Interactive-origin continuation is real and complete — see
// AgentService.continueRun(), which reuses the exact live global tool
// registry and a freshly looked-up credential, matching a normal chat()
// turn in every way except skipping setup.
//
// Background/subagent continuation reconstructs the frozen caller contract:
// tool exposure is the live registry intersected with full frozen tool
// identity, and background runs restore the persisted per-run tool cap and
// timeout. The root ledger remains the shared token-budget authority.

export interface RunRecoveryOrchestratorDeps {
  recovery: Pick<AgentRunRecoveryService, "listRecoverable" | "resume" | "abandon">
  /** Dispatches to the right origin-specific continuation. A callback may
   * await only its ownership barrier (not its provider/tool turn), allowing
   * startup to fence interactive conversation leases before chat is enabled. */
  continueRun: (checkpoint: AgentRunCheckpointV1) => void | Promise<void>
  runStore: Pick<AgentRunStore, "load">
  onError?: (runId: string, err: unknown) => void
}

/** Scans every recoverable run and, for exactly the ones classified
 *  `automatic` (never `requires_review`/`blocked` — those still need a human
 *  decision through the existing recovery panel), resumes its durable status
 *  and fires its continuation. Safe to call at startup: resume() itself is
 *  cheap (a single CAS mutation, no provider calls), so this function
 *  returns after any supplied ownership barriers; provider/tool turns remain
 *  asynchronous. */
export async function autoResumeRecoverableRuns(deps: RunRecoveryOrchestratorDeps): Promise<void> {
  const summaries = await deps.recovery.listRecoverable()
  for (const summary of summaries) {
    if (summary.recovery.kind !== "automatic") continue
    // `terminalizing` cannot legally transition back to running. Its
    // existing finalization ledger is the authoritative desired outcome;
    // abandon() detects that ledger and simply resumes its idempotent phases.
    if (summary.status === "terminalizing") {
      try {
        await deps.recovery.abandon(summary.runId)
      } catch (err) {
        deps.onError?.(summary.runId, err)
      }
      continue
    }
    try {
      await deps.recovery.resume(summary.runId)
    } catch (err) {
      // "automatic" already means classifyRunRecovery found nothing wrong —
      // a decision/blocked error here would indicate a race with a
      // concurrent classification change. Log and skip; the run stays
      // visible in the recovery panel for a human either way.
      deps.onError?.(summary.runId, err)
      continue
    }
    let result: Awaited<ReturnType<typeof deps.runStore.load>>
    try {
      result = await deps.runStore.load(summary.runId)
    } catch (err) {
      deps.onError?.(summary.runId, err)
      continue
    }
    if (!result.ok) continue
    // Interactive callers can use this awaitable boundary to fence their
    // conversation lease before startup reconciliation releases chat();
    // background continuations still deliberately detach after dispatch.
    await deps.continueRun(result.checkpoint)
  }
}

export interface GenericRunContinuationDeps {
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  eventStore: RunEventStore
  upsertTrace: (input: TraceUpsertInput) => TraceUpsertReceipt
  recordRun?: (trace: RunTrace) => void
  /** The live global tool host — narrowed per-run to the checkpoint's own
   *  frozen authority fqNames before use. */
  tools: ToolHostPort
  /** Reconstructs a provider from the checkpoint's own frozen providerId
   *  (never today's live-settings provider — a resume replays what the run
   *  already committed to). Throws AgentMissingKeyError-equivalent if no key
   *  is configured for that provider. */
  buildProvider: (providerId: string) => Promise<ChatProvider>
  now?: () => number
  /** Real-time push side of the subscribeRun channel (P1-2) — see
   *  run-event-emitter.ts. */
  onEvent?: (event: AgentRunEvent) => void
}

/** Re-drives an interrupted background-agent or subagent checkpoint to
 * completion using the same persisted policy. Never throws for a normal terminal outcome
 *  (finalized or suspended) — only for genuine setup failures (missing
 *  credential, corrupt checkpoint), which the caller logs. */
export async function continueBackgroundOrSubagentRun(
  deps: GenericRunContinuationDeps,
  checkpoint: AgentRunCheckpointV1
): Promise<void> {
  const now = deps.now ?? Date.now
  const runId = checkpoint.identity.runId
  const origin = checkpoint.identity.origin
  if (origin !== "background-agent" && origin !== "subagent") {
    throw new Error(`continueBackgroundOrSubagentRun is not for origin "${origin}" (run ${runId})`)
  }

  const allowedFqNames = new Set(checkpoint.config.authority.tools.map((tool) => tool.fqName))
  const narrowedTools = new AiToolRegistry({
    listTools: () => deps.tools.listTools().filter((d) => allowedFqNames.has(d.fqName)),
    invokeTool: (fqName, input, options) => deps.tools.invokeTool(fqName, input, options),
  })
  const modelTools = () =>
    narrowedTools
      .listWithDescriptors()
      .filter(({ descriptor, schema }) => {
        const frozen = checkpoint.config.authority.tools.find(
          (tool) => tool.fqName === descriptor.fqName
        )
        return (
          frozen !== undefined &&
          toolIdentityMatches(
            frozen,
            freezeToolAuthority({ descriptor, safeName: schema.name, modelSchema: schema })
          )
        )
      })
      .map(({ schema }) => schema)

  const provider = await deps.buildProvider(checkpoint.config.providerId)
  const backgroundExecution = checkpoint.config.backgroundExecution
  if (origin === "background-agent" && !backgroundExecution) {
    throw new Error(`background run ${runId} lacks its durable execution policy`)
  }
  let remainingToolCalls = backgroundExecution?.maxToolCallsPerRun ?? Number.POSITIVE_INFINITY
  const controller = new AbortController()
  const timeout = backgroundExecution
    ? setTimeout(() => controller.abort(), backgroundExecution.timeoutMs)
    : undefined
  const eventEmitter = await createRunEventEmitter(
    deps.eventStore,
    {
      runId,
      rootRunId: checkpoint.identity.rootRunId,
      conversationId: checkpoint.identity.conversationId,
    },
    now,
    undefined,
    deps.onEvent
  )

  try {
    const outcome = await runInteractiveTurn(
      {
        model: {
          runStore: deps.runStore,
          budgetStore: deps.budgetStore,
          provider,
          tools: modelTools,
          now,
          maxSteps: checkpoint.config.maxSteps,
          eventEmitter,
        },
        toolBatch: {
          tools: narrowedTools,
          caller:
            origin === "subagent"
              ? {
                  kind: "subagent",
                  runId,
                  parentRunId: checkpoint.identity.parentRunId,
                  conversationId: checkpoint.identity.conversationId,
                  workspaceId: checkpoint.identity.workspaceId,
                }
              : {
                  kind: "background-agent",
                  runId,
                  workspaceId: checkpoint.identity.workspaceId,
                  invocationId: checkpoint.identity.invocationId,
                  triggerInstanceId: checkpoint.identity.triggerInstanceId,
                },
          resolver: () => {
            if (origin === "subagent") return "allow"
            if (remainingToolCalls <= 0) return "deny"
            remainingToolCalls -= 1
            return "allow"
          },
          requestApproval: () => {
            throw new Error(`${origin} runs never prompt for interactive approval`)
          },
          now,
          eventEmitter,
        },
        signal: controller.signal,
        finalize: (rid, input) =>
          finalizeRun(
            {
              runStore: deps.runStore,
              upsertTrace: deps.upsertTrace,
              releaseResources: async () => {},
              now,
            },
            rid,
            input
          ),
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
    if (trace) deps.recordRun?.(trace)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
