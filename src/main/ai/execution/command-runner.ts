import type { Buffer } from "node:buffer"
import type { ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"
import type {
  AgentArtifactRef,
  AgentArtifactStore,
  ArtifactOwnerContext,
  ArtifactProducer,
  ArtifactTruncationReason,
} from "../artifacts/artifact-types"
import type { WorkspacePolicy } from "./workspace-policy"
import { spawn } from "node:child_process"
import process from "node:process"
import { sandboxCommandEnv } from "./command-env"
import { captureHeadTail } from "./stream-capture"

const DEFAULT_TIMEOUT_MS = 30_000
// Legacy in-memory preview cap — only used on the fallback path (no run
// context to scope a durable artifact under). See CommandRunResult's
// legacyStdout/legacyStderr for where this still applies.
const MAX_OUTPUT_CHARS = 32_000

/** Default bounded live preview budget for the artifact-backed path, split
 *  head+tail instead of one leading slice. Kept in the same order of
 *  magnitude as the old MAX_OUTPUT_CHARS cap so IPC/model payload size
 *  doesn't regress, while the *full* captured output (up to the artifact
 *  store's own per-artifact limit) reaches disk, not just this preview. */
export const DEFAULT_HEAD_PREVIEW_BYTES = 16_000
export const DEFAULT_TAIL_PREVIEW_BYTES = 16_000

/** The honest reality this module implements: a real shell spawned as the
 *  host user, with the host's full filesystem/network access — never a
 *  sandbox. execution-backend.ts's local-policy descriptor is built from
 *  this constant so the two can never silently drift apart. */
export const COMMAND_RUNNER_ISOLATION = "none" as const

/** Wires a command's stdout/stderr through AgentArtifactStore.capture()
 *  instead of the legacy in-memory slice. Only constructed by the caller
 *  when there is a real run to scope the artifacts under — see
 *  execution-tool-host.ts's owner derivation for the exact rule. */
export interface CommandArtifactCapture {
  store: AgentArtifactStore
  owner: ArtifactOwnerContext
  headPreviewBytes?: number
  tailPreviewBytes?: number
}

export interface CommandRunInput {
  rootId: string
  command: string
  cwd?: string
  timeoutMs?: number
  /** When present, stdout/stderr are captured as durable artifacts (bounded
   *  head/tail live previews plus a full artifact-store-backed capture up
   *  to the store's own limits) instead of the legacy unconditional
   *  first-32,000-character in-memory slice. */
  artifacts?: CommandArtifactCapture
}

export interface CommandStreamOutcome {
  headPreview: string
  tailPreview: string
  artifact: AgentArtifactRef
}

export interface CommandRunResult {
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  /** Present when `input.artifacts` was supplied — the durable-capture
   *  path. */
  stdout?: CommandStreamOutcome
  stderr?: CommandStreamOutcome
  /** Present when `input.artifacts` was NOT supplied — the original
   *  unconditional first-32,000-character capture, unchanged. */
  legacyStdout?: string
  legacyStderr?: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export async function runCommand(
  policy: WorkspacePolicy,
  input: CommandRunInput,
  signal?: AbortSignal
): Promise<CommandRunResult> {
  const resolved = await policy.resolvePath(input.rootId, input.cwd ?? ".")
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh"
  const shellArgs =
    process.platform === "win32" ? ["-NoProfile", "-Command", input.command] : ["-c", input.command]

  const child = spawn(shell, shellArgs, {
    cwd: resolved.absolutePath,
    env: sandboxCommandEnv(),
    windowsHide: true,
  })

  let timedOut = false
  let cancelled = false
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => {
    timedOut = true
    killProcessTree(child)
  }, timeoutMs)

  const onAbort = (): void => {
    cancelled = true
    killProcessTree(child)
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })

  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })

  try {
    if (input.artifacts) {
      const { stdout, stderr, exitCode } = await captureArtifactOutput(
        child,
        input.artifacts,
        closed
      )
      return {
        exitCode,
        timedOut,
        cancelled: cancelled || Boolean(signal?.aborted),
        stdout,
        stderr,
      }
    }

    const legacy = await captureLegacyOutput(child, closed)
    return {
      exitCode: legacy.exitCode,
      timedOut,
      cancelled: cancelled || Boolean(signal?.aborted),
      legacyStdout: legacy.stdout,
      legacyStderr: legacy.stderr,
      stdoutTruncated: legacy.stdoutTruncated,
      stderrTruncated: legacy.stderrTruncated,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** Captures stdout and stderr concurrently as two independent artifacts,
 *  coordinated by one AbortController shared between both producers.
 *
 *  Node's `Readable[Symbol.asyncIterator]` (consumed inside
 *  AgentArtifactStore.capture() via `for await`) already provides real
 *  backpressure: pausing consumption pauses the underlying OS pipe, which
 *  pauses the child's writes. capture() itself owns the awaited write side.
 *
 *  The coordination this function is responsible for: if EITHER stream's
 *  capture hits its own hard limit (quota/disk-reserve/write-error),
 *  capture() calls that stream's `producer.abort(reason)` — which must (a)
 *  kill the *entire* process tree (not just stop reading its own stream),
 *  since leaving the child alive with an undrained sibling pipe can
 *  deadlock it, and (b) fire the shared AbortSignal so the sibling
 *  capture's own in-flight loop — checking `producer.signal?.aborted` on
 *  its next chunk — correctly finalizes itself as `complete: false` /
 *  `truncationReason: "producer-aborted"` too, rather than reporting a
 *  false `complete: true` for output that was actually cut short by its
 *  sibling. */
async function captureArtifactOutput(
  child: ChildProcess,
  artifacts: CommandArtifactCapture,
  closed: Promise<number | null>
): Promise<{
  stdout: CommandStreamOutcome
  stderr: CommandStreamOutcome
  exitCode: number | null
}> {
  const controller = new AbortController()
  const headBytes = artifacts.headPreviewBytes ?? DEFAULT_HEAD_PREVIEW_BYTES
  const tailBytes = artifacts.tailPreviewBytes ?? DEFAULT_TAIL_PREVIEW_BYTES

  const captureStream = (
    readable: Readable,
    kind: "command-stdout" | "command-stderr"
  ): Promise<CommandStreamOutcome> => {
    const tee = captureHeadTail(readable as unknown as AsyncIterable<Uint8Array>, {
      headBytes,
      tailBytes,
    })
    const producer: ArtifactProducer = {
      signal: controller.signal,
      abort: (_reason: ArtifactTruncationReason) => {
        // Kill first, then signal: killing closes both pipes, which is
        // what actually stops the sibling's producer; the signal is the
        // seam that tells the sibling's *already in-flight* capture loop
        // not to report itself complete once its stream ends as a result.
        killProcessTree(child)
        if (!controller.signal.aborted) controller.abort()
      },
    }
    return artifacts.store
      .capture(
        tee.bytes,
        {
          runId: artifacts.owner.runId,
          owner: artifacts.owner,
          kind,
          mediaType: "text/plain; charset=utf-8",
        },
        producer
      )
      .then((artifact) => ({
        headPreview: tee.headPreview(),
        tailPreview: tee.tailPreview(),
        artifact,
      }))
  }

  if (!child.stdout || !child.stderr) {
    throw new Error("spawned command is missing stdout/stderr pipes")
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    captureStream(child.stdout, "command-stdout"),
    captureStream(child.stderr, "command-stderr"),
    closed,
  ])
  return { stdout, stderr, exitCode }
}

