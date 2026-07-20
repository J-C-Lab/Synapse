import type { RunProvenance } from "../ai/run-provenance"
import type {
  RunTrace,
  RunTraceErrorCategory,
  TraceUpsertInput,
  TraceUpsertReceipt,
} from "../ai/run-trace-store"
import type { AgentRunStore } from "../ai/runs/agent-run-store"
import type { AgentRunCheckpointV1, ModelCapabilityProfile } from "../ai/runs/checkpoint-schema"
import type { McpRunLease, McpRunLeaseStore } from "./mcp-run-lease"
import { isTerminalRunStatus } from "@synapse/agent-protocol"
import { RunNotFoundError } from "../ai/runs/agent-run-store"
import { freezeAuthoritySnapshot } from "../ai/runs/authority-snapshot"
import { canonicalHash } from "../ai/runs/canonical-json"
import { buildContextSnapshot } from "../ai/runs/context-snapshot"
import { buildTraceFromCheckpoint } from "../ai/runs/interactive-run-driver"
import { finalizeRun } from "../ai/runs/run-finalizer"

type McpProvenance = Extract<RunProvenance, { origin: "mcp" }>
type McpDurableRunFaultPoint =
  | "after_terminalizing_before_complete"
  | "after_finalize_before_purge"
  | "after_lease_cleanup_before_checkpoint_purge"

export interface McpDurableRunPort {
  begin: (input: { provenance: McpProvenance; operation: string }) => Promise<void>
  finalize: (input: {
    provenance: McpProvenance
    startedAt: number
    endedAt: number
    ok: boolean
    error?: RunTraceErrorCategory
  }) => Promise<void>
}

export interface McpDurableRunAdapterOptions {
  runStore: AgentRunStore
  /** Cross-process owner fence for the external host call. */
  leaseStore: McpRunLeaseStore
  upsertTrace: (input: TraceUpsertInput) => TraceUpsertReceipt
  now?: () => number
  /** Named crash-recovery test seam. Never set in production. */
  fault?: (point: McpDurableRunFaultPoint) => void
  /** Requests a bounded stdio maintenance pass after a terminal cleanup
   * failure. This is necessary for a completed checkpoint whose current
   * process-owned lease is temporarily locked: stale-PID planning correctly
   * ignores that owner, but the terminal fence makes retry safe. */
  requestMaintenance?: () => void
}

const MCP_PROFILE: ModelCapabilityProfile = {
  profileId: "mcp-observability-v1",
  providerId: "mcp",
  modelPattern: "mcp",
  contextWindowTokens: 0,
  defaultMaxOutputTokens: 0,
  supportsPromptCaching: false,
  supportsParallelToolCalls: false,
  supportsReasoningStream: false,
  tokenBudgeting: {
    upperBoundEstimatorId: "none",
    upperBoundEstimatorVersion: "1",
    providerFramingReserveTokens: 0,
  },
  contextPolicy: {
    summarizeAtFraction: 0,
    keepRecentFraction: 0,
    hardReserveTokens: 0,
  },
}

/**
 * The MCP server is not an agent loop, but an external MCP request is still
 * a durable run of record. This adapter creates a shared AgentRun checkpoint
 * before the request crosses into the host and uses the normal finalizer for
 * its terminal RunTrace. There is intentionally no conversation binding and
 * no synthetic interactive transcript.
 */
