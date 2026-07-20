import type { MemoryEntry } from "../ai/memory/memory-store"
import type { ToolHostPort } from "../ai/tool-registry"
import { promises as fs, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getRunTrace, listRuns, upsertRunTrace } from "../ai/run-trace-store"
import { AgentRunStore } from "../ai/runs/agent-run-store"
import {
  createMcpDurableRunAdapter,
  purgeFinalizedMcpRuns,
  reconcileMcpRunsAtStartup,
  scheduleMcpLeaseMaintenance,
} from "./mcp-durable-run"
import { McpRunLeaseStore } from "./mcp-run-lease"
import { SynapseMcpToolService } from "./synapse-mcp-server"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "synapse-mcp-durable-run-"))
  tempDirs.push(dir)
  const runsDir = join(dir, "runs")
  const runStore = new AgentRunStore(runsDir)
  const tracesDir = join(dir, "traces")
  const leaseStore = new McpRunLeaseStore(runsDir, { now: () => 1000 })
  const adapter = createMcpDurableRunAdapter({
    runStore,
    leaseStore,
    upsertTrace: (input) => upsertRunTrace(tracesDir, input),
    now: () => 1000,
  })
  const provenance = {
    origin: "mcp" as const,
    runId: "mcp-run-1",
    principal: { kind: "external-mcp" as const, clientId: "claude-desktop" },
    workspaceId: "workspace-1",
  }
  return { dir, runsDir, runStore, tracesDir, leaseStore, adapter, provenance }
}

function leaseNames(runsDir: string): string[] {
  return readdirSync(join(runsDir, ".mcp-leases"))
}

