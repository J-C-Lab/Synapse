import type { ToolCaller } from "@synapse/plugin-sdk"
import type { Dirent } from "node:fs"
import type { DurableChatMessage } from "../../runs/durable-messages"
import type { ArtifactQuotaLimits, StatDiskSpace } from "../artifact-quota"
import type {
  AgentArtifactRef,
  ArtifactCaller,
  ArtifactMetadata,
  ArtifactOwnerContext,
} from "../artifact-types"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildCompactionSummaryText, captureHistorySlice } from "../../context/history-artifact"
import { ConversationStore } from "../../conversation-store"
import { DEFAULT_ARTIFACT_QUOTA_LIMITS } from "../artifact-quota"
import { ArtifactStore } from "../artifact-store"
import {
  ArtifactToolSource,
  MAX_ARTIFACT_READ_BYTES,
  READ_ARTIFACT_FQ,
} from "../artifact-tool-source"
import { captureToolResultText } from "../tool-result-capture"

// Checkpoint B exit gate (Task 22, plan §"Pass the Checkpoint B artifact
// gate"). Tasks 17-21 already built extensive, real (non-mocked,
// real-temp-dir) coverage for each quota boundary, crash/restart path, and
// UI error individually. This file proves only the four things a codebase
// survey confirmed have zero existing coverage:
//
//  1. A COMBINED, higher-load, cross-subsystem pressure test: concurrent
//     producers hitting per-artifact/run/global/disk-watermark boundaries
//     *simultaneously*, through three different real production call sites
//     (direct capture, tool-result offload, history-artifact capture)
//     sharing one store — not just isolated ArtifactQuotaStore.reserve()
//     calls.
//  2. A crash injected mid-collectEligible()'s delete sweep, proving the
//     resume-via-fresh-instance convention (this codebase's established
//     restart-simulation pattern — see artifact-quota.test.ts's own
//     "crash-restart simulation" tests) is resumable without a double
//     delete or an orphaned artifact directory.
//  3. A crash injected mid-ConversationStore.delete()'s atomic tombstone
//     write, proving a referenced artifact's reference is never lost
//     across a restart regardless of which side of that atomic write the
//     crash lands on.
//  4. IPC/model-facing payload sizes staying bounded (previews, read_artifact
//     responses, compaction summaries) while the artifact bytes backing them
//     are multi-megabyte, within quota.
//
// Every "restart" below constructs a genuinely fresh store instance over the
// same on-disk directory — this codebase's established convention (see
// artifact-quota.test.ts / artifact-store.test.ts / artifact-retention.test.ts)
// for proving crash-safety without the heavier child-process-spawning crash
// matrix durable-run-restart.test.ts uses. That harness exists specifically
// to prove real OS process death recovers identically to an in-process fault
// throw — a distinction Tasks 17-21 never needed for their own artifact
// crash-simulation tests, and this file follows their precedent rather than
// introducing a second harness style for one integration file.

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-artifact-pressure-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const ampleDisk: StatDiskSpace = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function owner(overrides: Partial<ArtifactOwnerContext> = {}): ArtifactOwnerContext {
  return {
    runId: "run-1",
    rootRunId: "run-1",
    principal: { kind: "internal-agent" },
    ...overrides,
  }
}

function caller(overrides: Partial<ArtifactCaller> = {}): ArtifactCaller {
  return {
    runId: "run-1",
    rootRunId: "run-1",
    principal: { kind: "internal-agent" },
    ...overrides,
  }
}

function toolCaller(overrides: Partial<ToolCaller> = {}): ToolCaller {
  return { kind: "agent", runId: "run-1", ...overrides }
}

function metadata(overrides: Partial<ArtifactMetadata> = {}): ArtifactMetadata {
  return {
    runId: "run-1",
    owner: owner(),
    kind: "tool-result",
    mediaType: "text/plain",
    ...overrides,
  }
}

function noopProducer() {
  return { abort: () => {} }
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Real recursive directory byte size — sums only regular file sizes, so an
 *  empty artifact directory left behind by a rejected reservation (capture()
 *  mkdir's the artifact dir before attempting its reservation; see
 *  artifact-store.test.ts's identical "no manifest.json or data.bin was
 *  ever written" precedent) contributes exactly zero, matching the quota
 *  ledger's own accounting of it. */
async function dirSizeBytes(root: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full)
    } else {
      try {
        total += (await fs.stat(full)).size
      } catch {
        // Racing a concurrent delete of this exact file is fine — it just
        // contributes 0, matching reality at the instant this scan lands.
      }
    }
  }
  return total
}