export function createMcpDurableRunAdapter(
  options: McpDurableRunAdapterOptions
): McpDurableRunPort {
  const now = options.now ?? Date.now
  const liveLeases = new Map<string, McpRunLease>()

  return {
    async begin({ provenance, operation }): Promise<void> {
      const context = await buildContextSnapshot({
        baseSystemText: "External MCP request observability run.",
        instructionWorkspaces: [],
      })
      const authority = freezeAuthoritySnapshot({
        principal: {
          kind: "external-mcp",
          actor: "user",
          ...(provenance.principal.clientId
            ? { subjectId: `mcp-client:${provenance.principal.clientId}` }
            : {}),
        },
        capabilities: [],
        tools: [],
      })
      const timestamp = now()
      const checkpoint: AgentRunCheckpointV1 = {
        schemaVersion: 1,
        revision: 0,
        identity: {
          runId: provenance.runId,
          rootRunId: provenance.runId,
          origin: "mcp",
          ...(provenance.workspaceId ? { workspaceId: provenance.workspaceId } : {}),
        },
        status: "running",
        recovery: { kind: "automatic" },
        createdAt: timestamp,
        updatedAt: timestamp,
        config: {
          schemaVersion: 1,
          providerId: MCP_PROFILE.providerId,
          model: "mcp",
          resolvedProfile: MCP_PROFILE,
          maxOutputTokens: 0,
          maxSteps: 0,
          contextCompression: {
            enabled: false,
            thresholdTokens: 0,
            keepRecentFraction: 0,
            hardReserveTokens: 0,
          },
          workspaceBinding: {
            ...(provenance.workspaceId ? { workspaceId: provenance.workspaceId } : {}),
            bindingRevision: 0,
            rootIds: [],
            rootSetHash: canonicalHash([]),
          },
          authority,
          context,
          mcpOperation: operation,
        },
        messages: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        nextStep: 0,
        modelSteps: [],
        toolBatches: [],
        activatedSkills: [],
      }
      // Acquire first: a concurrent startup scan can see only an owner-backed
      // checkpoint, never a live request in the tiny create-before-lock gap.
      const lease = await options.leaseStore.acquire(provenance.runId)
      try {
        await options.runStore.create(checkpoint)
        liveLeases.set(provenance.runId, lease)
      } catch (err) {
        await options.leaseStore.release(lease)
        throw err
      }
    },

    async finalize(input): Promise<void> {
      const lease = liveLeases.get(input.provenance.runId)
      if (!lease) {
        throw new Error(`MCP run ${input.provenance.runId} has no live owner lease`)
      }
      const operation = await mcpOperationFor(options.runStore, input.provenance.runId)
      const trace: RunTrace = {
        runId: input.provenance.runId,
        origin: "mcp",
        principal: input.provenance.principal,
        ...(input.provenance.workspaceId ? { workspaceId: input.provenance.workspaceId } : {}),
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        outcome: input.ok ? "end_turn" : "error",
        toolCalls: [
          {
            name: operation,
            startedAt: input.startedAt,
            ms: Math.max(0, input.endedAt - input.startedAt),
            ok: input.ok,
            ...(input.ok || !input.error ? {} : { error: input.error }),
          },
        ],
      }
      // If finalization fails, this code intentionally does not release the
      // lease: another process must not infer an indeterminate live host call
      // is abandoned merely because its terminal bookkeeping had an error.
      await terminalizeMcpRun(options, input.provenance.runId, {
        desiredStatus: input.ok ? "completed" : "failed",
        stopReason: input.ok ? "end_turn" : "error",
        trace,
      })
      liveLeases.delete(input.provenance.runId)
    },
  }
}

/** Finalizes a stale MCP request after reconciliation has already obtained
 * the cross-process recovery claim. This intentionally has no public caller:
 * calling it without that claim would recreate the unsafe old behavior. */
async function abandonMcpDurableRun(
  options: McpDurableRunAdapterOptions,
  runId: string
): Promise<void> {
  const loaded = await options.runStore.load(runId)
  if (!loaded.ok || loaded.checkpoint.identity.origin !== "mcp") return
  const now = options.now ?? Date.now
  const endedAt = now()
  const base = buildTraceFromCheckpoint(loaded.checkpoint, "aborted")
  const operation = loaded.checkpoint.config.mcpOperation ?? "mcp:interrupted"
  await terminalizeMcpRun(
    options,
    runId,
    {
      desiredStatus: "cancelled",
      stopReason: "mcp-process-interrupted",
      trace: {
        ...base,
        endedAt,
        toolCalls: [
          {
            name: operation,
            startedAt: base.startedAt,
            ms: Math.max(0, endedAt - base.startedAt),
            ok: false,
            error: "aborted",
          },
        ],
      },
    },
    { purgeCheckpoint: false, purgeLease: false }
  )
}

