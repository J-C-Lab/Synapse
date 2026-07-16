import type { Buffer } from "node:buffer"
import type { ChildConfig, ChildScenario } from "./durable-run-child"
import type { DurableFaultPoint } from "./fault-points"
import { execFileSync } from "node:child_process"
import { promises as fs, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { faultPointId, SIMULATED_CRASH_EXIT_CODE } from "./fault-points"

// Checkpoint A crash matrix (Task 16). Every other durable-recovery test in
// this programme (Tasks 9-11) proves recovery via a `fault?:` callback
// thrown WITHIN one still-running process — a real, but incomplete, proxy
// for a crash. This suite's only new claim is narrower and load-bearing:
// that a durable run recovers identically after a REAL process death (a
// genuinely separate child process, killed via process.exit at the named
// boundary) and a REAL fresh process (a second child, with its own empty
// in-memory state, reading only what made it to disk). See
// durable-run-child.ts for the child entry point and fault-points.ts for
// the full fault-point catalog this suite draws its representative subset
// from.

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-crash-matrix-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// pnpm's node_modules/.bin/tsx is a POSIX shebang script; on Windows only
// the sibling tsx.CMD shim is directly executable by the OS process-creation
// API. Node special-cases .cmd files on Windows even without `shell: true`,
// so targeting the right file lets execFileSync pass array args (this repo's
// own path contains spaces) through untouched rather than needing shell
// quoting rules.
const TSX_BIN_NAME = process.platform === "win32" ? "tsx.CMD" : "tsx"
const TSX_BIN = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  ".bin",
  TSX_BIN_NAME
)
const TSCONFIG = path.join(__dirname, "..", "..", "..", "..", "..", "tsconfig.node.json")
const CHILD_SCRIPT = path.join(__dirname, "durable-run-child.ts")

interface RunOutcome {
  exitCode: number
}

/** Node requires `shell: true` to spawn a .cmd/.bat file at all (a
 *  CVE-2024-27980 hardening — EINVAL otherwise), but with `shell: true` on
 *  Windows the args array is joined into one cmd.exe command line WITHOUT
 *  automatic quoting, so a path containing spaces (this repo's own path
 *  does) must be quoted by hand or it splits into multiple arguments. */
function quoteArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`
}

function runChild(configPath: string): RunOutcome {
  try {
    execFileSync(
      quoteArg(TSX_BIN),
      ["--tsconfig", TSCONFIG, CHILD_SCRIPT, configPath].map(quoteArg),
      {
        stdio: "pipe",
        shell: true,
      }
    )
    return { exitCode: 0 }
  } catch (err) {
    const status = (err as { status?: number | null }).status
    if (status === null || status === undefined) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
      throw new Error(`child process failed to spawn or was killed by a signal: ${stderr}`)
    }
    return { exitCode: status }
  }
}

function writeConfig(configPath: string, config: ChildConfig): void {
  writeFileSync(configPath, JSON.stringify(config), "utf-8")
}

/** Runs the crash pass (asserting it dies at exactly the requested fault
 *  point) then a genuinely fresh resume pass (asserting it completes). */
function crashThenResume(
  baseDir: string,
  runId: string,
  scenario: ChildScenario,
  crashAt: DurableFaultPoint
): void {
  const startConfigPath = path.join(baseDir, "config-start.json")
  writeConfig(startConfigPath, { baseDir, runId, scenario, createCheckpoint: true, crashAt })
  const crashResult = runChild(startConfigPath)
  expect(crashResult.exitCode, `expected a simulated crash at ${faultPointId(crashAt)}`).toBe(
    SIMULATED_CRASH_EXIT_CODE
  )
  expect(existsSync(path.join(baseDir, "result.json"))).toBe(false)

  const resumeConfigPath = path.join(baseDir, "config-resume.json")
  writeConfig(resumeConfigPath, { baseDir, runId, scenario, createCheckpoint: false })
  const resumeResult = runChild(resumeConfigPath)
  expect(resumeResult.exitCode, `resume after crashing at ${faultPointId(crashAt)}`).toBe(0)
}

function existsSync(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

function readResult(baseDir: string): { kind: string; stopReason?: string } {
  return JSON.parse(readFileSync(path.join(baseDir, "result.json"), "utf-8")) as {
    kind: string
    stopReason?: string
  }
}

function readJsonl(filePath: string): unknown[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

describe("crash matrix — three-call tool batch (real process crash + resume)", () => {
  const cleanRecoveryFaultPoints: DurableFaultPoint[] = [
    { subsystem: "toolBatch", point: "after_batch_created" },
    { subsystem: "toolBatch", point: "after_attempt_completed" },
    { subsystem: "toolBatch", point: "after_materialized" },
  ]

  it.each(cleanRecoveryFaultPoints)(
    "recovers with exactly one invocation per ordinal after crashing at $point",
    (crashAt) => {
      crashThenResume(dir, "run-3call", "three_call_batch", crashAt)

      expect(readResult(dir)).toEqual({ kind: "finalized", stopReason: "end_turn" })

      const invocations = readJsonl(path.join(dir, "tool-invocations.jsonl")) as {
        input: { n: number }
      }[]
      // The whole point of the ordered tool-batch ledger: ordinal 0 (or
      // whichever ordinals had already resolved before the crash) is never
      // replayed once the resume process starts driving the same batch
      // again — exactly one invocation per ordinal, never zero, never two.
      expect(invocations.map((i) => i.input.n).sort()).toEqual([1, 2, 3])
    },
    30_000
  )

  it("correctly suspends (never silently resumes) when crashing mid-invocation, since this adapter has no replay guarantee", () => {
    // A real discovery from running this crash point through an ACTUAL
    // process death: after_attempt_started fires after the checkpoint
    // durably records the attempt as "started" but BEFORE the tool
    // actually ran. On resume, tool-registry.ts's invocationAdapterFor
    // always returns replayGuarantee "none" for this test's plain host
    // tool, so recoverInterruptedAttempt (tool-batch-runner.ts) can never
    // trust a "prior-result"/"not-found" answer for it — by design, the
    // run correctly suspends into suspended_unknown_tool_outcome rather
    // than guessing whether ordinal 0 actually executed. This is the
    // safety invariant Task 8/10 exist to enforce, now proven through a
    // real crash rather than a callback-simulated one.
    crashThenResume(dir, "run-3call-suspend", "three_call_batch", {
      subsystem: "toolBatch",
      point: "after_attempt_started",
    })
    expect(readResult(dir)).toEqual({ kind: "suspended_unknown_tool_outcome" })
    // The fault fires right after the checkpoint durably records the
    // attempt as "started" but BEFORE the tool is actually invoked in
    // that same process — so the tool never really ran in the crash
    // process, and correctly suspending means it's never invoked in the
    // resume process either.
    const invocations = readJsonl(path.join(dir, "tool-invocations.jsonl"))
    expect(invocations).toHaveLength(0)
  }, 30_000)
})

describe("crash matrix — pending and denied approval (real process crash + resume)", () => {
  const faultPoints: DurableFaultPoint[] = [
    { subsystem: "toolBatch", point: "after_approval_pending" },
    { subsystem: "toolBatch", point: "after_approval_resolved" },
  ]

  it.each(faultPoints)(
    "preserves the denial without executing the tool after crashing at $point",
    (crashAt) => {
      crashThenResume(dir, "run-approval-denied", "approval_denied", crashAt)
      expect(readResult(dir)).toEqual({ kind: "finalized", stopReason: "end_turn" })
      expect(readJsonl(path.join(dir, "tool-invocations.jsonl"))).toHaveLength(0)
    },
    30_000
  )
})

describe("crash matrix — model-step hold/dispatch (real process crash + resume)", () => {
  const faultPoints: DurableFaultPoint[] = [
    { subsystem: "model", point: "after_hold" },
    { subsystem: "model", point: "after_dispatch_checkpoint" },
    // These are the two sides of accepting a response: the provider has
    // already answered, but the durable checkpoint/ledger may not yet agree
    // on whether that answer has been settled. A fresh process must settle
    // the staged response rather than sending it again.
    { subsystem: "model", point: "after_response_staged" },
    { subsystem: "model", point: "after_settle_ledger" },
    { subsystem: "model", point: "after_settle" },
  ]

  it.each(faultPoints)(
    "recovers and calls the provider exactly once across both processes after crashing at $point",
    (crashAt) => {
      crashThenResume(dir, "run-dispatch", "model_dispatch_crash", crashAt)

      expect(readResult(dir)).toEqual({ kind: "finalized", stopReason: "end_turn" })
      const providerCalls = readJsonl(path.join(dir, "provider-calls.jsonl"))
      expect(providerCalls).toHaveLength(1)
    },
    30_000
  )
})

describe("crash matrix — estimator incompatibility (real process crash + resume)", () => {
  it("replays durable incompatibility after after_settle, quarantines once, and finalizes failed", () => {
    crashThenResume(dir, "run-estimator-incompatible", "estimator_incompatible", {
      subsystem: "model",
      point: "after_settle",
    })

    expect(readResult(dir)).toEqual({ kind: "finalized", stopReason: "error" })
    expect(readJsonl(path.join(dir, "provider-calls.jsonl"))).toHaveLength(1)
    expect(readJsonl(path.join(dir, "estimator-quarantines.jsonl"))).toHaveLength(1)
  }, 30_000)
})

describe("crash matrix — finalization phases (real process crash + resume)", () => {
  const faultPoints: DurableFaultPoint[] = [
    { subsystem: "finalizer", point: "after_prepared" },
    { subsystem: "finalizer", point: "after_trace_upserted" },
    { subsystem: "finalizer", point: "after_resources_released" },
    { subsystem: "finalizer", point: "after_lease_released" },
    { subsystem: "finalizer", point: "after_complete" },
  ]

  it.each(faultPoints)(
    "reaches completion exactly once after crashing at $point",
    (crashAt) => {
      crashThenResume(dir, "run-finalize", "finalization_phases", crashAt)
      expect(readResult(dir)).toEqual({ kind: "finalized", stopReason: "end_turn" })
    },
    30_000
  )
})