describe("combined concurrent pressure across every quota boundary simultaneously (gap 1)", () => {
  it("never exceeds the per-artifact/run/global/disk ceilings, and the durable ledger matches physical disk reality afterward", async () => {
    const runIds = ["run-a", "run-b", "run-c", "run-d"]
    const artifactsDir = join(dir, "artifacts")

    // Deliberately tiny relative to the combined demand below (4 runs x 3
    // producers each, most individually well above every ceiling) so every
    // boundary — per-artifact, per-run, global, and disk-watermark — binds
    // for at least some concurrent producer, and rejection (not just
    // truncation) genuinely happens regardless of scheduling order: total
    // demand (12 operations, each wanting several KB) vastly exceeds
    // globalBytes by more than an order of magnitude.
    const limits: ArtifactQuotaLimits = {
      ...DEFAULT_ARTIFACT_QUOTA_LIMITS,
      perArtifactBytes: 3000,
      perRunBytes: 6000,
      globalBytes: 5000,
      minFreeBytes: 1000,
      minFreeFraction: 0,
      manifestReserveBytes: 0,
    }
    // Free disk space is modeled off REAL bytes already committed under
    // artifactsDir rather than a call-count fake, so the watermark shrinks
    // deterministically with actual usage regardless of concurrent
    // scheduling order (a call-count-based fake would be racy here).
    const virtualDiskTotal = 6000
    const statDiskSpace: StatDiskSpace = async () => {
      const used = await dirSizeBytes(artifactsDir)
      return { freeBytes: Math.max(0, virtualDiskTotal - used), totalBytes: virtualDiskTotal }
    }
    const store = new ArtifactStore(artifactsDir, {
      quotaLimits: limits,
      statDiskSpace,
      diskRecheckIntervalBytes: 512,
    })

    interface Outcome {
      kind: "direct" | "tool-result" | "history"
      ref?: AgentArtifactRef
    }
    const tasks: Promise<Outcome>[] = []
    for (const runId of runIds) {
      const own = owner({ runId, rootRunId: runId })

      // Real capture() call — mirrors stream-capture.ts's direct usage.
      tasks.push(
        store
          .capture(new Uint8Array(4000).fill(65), metadata({ runId, owner: own }), noopProducer())
          .then((ref): Outcome => ({ kind: "direct", ref }))
      )

      // Real tool-result-offload call site — mirrors tool-batch-runner.ts's
      // usage of captureToolResultText for an oversized tool result.
      tasks.push(
        captureToolResultText("B".repeat(30_000), { store, owner: own }).then(
          (result): Outcome => ({ kind: "tool-result", ref: result.fullArtifact })
        )
      )

      // Real history-artifact call site — mirrors durable-agent-driver.ts's
      // usage of captureHistorySlice for an evicted context-compression
      // slice.
      const evicted: DurableChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
        messageId: `${runId}-m${i}`,
        message: { role: "user", content: [{ type: "text", text: "c".repeat(100) }] },
      }))
      tasks.push(
        captureHistorySlice(store, own, runId, evicted).then(
          (ref): Outcome => ({ kind: "history", ref })
        )
      )
    }

    const settled = await Promise.allSettled(tasks)
    const fulfilled = settled.filter(
      (r): r is PromiseFulfilledResult<Outcome> => r.status === "fulfilled"
    )
    const rejected = settled.filter((r) => r.status === "rejected")

    // Denial genuinely happens under this pressure, not just truncation —
    // proving the hard ceiling is a real deny, not merely a soft clamp.
    expect(rejected.length).toBeGreaterThan(0)

    // Every artifact that DID get captured (complete or truncated) obeys the
    // per-artifact ceiling, even with four runs and three different capture
    // call sites hitting the same store concurrently.
    for (const outcome of fulfilled) {
      const ref = outcome.value.ref
      if (!ref) continue // tool-result path whose internal capture() itself was denied
      expect(ref.capturedBytes).toBeLessThanOrEqual(limits.perArtifactBytes)
    }

    // The durable ledger: no reservation left pending (every reserve was
    // settled, even on truncated/aborted paths), and neither the per-run nor
    // the global ceiling was ever exceeded — the NEW claim this task adds
    // beyond Task 17's isolated per-boundary tests: the sum of everything
    // granted across every boundary, hit simultaneously by a mixed
    // concurrent load through three different code paths, never exceeds the
    // smallest applicable limit.
    const ledgerRaw = JSON.parse(await fs.readFile(join(artifactsDir, "quota.json"), "utf-8")) as {
      globalReservedBytes: number
      globalCommittedBytes: number
      runs: Record<string, { reservedBytes: number; committedBytes: number }>
    }
    expect(ledgerRaw.globalReservedBytes).toBe(0)
    expect(ledgerRaw.globalCommittedBytes).toBeLessThanOrEqual(limits.globalBytes)
    for (const runId of runIds) {
      const usage = ledgerRaw.runs[runId]
      if (!usage) continue
      expect(usage.reservedBytes).toBe(0)
      expect(usage.committedBytes).toBeLessThanOrEqual(limits.perRunBytes)
    }

    // Physical disk reality matches the ledger's accounting exactly: under
    // combined concurrent load across three production capture call sites,
    // the quota ledger never drifts from what is actually on disk.
    let physicalTotal = 0
    for (const runId of runIds) {
      physicalTotal += await dirSizeBytes(join(artifactsDir, runId))
    }
    expect(physicalTotal).toBe(ledgerRaw.globalCommittedBytes)
  })
})

