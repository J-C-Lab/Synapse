import type { RootBudgetLedgerStore } from "../budget/root-budget-ledger"
import type { ChatProvider } from "../providers/types"
import type { RunTrace, TraceUpsertInput, TraceUpsertReceipt } from "../run-trace-store"
import type { ToolHostPort } from "../tool-registry"
import type { AgentRunRecoveryService } from "./agent-run-recovery-service"
import type { AgentRunStore } from "./agent-run-store"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import type { RunEventStore } from "./run-event-store"
import { AiToolRegistry } from "../tool-registry"
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
// Background-agent/subagent continuation (continueBackgroundOrSubagentRun
// below) is honest but INTENTIONALLY DEGRADED: BackgroundAgentRunner and
// SubagentRunner are both fire-and-forget, constructed fresh per trigger
// fire / per spawn_subagent call, with no persistent registry mapping a
// runId back to the exact trigger/parent context that created it (the
// checkpoint's own identity doesn't even retain a pluginId). Reconstructing
// the ORIGINAL scoped tool host and ledger-based per-call throttle is out of
// scope here — it depends on the authority-reconstruction work tracked
// separately (P1-6). What this function CAN do safely: narrow the live
// global tool registry down to exactly the fqNames the checkpoint's own
// frozen authority already recorded (never wider than what the run was
// originally given) and rebuild a plain credential-based provider from the
// checkpoint's own frozen providerId. That's strictly better than the
// previous behavior (resume() flips the status and nothing ever drives the
// run again), even though it drops the original trigger's ephemeral
// per-call tool-count cap (the durable, safety-relevant token budget is
// still fully enforced regardless, via the root budget ledger).

export interface RunRecoveryOrchestratorDeps {
  recovery: Pick<AgentRunRecoveryService, "listRecoverable" | "resume">
  /** Dispatches to the right origin-specific continuation and drives it to
   *  completion. Errors are this callback's own responsibility to log —
   *  never awaited by the orchestrator beyond kicking it off, so one slow or
   *  failing run can never block classification of the rest. */
  continueRun: (checkpoint: AgentRunCheckpointV1) => void
  runStore: Pick<AgentRunStore, "load">
  onError?: (runId: string, err: unknown) => void
}

/** Scans every recoverable run and, for exactly the ones classified
 *  `automatic` (never `requires_review`/`blocked` — those still need a human
 *  decision through the existing recovery panel), resumes its durable status
 *  and fires its continuation. Safe to call at startup: resume() itself is
 *  cheap (a single CAS mutation, no provider calls), so this function
 *  returns quickly even though the continuations it kicks off may still be
 *  running in the background. */
export async function autoResumeRecoverableRuns(deps: RunRecoveryOrchestratorDeps): Promise<void> {
  const summaries = await deps.recovery.listRecoverable()
  for (const summary of summaries) {
    if (summary.recovery.kind !== "automatic") continue
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
    deps.continueRun(result.checkpoint)
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
}

/** Re-drives an interrupted background-agent or subagent checkpoint to
 *  completion. See the module header for exactly what's degraded relative to
 *  the original live run. Never throws for a normal terminal outcome
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

  const provider = await deps.buildProvider(checkpoint.config.providerId)
  const eventEmitter = await createRunEventEmitter(
    deps.eventStore,
    {
      runId,
      rootRunId: checkpoint.identity.rootRunId,
      conversationId: checkpoint.identity.conversationId,
    },
    now
  )

  const outcome = await runInteractiveTurn(
    {
      model: {
        runStore: deps.runStore,
        budgetStore: deps.budgetStore,
        provider,
        tools: () => narrowedTools.list(),
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
        // Matches both runners' original behavior exactly: neither ever had
        // an interactive UI to prompt through, so both always resolved
        // definitively without one. The original per-call ledger throttle
        // (background-agent) doesn't survive a restart (it was ephemeral,
        // process-local) — see the module header.
        resolver: () => "allow",
        requestApproval: () => {
          throw new Error(`${origin} runs never prompt for interactive approval`)
        },
        now,
        eventEmitter,
      },
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
}