async function terminalizeMcpRun(
  options: McpDurableRunAdapterOptions,
  runId: string,
  input: {
    desiredStatus: "completed" | "cancelled" | "failed"
    stopReason: string
    trace: RunTrace
  },
  cleanup: { purgeCheckpoint: boolean; purgeLease: boolean } = {
    purgeCheckpoint: true,
    purgeLease: true,
  }
): Promise<void> {
  await finalizeRun(
    {
      runStore: options.runStore,
      upsertTrace: options.upsertTrace,
      releaseResources: async () => ({ artifactRunPinReleased: false }),
      now: options.now ?? Date.now,
      fault: (point) => {
        if (point === "after_prepared") options.fault?.("after_terminalizing_before_complete")
      },
    },
    runId,
    {
      ...input,
      resourceReleasePlan: {
        budgetOperationIds: [],
        skillPackageLeaseIds: [],
        releaseArtifactRunPin: false,
        adoptionLeaseIds: [],
      },
    }
  )
  options.fault?.("after_finalize_before_purge")
  if (cleanup.purgeLease) {
    try {
      await options.leaseStore.purgeTerminal(runId)
    } catch {
      // The external MCP operation has already completed and its trace is
      // durable. A transient local cleanup lock must not turn that successful
      // host response into an error that invites a client retry of a
      // potentially non-idempotent tool. Keep the complete checkpoint as the
      // retry fence and let stdio maintenance finish it out-of-band.
      options.requestMaintenance?.()
      return
    }
    options.fault?.("after_lease_cleanup_before_checkpoint_purge")
  }
  if (!cleanup.purgeCheckpoint) return
  // MCP requests have no resumable agent loop once finalization is complete.
  // The durable trace remains in its bounded RunTrace store; remove the lease
  // first, then only delete the checkpoint. If a short Windows file lock
  // exhausts checkpoint cleanup retries, the complete checkpoint remains the
  // durable fence allowing the next maintenance pass to retry safely even
  // while the current stdio PID is still alive.
  try {
    await options.runStore.purgeTerminal(runId)
  } catch {
    options.requestMaintenance?.()
  }
}

async function mcpOperationFor(runStore: AgentRunStore, runId: string): Promise<string> {
  const loaded = await runStore.load(runId)
  if (!loaded.ok || loaded.checkpoint.identity.origin !== "mcp") {
    throw new Error(`cannot finalize non-MCP run ${runId}`)
  }
  if (!loaded.checkpoint.config.mcpOperation) {
    throw new Error(`MCP run ${runId} is missing its frozen operation`)
  }
  return loaded.checkpoint.config.mcpOperation
}

/** Reclaims only completed MCP checkpoint directories. A phase-complete
 * finalization has already durably upserted its trace, so this is safe after
 * a process dies between finalization and the normal immediate purge. */
export async function purgeFinalizedMcpRuns(options: {
  runStore: Pick<AgentRunStore, "scan" | "purgeTerminal">
  leaseStore: McpRunLeaseStore
}): Promise<number> {
  const entries = await options.runStore.scan()
  let purged = 0
  for (const entry of entries) {
    if (
      !entry.result.ok ||
      entry.result.checkpoint.identity.origin !== "mcp" ||
      entry.result.checkpoint.finalization?.phase !== "complete"
    ) {
      continue
    }
    // Complete finalization is the durable terminal fence. Clean leases
    // first so a crash before checkpoint purge remains discoverable by this
    // phase-complete sweep, then remove the checkpoint.
    await options.leaseStore.purgeTerminal(entry.runId)
    await options.runStore.purgeTerminal(entry.runId)
    purged++
  }
  return purged
}

/** Reconciles the MCP-only subset of the shared run directory before a new
 * stdio server accepts requests. Unlike the GUI recovery path, the headless
 * process has no agent driver: a non-terminal request is terminalized only
 * after this process atomically claims a stale, dead owner. */