describe("crash mid-collectEligible() delete sweep is resumable (gap 2)", () => {
  it("resumes across a fresh store instance without double-deleting or leaving an orphaned artifact directory", async () => {
    const store1 = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      isArtifactReferenced: async () => false,
    })
    const refs: AgentArtifactRef[] = []
    for (let i = 0; i < 3; i++) {
      refs.push(
        await store1.capture(
          bytesOf(`candidate-${i}`),
          metadata({ runId: "run-1", owner: owner() }),
          noopProducer()
        )
      )
    }
    await store1.releaseRunPin("run-1", "fin-1")

    // Simulate a crash partway through the delete sweep: the SECOND real
    // per-candidate directory deletion the sweep attempts throws (as if the
    // process died at that exact point) — before any bytes of that specific
    // candidate are actually removed, and before the third candidate is ever
    // reached at all.
    const runDir = join(dir, "run-1")
    let artifactDirDeletionAttempts = 0
    const realRm = fs.rm.bind(fs)
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, opts) => {
      const targetStr = String(target)
      const isArtifactDirDeletion =
        targetStr.startsWith(runDir + sep) &&
        Boolean(opts && (opts as { recursive?: boolean }).recursive)
      if (isArtifactDirDeletion) {
        artifactDirDeletionAttempts += 1
        if (artifactDirDeletionAttempts === 2) {
          throw new Error("simulated crash mid GC delete sweep")
        }
      }
      return realRm(target as never, opts as never)
    })

    await expect(store1.collectEligible()).rejects.toThrow(/simulated crash mid GC delete sweep/)
    rmSpy.mockRestore()

    // Exactly one candidate was fully deleted before the injected crash; the
    // other two (including the one whose deletion was interrupted mid-call)
    // are still fully intact on disk.
    const afterCrash = await fs.readdir(runDir).catch(() => [])
    expect(afterCrash).toHaveLength(2)

    // Restart: a genuinely fresh ArtifactStore instance over the same
    // on-disk directory, exactly this codebase's established
    // restart-simulation convention.
    const store2 = new ArtifactStore(dir, {
      statDiskSpace: ampleDisk,
      isArtifactReferenced: async () => false,
    })
    const result2 = await store2.collectEligible()

    // The resumed sweep finishes off exactly the two remaining candidates —
    // no double-delete of the one already gone, no orphan left behind.
    expect(result2.deletedArtifacts).toBe(2)
    expect(result2.orphanedTempFilesRemoved).toBe(0)

    for (const ref of refs) {
      await expect(store2.stat(ref, caller())).rejects.toMatchObject({ code: "artifact_expired" })
    }
    const remaining = await fs.readdir(runDir).catch(() => [])
    expect(remaining).toEqual([])

    // No reservation leak either: every capture above settled normally at
    // capture time (deletion never touches the quota ledger), so nothing is
    // left pending across the crash.
    const ledgerRaw = JSON.parse(await fs.readFile(join(dir, "quota.json"), "utf-8")) as {
      pendingReservations: Record<string, unknown>
    }
    expect(Object.keys(ledgerRaw.pendingReservations)).toHaveLength(0)
  })
})