async function flushAsyncWork(): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe("mcp durable run adapter", () => {
  it("creates a shared checkpoint and publishes a finalized external-MCP tool trace", async () => {
    const { runsDir, runStore, tracesDir, adapter, provenance } = fixture()

    await adapter.begin({ provenance, operation: "com.example.files/read" })
    const checkpoint = await runStore.load(provenance.runId)
    expect(checkpoint).toMatchObject({
      ok: true,
      checkpoint: {
        identity: { origin: "mcp", workspaceId: "workspace-1" },
        config: { mcpOperation: "com.example.files/read" },
        status: "running",
      },
    })

    await adapter.finalize({
      provenance,
      startedAt: 900,
      endedAt: 1000,
      ok: true,
    })

    expect(getRunTrace(tracesDir, provenance.runId)).toMatchObject({
      runId: provenance.runId,
      origin: "mcp",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "workspace-1",
      outcome: "end_turn",
      toolCalls: [{ name: "com.example.files/read", ok: true }],
    })
    // Finalized MCP checkpoints are deliberately cleaned up; their durable
    // trace remains the bounded observability record.
    expect(await runStore.scan({})).toEqual([])
    expect(leaseNames(runsDir)).toEqual([])
  })

  it("records a failed request and safely aborts a checkpoint owned by a stale, dead stdio process", async () => {
    const { runsDir, runStore, tracesDir, adapter, provenance } = fixture()

    await adapter.begin({
      provenance,
      operation: "resources/read:synapse://memory/missing",
    })
    await adapter.finalize({
      provenance,
      startedAt: 900,
      endedAt: 1000,
      ok: false,
      error: "tool-error",
    })
    expect(getRunTrace(tracesDir, provenance.runId)).toMatchObject({
      outcome: "error",
      toolCalls: [{ error: "tool-error", ok: false }],
    })

    const interrupted = { ...provenance, runId: "mcp-run-interrupted" }
    // This adapter models the old process. The injectable dead PID and old
    // clock make the test's restart boundary explicit rather than assuming a
    // newly constructed AgentRunStore means the original process is gone.
    const crashedAdapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore: new McpRunLeaseStore(runsDir, {
        now: () => 1000,
        staleAfterMs: 100,
        processId: 999_999,
        isProcessAlive: () => false,
      }),
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => 1000,
    })
    await crashedAdapter.begin({
      provenance: interrupted,
      operation: "com.example.files/read",
    })
    // These are separate AgentRunStore and lease-store objects, just as two
    // independent stdio processes would be. Exactly one atomic rename may
    // turn the stale owner into a recovery claim and terminalize the run.
    const recoveryOptions = () => ({
      runStore: new AgentRunStore(runsDir),
      leaseStore: new McpRunLeaseStore(runsDir, {
        now: () => 2000,
        staleAfterMs: 100,
        isProcessAlive: () => false,
      }),
      upsertTrace: (input: Parameters<typeof upsertRunTrace>[1]) =>
        upsertRunTrace(tracesDir, input),
      now: () => 2000,
    })
    const recoveries = await Promise.all([
      reconcileMcpRunsAtStartup(recoveryOptions()),
      reconcileMcpRunsAtStartup(recoveryOptions()),
    ])
    expect(recoveries.reduce((total, result) => total + result.abandoned, 0)).toBe(1)
    expect(getRunTrace(tracesDir, interrupted.runId)).toMatchObject({
      origin: "mcp",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      outcome: "aborted",
      toolCalls: [{ name: "com.example.files/read", error: "aborted" }],
    })
    expect(await runStore.scan({})).toEqual([])
    expect(leaseNames(runsDir)).toEqual([])
  })

  it("reclaims a terminal checkpoint left by a finalize-to-purge crash after restart", async () => {
    const { dir, runStore, tracesDir, leaseStore, provenance } = fixture()
    const adapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => 1000,
      fault: (point) => {
        if (point === "after_finalize_before_purge") throw new Error("simulated process death")
      },
    })
    await adapter.begin({ provenance, operation: "com.example.files/read" })

    await expect(
      adapter.finalize({
        provenance,
        startedAt: 900,
        endedAt: 1000,
        ok: true,
      })
    ).rejects.toThrow("simulated process death")

    // Reconstruct the store from its on-disk path to prove this is a real
    // persistence/restart boundary, rather than an in-memory cleanup illusion.
    const restartedStore = new AgentRunStore(join(dir, "runs"))
    const stranded = await restartedStore.load(provenance.runId)
    expect(stranded).toMatchObject({
      ok: true,
      checkpoint: { status: "completed", finalization: { phase: "complete" } },
    })
    expect(getRunTrace(tracesDir, provenance.runId)).toMatchObject({
      toolCalls: [{ name: "com.example.files/read", ok: true }],
    })

    await expect(
      purgeFinalizedMcpRuns({
        runStore: restartedStore,
        leaseStore: new McpRunLeaseStore(join(dir, "runs")),
      })
    ).resolves.toBe(1)
    expect(await restartedStore.scan({})).toEqual([])
    expect(leaseNames(join(dir, "runs"))).toEqual([])
    // Cleanup removes only the checkpoint; the durable observability trace
    // survives the crash window intact.
    expect(getRunTrace(tracesDir, provenance.runId)).toBeDefined()
  })

  it("does not reclaim a live MCP call during GUI or second-stdio startup", async () => {
    const { runsDir, tracesDir, adapter, provenance } = fixture()
    await adapter.begin({ provenance, operation: "com.example.files/read" })

    // GUI startup is deliberately limited to terminal checkpoint cleanup.
    // It cannot abort an external MCP request that another stdio process is
    // still driving.
    const guiStore = new AgentRunStore(runsDir)
    await expect(
      purgeFinalizedMcpRuns({
        runStore: guiStore,
        leaseStore: new McpRunLeaseStore(runsDir),
      })
    ).resolves.toBe(0)

    // A distinct stdio process sees the owner's actual live PID. Even a very
    // old lease must remain untouched while that PID answers a liveness probe.
    const restartedStore = new AgentRunStore(runsDir)
    await expect(
      reconcileMcpRunsAtStartup({
        runStore: restartedStore,
        leaseStore: new McpRunLeaseStore(runsDir, {
          now: () => 2000,
          staleAfterMs: 100,
          isProcessAlive: (pid) => pid === process.pid,
        }),
        upsertTrace: (input) => upsertRunTrace(tracesDir, input),
        now: () => 2000,
      })
    ).resolves.toEqual({ purged: 0, abandoned: 0 })

    expect(await restartedStore.load(provenance.runId)).toMatchObject({
      ok: true,
      checkpoint: { status: "running", config: { mcpOperation: "com.example.files/read" } },
    })

    // The original caller still owns and can terminalize its host operation.
    await adapter.finalize({
      provenance,
      startedAt: 1000,
      endedAt: 2000,
      ok: true,
    })
    expect(getRunTrace(tracesDir, provenance.runId)).toMatchObject({
      outcome: "end_turn",
      toolCalls: [{ name: "com.example.files/read", ok: true }],
    })
    expect(await restartedStore.scan({})).toEqual([])
    expect(leaseNames(runsDir)).toEqual([])
  })

  it("leaves terminalizing MCP work for its stdio owner to finish", async () => {
    const { runsDir, runStore, tracesDir, leaseStore, provenance } = fixture()
    const adapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => 1000,
      fault: (point) => {
        if (point === "after_terminalizing_before_complete") {
          throw new Error("simulated pause while stdio finalizes")
        }
      },
    })
    await adapter.begin({ provenance, operation: "com.example.files/read" })
    await expect(
      adapter.finalize({
        provenance,
        startedAt: 900,
        endedAt: 1000,
        ok: true,
      })
    ).rejects.toThrow("simulated pause while stdio finalizes")
    expect(await runStore.load(provenance.runId)).toMatchObject({
      ok: true,
      checkpoint: { status: "terminalizing", finalization: { phase: "prepared" } },
    })

    // GUI startup's direct MCP work is terminal-only cleanup; the recovery
    // service separately filters MCP before it can classify/abandon this
    // incomplete finalization (covered in agent-run-recovery-service.test).
    await expect(
      purgeFinalizedMcpRuns({
        runStore: new AgentRunStore(runsDir),
        leaseStore: new McpRunLeaseStore(runsDir),
      })
    ).resolves.toBe(0)
    expect(await runStore.load(provenance.runId)).toMatchObject({
      ok: true,
      checkpoint: { status: "terminalizing", finalization: { phase: "prepared" } },
    })

    // The original stdio lifecycle holds its owner and resumes the frozen
    // finalization ledger without GUI interference.
    await adapter.finalize({
      provenance,
      startedAt: 900,
      endedAt: 1000,
      ok: true,
    })
    expect(await runStore.scan({})).toEqual([])
    expect(leaseNames(runsDir)).toEqual([])
  })

  it("reclaims a terminal checkpoint left after lease cleanup but before checkpoint purge", async () => {
    const { runsDir, runStore, tracesDir, provenance } = fixture()
    const crashedLeaseStore = new McpRunLeaseStore(runsDir, {
      now: () => 1000,
      staleAfterMs: 100,
      processId: 999_999,
      isProcessAlive: () => false,
    })
    const adapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore: crashedLeaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => 1000,
      fault: (point) => {
        if (point === "after_lease_cleanup_before_checkpoint_purge") {
          throw new Error("simulated process death after lease cleanup")
        }
      },
    })
    await adapter.begin({ provenance, operation: "com.example.files/read" })

    await expect(
      adapter.finalize({
        provenance,
        startedAt: 900,
        endedAt: 1000,
        ok: true,
      })
    ).rejects.toThrow("simulated process death after lease cleanup")

    // Cleanup writes the terminal checkpoint last: a crash here leaves an
    // explicit phase-complete fence rather than an ambiguous live owner.
    expect(await runStore.load(provenance.runId)).toMatchObject({
      ok: true,
      checkpoint: { status: "completed", finalization: { phase: "complete" } },
    })
    expect(leaseNames(runsDir)).toEqual([])

    await expect(
      reconcileMcpRunsAtStartup({
        runStore: new AgentRunStore(runsDir),
        leaseStore: new McpRunLeaseStore(runsDir, {
          now: () => 2000,
          staleAfterMs: 100,
          isProcessAlive: () => false,
        }),
        upsertTrace: (input) => upsertRunTrace(tracesDir, input),
        now: () => 2000,
      })
    ).resolves.toEqual({ purged: 1, abandoned: 0 })
    expect(leaseNames(runsDir)).toEqual([])
  })

  it("sweeps a quick-restart dead lease after it becomes stale without another restart", async () => {
    const { runsDir, runStore, tracesDir, provenance } = fixture()
    let clock = 1000
    const crashed = createMcpDurableRunAdapter({
      runStore,
      leaseStore: new McpRunLeaseStore(runsDir, {
        now: () => clock,
        staleAfterMs: 100,
        processId: 999_999,
        isProcessAlive: () => false,
      }),
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => clock,
    })
    await crashed.begin({ provenance, operation: "com.example.files/read" })

    // The replacement stdio process starts before staleAfterMs, so startup
    // must retain the owner rather than assume that a fresh process means it
    // can abandon the host call immediately.
    clock = 1050
    const recoveryOptions = {
      runStore: new AgentRunStore(runsDir),
      leaseStore: new McpRunLeaseStore(runsDir, {
        now: () => clock,
        staleAfterMs: 100,
        // The recovery claim belongs to this still-live stdio process. The
        // second maintenance pass must rely on the completed checkpoint fence,
        // not falsely classify its own PID as dead.
        isProcessAlive: (pid) => pid === process.pid,
      }),
      upsertTrace: (input: Parameters<typeof upsertRunTrace>[1]) =>
        upsertRunTrace(tracesDir, input),
      now: () => clock,
    }
    await expect(reconcileMcpRunsAtStartup(recoveryOptions)).resolves.toEqual({
      purged: 0,
      abandoned: 0,
    })

    let scheduled: { callback: () => void; delayMs: number } | undefined
    const maintenance = await scheduleMcpLeaseMaintenance({
      ...recoveryOptions,
      setTimeout: (callback: () => void, delayMs: number) => {
        scheduled = { callback, delayMs }
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {},
    })
    expect(scheduled?.delayMs).toBe(50)

    // No second process startup occurs here. The scheduled normal-service
    // sweep re-evaluates age and PID after the threshold before terminalizing.
    clock = 1100
    scheduled?.callback()
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await recoveryOptions.runStore.scan()).length === 0) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    maintenance.stop()

    expect(await recoveryOptions.runStore.scan()).toEqual([])
    expect(leaseNames(runsDir)).toEqual([])
    expect(getRunTrace(tracesDir, provenance.runId)).toMatchObject({
      outcome: "aborted",
      toolCalls: [{ name: "com.example.files/read", error: "aborted" }],
    })
  })

  it("retries scheduled maintenance after one exhausted cleanup attempt without a restart", async () => {
    const { runsDir, runStore, tracesDir, provenance } = fixture()
    let clock = 1000
    const crashed = createMcpDurableRunAdapter({
      runStore,
      leaseStore: new McpRunLeaseStore(runsDir, {
        now: () => clock,
        staleAfterMs: 100,
        processId: 999_999,
        isProcessAlive: () => false,
      }),
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => clock,
    })
    await crashed.begin({ provenance, operation: "com.example.files/read" })

    clock = 1050
    let failRecoveryClaimCleanup = false
    let recoveryClaimDeleteAttempts = 0
    const recoveryOptions = {
      runStore: new AgentRunStore(runsDir),
      leaseStore: new McpRunLeaseStore(runsDir, {
        now: () => clock,
        staleAfterMs: 100,
        isProcessAlive: () => false,
        fileOperationRetryDelayMs: 0,
        unlink: async (filePath) => {
          if (failRecoveryClaimCleanup && filePath.includes(".recovery-")) {
            recoveryClaimDeleteAttempts++
            throw Object.assign(new Error("temporarily locked recovery claim"), { code: "EPERM" })
          }
          await fs.unlink(filePath)
        },
      }),
      upsertTrace: (input: Parameters<typeof upsertRunTrace>[1]) =>
        upsertRunTrace(tracesDir, input),
      now: () => clock,
    }
    await expect(reconcileMcpRunsAtStartup(recoveryOptions)).resolves.toEqual({
      purged: 0,
      abandoned: 0,
    })

    const timers: { callback: () => void; delayMs: number }[] = []
    const errors: unknown[] = []
    const maintenance = await scheduleMcpLeaseMaintenance({
      ...recoveryOptions,
      retryBaseMs: 7,
      retryMaxMs: 70,
      setTimeout: (callback, delayMs) => {
        timers.push({ callback, delayMs })
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {},
      onError: (error) => errors.push(error),
    })
    expect(timers).toHaveLength(1)
    expect(timers[0]?.delayMs).toBe(50)

    // The first scheduled sweep reaches terminal cleanup, where all eight
    // transient retries are exhausted. The maintenance service must report
    // this and schedule the next attempt instead of going dormant forever.
    clock = 1100
    failRecoveryClaimCleanup = true
    timers[0]?.callback()
    for (let attempt = 0; attempt < 300 && errors.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // The recovery claim gets exactly one bounded cleanup attempt in this
    // sweep; its terminal checkpoint remains the fence for the next timer.
    expect(recoveryClaimDeleteAttempts).toBe(8)
    expect(errors).toHaveLength(1)
    expect(timers).toHaveLength(2)
    expect(timers[1]?.delayMs).toBe(7)

    // No restart happens between attempts. Once the transient lock clears,
    // the deferred retry sees the retained terminal checkpoint and safely
    // retries its lease cleanup despite the current stdio PID still being live.
    failRecoveryClaimCleanup = false
    timers[1]?.callback()
    for (let attempt = 0; attempt < 300; attempt++) {
      if (
        (await recoveryOptions.runStore.scan()).length === 0 &&
        leaseNames(runsDir).length === 0
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    maintenance.stop()

    expect(await recoveryOptions.runStore.scan()).toEqual([])
    expect(leaseNames(runsDir)).toEqual([])
    expect(getRunTrace(tracesDir, provenance.runId)).toMatchObject({ outcome: "aborted" })
  })

  it("self-heals a normal finalizer's locked live-owner lease without a restart", async () => {
    const { runsDir, tracesDir, provenance } = fixture()
    let terminalLeaseLocked = false
    let terminalLeaseDeleteAttempts = 0
    const runStore = new AgentRunStore(runsDir)
    const leaseStore = new McpRunLeaseStore(runsDir, {
      isProcessAlive: (pid) => pid === process.pid,
      fileOperationRetryDelayMs: 0,
      unlink: async (filePath) => {
        if (terminalLeaseLocked && filePath.endsWith(".owner.json")) {
          terminalLeaseDeleteAttempts++
          throw Object.assign(new Error("temporarily locked live owner"), { code: "EPERM" })
        }
        await fs.unlink(filePath)
      },
    })
    const timers: { callback: () => void; delayMs: number }[] = []
    const maintenance = await scheduleMcpLeaseMaintenance({
      runStore,
      leaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      retryBaseMs: 7,
      retryMaxMs: 70,
      setTimeout: (callback, delayMs) => {
        timers.push({ callback, delayMs })
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {},
    })
    const adapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      requestMaintenance: maintenance.request,
    })
    await adapter.begin({ provenance, operation: "com.example.files/read" })

    terminalLeaseLocked = true
    // The host call already succeeded. Cleanup is deferred, not surfaced as
    // an MCP failure that could cause the client to replay that operation.
    await expect(
      adapter.finalize({
        provenance,
        startedAt: 900,
        endedAt: 1000,
        ok: true,
      })
    ).resolves.toBeUndefined()
    expect(terminalLeaseDeleteAttempts).toBe(8)
    expect(await runStore.load(provenance.runId)).toMatchObject({
      ok: true,
      checkpoint: { status: "completed", finalization: { phase: "complete" } },
    })
    expect(leaseNames(runsDir)).toEqual(["mcp-run-1.owner.json"])
    expect(timers).toHaveLength(1)
    expect(timers[0]?.delayMs).toBe(7)

    // The same stdio PID remains alive throughout. Completion maintenance
    // ignores live-owner stale recovery and instead uses the terminal fence.
    terminalLeaseLocked = false
    timers[0]?.callback()
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await runStore.scan()).length === 0 && leaseNames(runsDir).length === 0) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    maintenance.stop()

    expect(await runStore.scan()).toEqual([])
    expect(leaseNames(runsDir)).toEqual([])
    expect(getRunTrace(tracesDir, provenance.runId)).toMatchObject({ outcome: "end_turn" })
  })

  it("serializes in-flight maintenance requests and ignores captured callbacks after stop", async () => {
    const timers: { callback: () => void; delayMs: number }[] = []
    let reconcileCalls = 0
    let releaseFirstSweep: (() => void) | undefined
    const firstSweep = new Promise<void>((resolve) => {
      releaseFirstSweep = resolve
    })
    const controller = await scheduleMcpLeaseMaintenance({
      runStore: {
        scan: async () => [],
        purgeTerminal: async () => {},
      },
      leaseStore: {
        purgeStaleDeadTemps: async () => {
          reconcileCalls++
          if (reconcileCalls === 1) await firstSweep
        },
        leasedRunIds: async () => [],
        nextStaleDeadSweepDelay: async () => 100,
        purgeTerminal: async () => {},
        purgeStaleDeadOrphan: async () => false,
        claimStale: async () => undefined,
        release: async () => {},
      },
      upsertTrace: () => ({ revision: 1 }),
      retryBaseMs: 7,
      retryMaxMs: 70,
      setTimeout: (callback: () => void, delayMs: number) => {
        timers.push({ callback, delayMs })
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {},
    } as unknown as Parameters<typeof scheduleMcpLeaseMaintenance>[0])

    // Callback A starts the first sweep. Two normal-finalizer requests arrive
    // while it is blocked and must coalesce into one delayed follow-up B.
    timers[0]?.callback()
    await flushAsyncWork()
    expect(reconcileCalls).toBe(1)
    controller.request()
    controller.request()
    expect(timers).toHaveLength(1)
    releaseFirstSweep?.()
    await flushAsyncWork()
    expect(timers).toHaveLength(3)

    // Completion briefly plans C from the regular stale-dead sweep, then
    // cancels it in favor of the single coalesced completion retry B.
    expect(timers.map((timer) => timer.delayMs)).toEqual([100, 100, 7])
    timers[2]?.callback()
    await flushAsyncWork()
    expect(timers).toHaveLength(4)
    expect(reconcileCalls).toBe(2)
    expect(timers[3]?.delayMs).toBe(100)

    // The fake host deliberately invokes every captured callback after stop,
    // including callbacks canceled by replacement. None may start a third
    // reconciliation or schedule new work after shutdown.
    controller.stop()
    const callsAtStop = reconcileCalls
    for (const timer of timers) timer.callback()
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(reconcileCalls).toBe(callsAtStop)
    expect(timers).toHaveLength(4)
  })

  it("replaces a long stale-owner timer with a bounded completion cleanup retry", async () => {
    const timers: { callback: () => void; delayMs: number }[] = []
    let reconciliations = 0
    const controller = await scheduleMcpLeaseMaintenance({
      runStore: {
        scan: async () => [],
        purgeTerminal: async () => {},
      },
      leaseStore: {
        purgeStaleDeadTemps: async () => {
          reconciliations++
        },
        leasedRunIds: async () => [],
        nextStaleDeadSweepDelay: async () => 30_000,
        purgeTerminal: async () => {},
        purgeStaleDeadOrphan: async () => false,
        claimStale: async () => undefined,
        release: async () => {},
      },
      upsertTrace: () => ({ revision: 1 }),
      retryBaseMs: 7,
      retryMaxMs: 70,
      setTimeout: (callback: () => void, delayMs: number) => {
        timers.push({ callback, delayMs })
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {},
    } as unknown as Parameters<typeof scheduleMcpLeaseMaintenance>[0])

    expect(timers.map((timer) => timer.delayMs)).toEqual([30_000])
    controller.request()
    expect(timers.map((timer) => timer.delayMs)).toEqual([30_000, 7])

    // The canceled long callback cannot run, while the replacement does.
    timers[0]?.callback()
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(reconciliations).toBe(0)
    timers[1]?.callback()
    await flushAsyncWork()
    expect(reconciliations).toBe(1)
    controller.stop()
  })

  it("retries transient Windows locks while releasing leases and purging terminal checkpoints", async () => {
    const { runsDir, tracesDir, provenance } = fixture()
    let failLeaseCleanup = false
    let leaseDeleteAttempts = 0
    const leaseStore = new McpRunLeaseStore(runsDir, {
      now: () => 1000,
      fileOperationRetryDelayMs: 0,
      unlink: async (filePath) => {
        if (failLeaseCleanup && leaseDeleteAttempts++ < 2) {
          throw Object.assign(new Error("locked lease"), { code: "EPERM" })
        }
        await fs.unlink(filePath)
      },
    })
    let directoryDeleteAttempts = 0
    const runStore = new AgentRunStore(runsDir, {
      fileOperationRetryDelayMs: 0,
      removeDirectory: async (directory) => {
        if (directoryDeleteAttempts++ < 2) {
          throw Object.assign(new Error("locked checkpoint"), { code: "EBUSY" })
        }
        await fs.rm(directory, { recursive: true, force: true })
      },
    })
    const adapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => 1000,
    })
    await adapter.begin({ provenance, operation: "com.example.files/read" })
    failLeaseCleanup = true
    await adapter.finalize({
      provenance,
      startedAt: 900,
      endedAt: 1000,
      ok: true,
    })

    expect(directoryDeleteAttempts).toBe(3)
    expect(leaseDeleteAttempts).toBe(3)
    expect(await runStore.scan()).toEqual([])
    expect(leaseNames(runsDir)).toEqual([])
  })

  it("does not swallow a non-transient lease cleanup failure or drop its live owner", async () => {
    const { runsDir } = fixture()
    let fail = false
    const leaseStore = new McpRunLeaseStore(runsDir, {
      fileOperationRetryDelayMs: 0,
      unlink: async (filePath) => {
        if (fail) throw Object.assign(new Error("access denied"), { code: "EACCES" })
        await fs.unlink(filePath)
      },
    })
    const lease = await leaseStore.acquire("mcp-non-transient-cleanup")
    fail = true

    await expect(leaseStore.release(lease)).rejects.toMatchObject({ code: "EACCES" })
    expect(leaseNames(runsDir)).toContain("mcp-non-transient-cleanup.owner.json")

    // The failed unlink did not silently drop ownership. Once the unrelated
    // access failure clears, a contender still sees the original live owner.
    fail = false
    await expect(leaseStore.acquire("mcp-non-transient-cleanup")).rejects.toMatchObject({
      name: "McpRunLeaseBusyError",
    })

    await expect(leaseStore.release(lease)).resolves.toBeUndefined()
  })

  it("reclaims a stale dead temporary lease left before its owner link", async () => {
    const { runsDir, runStore, tracesDir, provenance } = fixture()
    const interruptedLeaseStore = new McpRunLeaseStore(runsDir, {
      now: () => 1000,
      staleAfterMs: 100,
      processId: 999_999,
      isProcessAlive: () => false,
      fault: (point) => {
        if (point === "after_temp_write_before_link") {
          throw new Error("simulated process death before owner link")
        }
      },
    })
    const adapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore: interruptedLeaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => 1000,
    })

    await expect(
      adapter.begin({ provenance, operation: "com.example.files/read" })
    ).rejects.toThrow("simulated process death before owner link")
    expect(leaseNames(runsDir)).toEqual([expect.stringMatching(/^\.tmp-/)])
    expect(await runStore.scan({})).toEqual([])

    await expect(
      reconcileMcpRunsAtStartup({
        runStore: new AgentRunStore(runsDir),
        leaseStore: new McpRunLeaseStore(runsDir, {
          now: () => 2000,
          staleAfterMs: 100,
          isProcessAlive: () => false,
        }),
        upsertTrace: (input) => upsertRunTrace(tracesDir, input),
        now: () => 2000,
      })
    ).resolves.toEqual({ purged: 0, abandoned: 0 })
    expect(leaseNames(runsDir)).toEqual([])
  })

  it("reclaims both owner and temporary lease records after a post-link crash", async () => {
    const { runsDir, runStore, tracesDir, provenance } = fixture()
    const interruptedLeaseStore = new McpRunLeaseStore(runsDir, {
      now: () => 1000,
      staleAfterMs: 100,
      processId: 999_999,
      isProcessAlive: () => false,
      fault: (point) => {
        if (point === "after_link_before_temp_cleanup") {
          throw new Error("simulated process death after owner link")
        }
      },
    })
    const adapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore: interruptedLeaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => 1000,
    })

    await expect(
      adapter.begin({ provenance, operation: "com.example.files/read" })
    ).rejects.toThrow("simulated process death after owner link")
    expect(leaseNames(runsDir)).toEqual(
      expect.arrayContaining(["mcp-run-1.owner.json", expect.stringMatching(/^\.tmp-/)])
    )
    expect(await runStore.scan({})).toEqual([])

    await expect(
      reconcileMcpRunsAtStartup({
        runStore: new AgentRunStore(runsDir),
        leaseStore: new McpRunLeaseStore(runsDir, {
          now: () => 2000,
          staleAfterMs: 100,
          isProcessAlive: () => false,
        }),
        upsertTrace: (input) => upsertRunTrace(tracesDir, input),
        now: () => 2000,
      })
    ).resolves.toEqual({ purged: 0, abandoned: 0 })
    expect(leaseNames(runsDir)).toEqual([])
  })

  it("retains an active temporary lease while acquisition is paused before its owner link", async () => {
    const { runsDir, runStore, tracesDir, provenance } = fixture()
    const interruptedLeaseStore = new McpRunLeaseStore(runsDir, {
      now: () => 1000,
      staleAfterMs: 100,
      processId: process.pid,
      isProcessAlive: () => true,
      fault: (point) => {
        if (point === "after_temp_write_before_link") {
          throw new Error("simulated live acquire pause")
        }
      },
    })
    const adapter = createMcpDurableRunAdapter({
      runStore,
      leaseStore: interruptedLeaseStore,
      upsertTrace: (input) => upsertRunTrace(tracesDir, input),
      now: () => 1000,
    })

    await expect(
      adapter.begin({ provenance, operation: "com.example.files/read" })
    ).rejects.toThrow("simulated live acquire pause")

    await expect(
      reconcileMcpRunsAtStartup({
        runStore: new AgentRunStore(runsDir),
        leaseStore: new McpRunLeaseStore(runsDir, {
          now: () => 2000,
          staleAfterMs: 100,
          isProcessAlive: () => true,
        }),
        upsertTrace: (input) => upsertRunTrace(tracesDir, input),
        now: () => 2000,
      })
    ).resolves.toEqual({ purged: 0, abandoned: 0 })
    expect(leaseNames(runsDir)).toEqual([expect.stringMatching(/^\.tmp-/)])
  })

  it("reclaims a stale recovery-claim metadata temp left before its atomic rename", async () => {
    const { runsDir, runStore, tracesDir } = fixture()
    const staleOwner = new McpRunLeaseStore(runsDir, {
      now: () => 1000,
      staleAfterMs: 100,
      processId: 999_991,
      isProcessAlive: () => false,
    })
    await staleOwner.acquire("mcp-claim-recovery")
    const interruptedClaimant = new McpRunLeaseStore(runsDir, {
      now: () => 2000,
      staleAfterMs: 100,
      processId: 999_992,
      isProcessAlive: () => false,
      fault: (point) => {
        if (point === "after_claim_temp_write_before_rename") {
          throw new Error("simulated process death before claim metadata rename")
        }
      },
    })

    await expect(interruptedClaimant.claimStale("mcp-claim-recovery")).rejects.toThrow(
      "simulated process death before claim metadata rename"
    )
    expect(leaseNames(runsDir)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\.tmp-/),
        expect.stringMatching(/^mcp-claim-recovery\.recovery-.*\.json$/),
      ])
    )

    await expect(
      reconcileMcpRunsAtStartup({
        runStore: new AgentRunStore(runsDir),
        leaseStore: new McpRunLeaseStore(runsDir, {
          now: () => 3000,
          staleAfterMs: 100,
          isProcessAlive: () => false,
        }),
        upsertTrace: (input) => upsertRunTrace(tracesDir, input),
        now: () => 3000,
      })
    ).resolves.toEqual({ purged: 0, abandoned: 0 })
    expect(leaseNames(runsDir)).toEqual([])
    expect(await runStore.scan({})).toEqual([])
  })

  it("retains an active recovery-claim metadata temp before its atomic rename", async () => {
    const { runsDir, runStore, tracesDir } = fixture()
    const staleOwner = new McpRunLeaseStore(runsDir, {
      now: () => 1000,
      staleAfterMs: 100,
      processId: 999_991,
      isProcessAlive: () => false,
    })
    await staleOwner.acquire("mcp-claim-recovery")
    const interruptedClaimant = new McpRunLeaseStore(runsDir, {
      now: () => 2000,
      staleAfterMs: 100,
      processId: process.pid,
      isProcessAlive: (pid) => pid === process.pid,
      fault: (point) => {
        if (point === "after_claim_temp_write_before_rename") {
          throw new Error("simulated active claimant pause")
        }
      },
    })

    await expect(interruptedClaimant.claimStale("mcp-claim-recovery")).rejects.toThrow(
      "simulated active claimant pause"
    )

    await expect(
      reconcileMcpRunsAtStartup({
        runStore: new AgentRunStore(runsDir),
        leaseStore: new McpRunLeaseStore(runsDir, {
          now: () => 3000,
          staleAfterMs: 100,
          isProcessAlive: (pid) => pid === process.pid,
        }),
        upsertTrace: (input) => upsertRunTrace(tracesDir, input),
        now: () => 3000,
      })
    ).resolves.toEqual({ purged: 0, abandoned: 0 })
    expect(leaseNames(runsDir)).toEqual([expect.stringMatching(/^\.tmp-/)])
    expect(await runStore.scan({})).toEqual([])
  })

  it("traces external resource operations but never persists discovery polling", async () => {
    const { runStore, tracesDir, adapter } = fixture()
    const entry: MemoryEntry = {
      id: "m1",
      text: "remember this",
      tags: [],
      createdAt: 1,
      scope: { visibility: "workspace", workspaceId: "workspace-1" },
    }
    const host: ToolHostPort = {
      listTools: () => [],
      invokeTool: async () => ({ content: [] }),
    }
    const service = new SynapseMcpToolService(host, {
      clientId: "claude-desktop",
      durableRuns: adapter,
      memory: {
        list: async () => [entry],
        get: async (id) => (id === entry.id ? entry : undefined),
      },
      now: () => 1000,
      workspaceBinding: { kind: "bound", workspaceId: "workspace-1" },
      workspaceId: "workspace-1",
      workspaces: {
        get: async (id) => (id === "workspace-1" ? { id, name: "Work", createdAt: 0 } : undefined),
      },
    })

    await service.listTools()
    expect(await runStore.scan({})).toEqual([])
    expect(listRuns(tracesDir)).toEqual([])

    await service.listResources()
    await service.readResource("synapse://memory/m1")

    const traces = listRuns(tracesDir, { origin: "mcp" }).sort((a, b) =>
      a.toolCalls[0]!.name.localeCompare(b.toolCalls[0]!.name)
    )
    expect(
      traces.map((trace) => ({
        operation: trace.toolCalls[0]!.name,
        principal: trace.principal,
        workspaceId: trace.workspaceId,
      }))
    ).toEqual([
      {
        operation: "resources/list",
        principal: { kind: "external-mcp", clientId: "claude-desktop" },
        workspaceId: "workspace-1",
      },
      {
        operation: "resources/read:synapse://memory/m1",
        principal: { kind: "external-mcp", clientId: "claude-desktop" },
        workspaceId: "workspace-1",
      },
    ])
    expect(await runStore.scan({})).toEqual([])
  })
})