export async function reconcileMcpRunsAtStartup(
  options: McpDurableRunAdapterOptions
): Promise<{ purged: number; abandoned: number }> {
  await options.leaseStore.purgeStaleDeadTemps()
  const purged = await purgeFinalizedMcpRuns({
    runStore: options.runStore,
    leaseStore: options.leaseStore,
  })
  await purgeOrphanedMcpLeases(options)
  const entries = await options.runStore.scan({ nonTerminalOnly: true })
  let abandoned = 0
  for (const entry of entries) {
    if (!entry.result.ok || entry.result.checkpoint.identity.origin !== "mcp") continue
    const lease = await options.leaseStore.claimStale(entry.runId)
    if (!lease) continue
    let terminalCleanupStarted = false
    try {
      // A second stdio process may have scanned this run before the winner
      // claimed and purged it. Revalidate after our own claim, rather than
      // terminalizing from that stale scan snapshot or treating a vanished
      // checkpoint as a fresh orphan.
      let current: Awaited<ReturnType<AgentRunStore["load"]>>
      try {
        current = await options.runStore.load(entry.runId)
      } catch (err) {
        if (err instanceof RunNotFoundError) continue
        throw err
      }
      if (
        !current.ok ||
        current.checkpoint.identity.origin !== "mcp" ||
        isTerminalRunStatus(current.checkpoint.status)
      ) {
        continue
      }
      await abandonMcpDurableRun(options, entry.runId)
      // Keep the phase-complete checkpoint until the recovery claim has been
      // removed. If Windows exhausts a bounded claim cleanup retry, the next
      // maintenance pass can safely use this terminal fence to retry it
      // immediately; it must not wait for this still-live stdio PID to age
      // stale again. Do not also release() in finally after this has begun:
      // that would repeat the same delete attempts in one scheduled sweep.
      terminalCleanupStarted = true
      await options.leaseStore.purgeTerminal(entry.runId)
      await options.runStore.purgeTerminal(entry.runId)
      abandoned++
    } finally {
      if (!terminalCleanupStarted) await options.leaseStore.release(lease)
    }
  }
  return { purged, abandoned }
}

type McpLeaseMaintenanceTimer = ReturnType<typeof setTimeout>
const DEFAULT_MCP_MAINTENANCE_RETRY_BASE_MS = 1_000
const DEFAULT_MCP_MAINTENANCE_RETRY_MAX_MS = 30_000

export interface McpLeaseMaintenanceOptions extends McpDurableRunAdapterOptions {
  /** Test seams; production uses Node's unref-capable timer functions. */
  setTimeout?: (callback: () => void, delayMs: number) => McpLeaseMaintenanceTimer
  clearTimeout?: (timer: McpLeaseMaintenanceTimer) => void
  /** A delayed sweep must never become an unhandled rejection in stdio. */
  onError?: (error: unknown) => void
  /** Test seam. Production retries failed maintenance with bounded backoff. */
  retryBaseMs?: number
  /** Test seam. Caps the retry backoff so a transient filesystem problem
   * cannot permanently stop maintenance in a long-lived stdio process. */
  retryMaxMs?: number
}

export interface McpLeaseMaintenanceController {
  stop: () => void
  /** Ask for a retry when a normal live MCP finalizer has exhausted its own
   * bounded cleanup attempts. It never runs inline on a request path. */
  request: () => void
}

/** Schedules bounded follow-up reconciliation after a quick stdio restart.
 * Startup correctly preserves a dead lease that has not reached the stale
 * threshold yet; without this one delayed check, an otherwise long-lived
 * server would retain it until another restart. Planning identifies only
 * dead PIDs and computes their remaining age. The callback performs the
 * normal reconciliation, which checks PID+age again before any cleanup.
 *
 * Call this only after the initial `reconcileMcpRunsAtStartup()` and retain
 * the returned disposer for stdio shutdown. It scans lease metadata once per
 * necessary stale deadline, never in an MCP request's hot path. */