describe("restart during conversation deletion preserves referenced artifacts (gap 3)", () => {
  const GRACE_MS = 60_000

  function wired(
    conversationsDir: string,
    artifactsDir: string,
    now: () => number
  ): { conversations: ConversationStore; artifactStore: ArtifactStore } {
    const conversations = new ConversationStore(conversationsDir, now)
    const artifactStore = new ArtifactStore(artifactsDir, {
      now,
      statDiskSpace: ampleDisk,
      isArtifactReferenced: async (uri) => {
        const referenced = await conversations.collectReferencedArtifactUris(now(), GRACE_MS)
        return referenced.has(uri)
      },
    })
    return { conversations, artifactStore }
  }

  it("a crash exactly during the tombstone write leaves the pre-deletion active reference intact after restart", async () => {
    const conversationsDir = join(dir, "conversations")
    const artifactsDir = join(dir, "artifacts")
    let clock = 1_000
    const { conversations: conversations1, artifactStore: artifactStore1 } = wired(
      conversationsDir,
      artifactsDir,
      () => clock
    )

    const ref = await artifactStore1.capture(
      bytesOf("still referenced when the deletion write is interrupted"),
      metadata({ runId: "run-1", owner: owner() }),
      noopProducer()
    )
    await artifactStore1.releaseRunPin("run-1", "fin-1")
    await conversations1.save({
      id: "conv-1",
      workspaceId: "default",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t1", content: "preview", artifact: ref }],
        },
      ],
      createdAt: clock,
      updatedAt: clock,
    })

    // Simulate a crash exactly during ConversationStore.delete()'s atomic
    // tombstone write: the rename that would make the tombstone durable
    // throws — mirroring "the process died after the temp file was written
    // but before the rename committed" — so the ORIGINAL active record must
    // still be the one on disk afterward (atomic-json-store.ts never leaves
    // a torn write).
    const realRename = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (src, destArg) => {
      if (String(destArg).endsWith(`conv-1.json`)) {
        throw new Error("simulated crash mid conversation tombstone write")
      }
      return realRename(src as never, destArg as never)
    })
    await expect(conversations1.delete("conv-1")).rejects.toThrow(
      /simulated crash mid conversation tombstone write/
    )
    renameSpy.mockRestore()

    // Restart: fresh ConversationStore + ArtifactStore instances over the
    // same directories, wired exactly as src/main/index.ts wires them.
    const { conversations: conversations2, artifactStore: artifactStore2 } = wired(
      conversationsDir,
      artifactsDir,
      () => clock
    )

    // The conversation is still active — the interrupted rename never
    // replaced it — so its artifact reference was never lost.
    const stillActive = await conversations2.get("conv-1")
    expect(stillActive).toBeDefined()

    // A GC sweep right after "restart" must not delete the still-actively-
    // referenced artifact.
    const gcAfterCrash = await artifactStore2.collectEligible()
    expect(gcAfterCrash.deletedArtifacts).toBe(0)
    const readAfterCrash = await artifactStore2.read(ref, { start: 0 }, caller())
    expect(Buffer.from(readAfterCrash).toString("utf-8")).toBe(
      "still referenced when the deletion write is interrupted"
    )

    // The system is not stuck: a real (unmocked) deletion on the restarted
    // instance still succeeds, and the normal tombstone-grace-then-eligible
    // lifecycle resumes correctly from here.
    await conversations2.delete("conv-1")
    expect(await conversations2.get("conv-1")).toBeUndefined()

    const withinGrace = await artifactStore2.collectEligible()
    expect(withinGrace.deletedArtifacts).toBe(0)

    clock += GRACE_MS + 1
    const afterGrace = await artifactStore2.collectEligible()
    expect(afterGrace.deletedArtifacts).toBe(1)
    await expect(artifactStore2.read(ref, { start: 0 }, caller())).rejects.toMatchObject({
      code: "artifact_expired",
    })
  })

  it("a deletion that completes normally still survives restart at both sides of the grace-window boundary", async () => {
    const conversationsDir = join(dir, "conversations")
    const artifactsDir = join(dir, "artifacts")
    let clock = 1_000
    const { conversations: conversations1, artifactStore: artifactStore1 } = wired(
      conversationsDir,
      artifactsDir,
      () => clock
    )

    const ref = await artifactStore1.capture(
      bytesOf("kept only during the grace window, across restarts"),
      metadata({ runId: "run-1", owner: owner() }),
      noopProducer()
    )
    await artifactStore1.releaseRunPin("run-1", "fin-1")
    await conversations1.save({
      id: "conv-1",
      workspaceId: "default",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t1", content: "preview", artifact: ref }],
        },
      ],
      createdAt: clock,
      updatedAt: clock,
    })
    await conversations1.delete("conv-1")

    // Restart 1: still inside the grace window.
    const restarted1 = wired(conversationsDir, artifactsDir, () => clock)
    const withinGrace = await restarted1.artifactStore.collectEligible()
    expect(withinGrace.deletedArtifacts).toBe(0)

    // Restart 2: a completely separate fresh pair of instances, past grace.
    clock += GRACE_MS + 1
    const restarted2 = wired(conversationsDir, artifactsDir, () => clock)
    const afterGrace = await restarted2.artifactStore.collectEligible()
    expect(afterGrace.deletedArtifacts).toBe(1)
    expect(afterGrace.deletedBytes).toBe(ref.capturedBytes)
  })
})

