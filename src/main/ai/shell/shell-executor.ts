import type { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import process from "node:process"

export interface ShellRunRequest {
  command: string
  cwd: string
  signal?: AbortSignal
}

export interface ShellRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

export interface ShellLimits {
  timeoutMs: number
  maxOutputBytes: number
}

export interface ShellExecutor {
  run: (request: ShellRunRequest) => Promise<ShellRunResult>
}

function platformShell(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    }
  }
  return { file: "sh", args: ["-c", command] }
}

/** Default executor: Windows → PowerShell, else `sh -c`. Enforces timeout + output cap. */
export function createNodeShellExecutor(limits: ShellLimits): ShellExecutor {
  return {
    run: ({ command, cwd, signal }) =>
      new Promise<ShellRunResult>((resolve) => {
        const started = Date.now()
        const { file, args } = platformShell(command)
        const child = spawn(file, args, { cwd })

        let stdout = ""
        let stderr = ""
        let truncated = false
        let timedOut = false
        let settled = false

        const cap = (current: string, chunk: Buffer): string => {
          if (current.length >= limits.maxOutputBytes) {
            truncated = true
            return current
          }
          const next = current + chunk.toString("utf8")
          if (next.length > limits.maxOutputBytes) {
            truncated = true
            return next.slice(0, limits.maxOutputBytes)
          }
          return next
        }

        child.stdout.on("data", (chunk: Buffer) => {
          stdout = cap(stdout, chunk)
        })
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = cap(stderr, chunk)
        })

        let timer: ReturnType<typeof setTimeout>

        const finish = (exitCode: number | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({
            stdout,
            stderr,
            exitCode,
            truncated,
            timedOut,
            durationMs: Date.now() - started,
          })
        }

        timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, limits.timeoutMs)

        const onAbort = (): void => {
          child.kill("SIGKILL")
        }
        signal?.addEventListener("abort", onAbort, { once: true })

        child.on("error", () => finish(null))
        child.on("close", (code) => {
          signal?.removeEventListener("abort", onAbort)
          finish(timedOut ? null : code)
        })
      }),
  }
}