async function captureLegacyOutput(
  child: ChildProcess,
  closed: Promise<number | null>
): Promise<{
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  exitCode: number | null
}> {
  let stdout = ""
  let stderr = ""
  let stdoutTruncated = false
  let stderrTruncated = false

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString()
    if (stdout.length >= MAX_OUTPUT_CHARS) {
      stdoutTruncated = true
      return
    }
    const remaining = MAX_OUTPUT_CHARS - stdout.length
    stdout += text.length > remaining ? text.slice(0, remaining) : text
    if (text.length > remaining) stdoutTruncated = true
  })

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString()
    if (stderr.length >= MAX_OUTPUT_CHARS) {
      stderrTruncated = true
      return
    }
    const remaining = MAX_OUTPUT_CHARS - stderr.length
    stderr += text.length > remaining ? text.slice(0, remaining) : text
    if (text.length > remaining) stderrTruncated = true
  })

  const exitCode = await closed
  return { stdout, stderr, stdoutTruncated, stderrTruncated, exitCode }
}

/** The capture sink's only way to actually stop a command's producer — kills
 *  the whole process tree, not just this process, so a shell that spawned
 *  its own children can't keep writing after a quota/timeout/cancel event.
 *  Exported so stream-capture coordination (above) and callers outside this
 *  module (timeout/cancel today, tests) can all reuse the exact same kill
 *  path rather than reimplementing it. */
export function killProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true })
    return
  }
  child.kill("SIGKILL")
}

export function truncatePreview(
  text: string,
  max = MAX_OUTPUT_CHARS
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}