export async function scheduleMcpLeaseMaintenance(
  options: McpLeaseMaintenanceOptions
): Promise<McpLeaseMaintenanceController> {
  const scheduleTimeout = options.setTimeout ?? setTimeout
  const cancelTimeout = options.clearTimeout ?? clearTimeout
  const reportError = options.onError ?? (() => {})
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_MCP_MAINTENANCE_RETRY_BASE_MS
  const retryMaxMs = options.retryMaxMs ?? DEFAULT_MCP_MAINTENANCE_RETRY_MAX_MS
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs <= 0) {
    throw new Error("MCP lease maintenance retryBaseMs must be a positive integer")
  }
  if (!Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs) {
    throw new Error("MCP lease maintenance retryMaxMs must be at least retryBaseMs")
  }
  let stopped = false
  let timer: McpLeaseMaintenanceTimer | undefined
  let timerDelayMs: number | undefined
  let timerGeneration = 0
  let maintenanceInFlight = false
  let pendingRequest = false
  let consecutiveFailures = 0
  let runMaintenance: () => Promise<void>

  const cancelScheduledTimer = (): void => {
    if (timer) cancelTimeout(timer)
    timer = undefined
    timerDelayMs = undefined
    timerGeneration++
  }

  const scheduleTimer = (delayMs: number): void => {
    if (stopped || timer) return
    const generation = ++timerGeneration
    timer = scheduleTimeout(() => {
      // A canceled callback may still be delivered by a test seam (and some
      // hosts can race shutdown). Only the current generation may start work.
      if (stopped || generation !== timerGeneration) return
      timer = undefined
      timerDelayMs = undefined
      void runMaintenance()
    }, delayMs)
    timerDelayMs = delayMs
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  const schedule = async (allowImmediate: boolean): Promise<void> => {
    if (stopped) return
    const delay = await options.leaseStore.nextStaleDeadSweepDelay()
    if (stopped || delay === undefined || (!allowImmediate && delay === 0)) return
    scheduleTimer(delay)
  }

  const retryDelay = (): number => {
    // Clamp both the exponent and result so an indefinitely unavailable
    // filesystem remains low-frequency, but can recover without a restart.
    const multiplier = 2 ** Math.min(consecutiveFailures, 30)
    return Math.min(retryMaxMs, retryBaseMs * multiplier)
  }

  const reportMaintenanceError = (error: unknown): void => {
    try {
      reportError(error)
    } catch {
      // A logging hook must not turn a recoverable cleanup failure into an
      // unhandled rejection or prevent the next scheduled reconciliation.
    }
  }

  runMaintenance = async (): Promise<void> => {
    if (stopped) return
    if (maintenanceInFlight) {
      pendingRequest = true
      return
    }
    maintenanceInFlight = true
    try {
      await reconcileMcpRunsAtStartup(options)
      if (stopped) return
      consecutiveFailures = 0
      await schedule(false)
    } catch (error) {
      if (stopped) return
      reportMaintenanceError(error)
      const delay = retryDelay()
      consecutiveFailures++
      // Do not call nextStaleDeadSweepDelay here: the very filesystem error
      // that interrupted reconciliation may make planning fail too. A bounded
      // timer reruns the normal conservative PID+age checks on the next pass.
      scheduleTimer(delay)
    } finally {
      maintenanceInFlight = false
      if (!stopped && pendingRequest) {
        pendingRequest = false
        // A request that arrived while a sweep was in flight may name a newly
        // completed, current-PID lease. Replace any stale-dead plan with one
        // coalesced bounded retry, never a concurrent reconciliation.
        cancelScheduledTimer()
        scheduleTimer(retryBaseMs)
      }
    }
  }

  const request = (): void => {
    // An existing dead-lease sweep will perform the same safe terminal scan,
    // so do not create concurrent reconciliations. Otherwise start the first
    // bounded retry after a short delay rather than on the MCP request stack.
    if (stopped) return
    if (maintenanceInFlight) {
      pendingRequest = true
      return
    }
    if (timer) {
      // A stale-dead owner can legitimately have a long remaining delay, but
      // a just-completed current-PID run needs terminal-fence cleanup soon.
      // Replace only a later timer; equal/earlier work already coalesces it.
      if (timerDelayMs !== undefined && timerDelayMs > retryBaseMs) {
        cancelScheduledTimer()
        scheduleTimer(retryBaseMs)
      }
      return
    }
    scheduleTimer(retryBaseMs)
  }

  await schedule(true)
  const stop = (): void => {
    stopped = true
    pendingRequest = false
    cancelScheduledTimer()
  }
  return { stop, request }
}

/** Retains cleanup compatibility for lease artifacts created by older builds
 * that wrote checkpoints before owners. Only stdio performs this fallback,
 * and only for leases whose every owner PID is stale and dead; GUI startup
 * never uses missing-checkpoint lease state to affect live MCP. */
async function purgeOrphanedMcpLeases(options: McpDurableRunAdapterOptions): Promise<void> {
  for (const runId of await options.leaseStore.leasedRunIds()) {
    try {
      await options.runStore.load(runId)
      continue
    } catch (err) {
      if (!(err instanceof RunNotFoundError)) throw err
    }
    await options.leaseStore.purgeStaleDeadOrphan(runId)
  }
}
