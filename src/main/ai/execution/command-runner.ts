import type { Buffer } from "node:buffer"
import type { ChildProcess } from "node:child_process"
import type { WorkspacePolicy } from "./workspace-policy"
import { spawn } from "node:child_process"
import process from "node:process"
import { sandboxCommandEnv } from "./command-env"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 32_000

/** The honest reality this module implements: a real shell spawned as the
 *  host user, with the host's full filesystem/network access — never a
 *  sandbox. execution-backend.ts's local-policy descriptor is built from
 *  this constant so the two can never silently drift apart. */
export const COMMAND_RUNNER_ISOLATION = "none" as const

export interface CommandRunInput {
  rootId: string
  command: string
  cwd?: string
  timeoutMs?: number
}

export interface CommandRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
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

  return new Promise<CommandRunResult>((resolve, reject) => {
    const child = spawn(shell, shellArgs, {
      cwd: resolved.absolutePath,
      env: sandboxCommandEnv(),
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let cancelled = false

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    const onAbort = () => {
      cancelled = true
      killProcessTree(child)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (stdout.length >= MAX_OUTPUT_CHARS) {
        stdoutTruncated = true
        return
      }
      const remaining = MAX_OUTPUT_CHARS - stdout.length
      stdout += text.length > remaining ? text.slice(0, remaining) : text
      if (text.length > remaining) stdoutTruncated = true
    })

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (stderr.length >= MAX_OUTPUT_CHARS) {
        stderrTruncated = true
        return
      }
      const remaining = MAX_OUTPUT_CHARS - stderr.length
      stderr += text.length > remaining ? text.slice(0, remaining) : text
      if (text.length > remaining) stderrTruncated = true
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(err)
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        cancelled: cancelled || Boolean(signal?.aborted),
        stdoutTruncated,
        stderrTruncated,
      })
    })
  })
}

function killProcessTree(child: ChildProcess): void {
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