describe("model/IPC-facing payload sizes stay bounded while the underlying artifact is large (gap 4)", () => {
  it("tool-result offload keeps the model-facing preview bounded for a multi-MB captured artifact", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const bigText = "A".repeat(6_000_000) // ~6 MB, well under the 64 MiB default ceiling
    const result = await captureToolResultText(bigText, { store, owner: owner() })

    expect(result.complete).toBe(true)
    expect(result.artifact?.capturedBytes).toBeGreaterThan(5_000_000)
    // The bounded head+tail preview that actually reaches the model/renderer
    // stays tiny regardless of the artifact's real size.
    expect(result.previewText.length).toBeLessThan(20_000)
  })

  it("read_artifact returns a capped response regardless of how large the backing artifact is", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const big = new Uint8Array(3_000_000).fill(65) // 3 MB
    const ref = await store.capture(big, metadata(), noopProducer())
    expect(ref.complete).toBe(true)
    expect(ref.capturedBytes).toBe(3_000_000)

    const source = new ArtifactToolSource({ store })
    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri },
      { caller: toolCaller() }
    )
    const responseText = (result.content[0] as { text: string }).text
    // The whole ToolResult JSON payload — what actually crosses the
    // model/IPC boundary for one call — stays capped at
    // MAX_ARTIFACT_READ_BYTES regardless of the artifact's real (3 MB) size.
    expect(responseText.length).toBeLessThan(MAX_ARTIFACT_READ_BYTES + 5000)
    const payload = JSON.parse(responseText) as { capturedBytes: number; content: string }
    expect(payload.capturedBytes).toBe(3_000_000) // metadata still reports the true size
    expect(payload.content.length).toBeLessThanOrEqual(MAX_ARTIFACT_READ_BYTES)
  })

  it("history compaction summary text stays bounded regardless of the evicted slice's byte size", async () => {
    const store = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const evicted: DurableChatMessage[] = Array.from({ length: 2000 }, (_, i) => ({
      messageId: `m${i}`,
      message: { role: "user", content: [{ type: "text", text: "x".repeat(2000) }] },
    })) // serializes to several MB of JSON
    const ref = await captureHistorySlice(store, owner(), "run-1", evicted)
    expect(ref.capturedBytes).toBeGreaterThan(3_000_000)

    const summary = buildCompactionSummaryText(undefined, ref, evicted.length)
    // The synthetic summary message that actually re-enters the model's
    // context window stays a small, fixed-size footer — never proportional
    // to the several MB of evicted conversation it describes.
    expect(summary.length).toBeLessThan(2000)
  })
})
