import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { ShellExecutor } from "./shell-executor"
import { resolveCwd } from "./allowed-root"

// Built-in governed shell tool exposed to the agent as a ToolHostSource. Only
// mounted when the user enables it (src/main/index.ts). Every call carries
// requiresConfirmation so the agent approval gate always prompts with the command.

export const SHELL_FQ_PREFIX = "shell:"
const SHELL_PLUGIN_ID = "shell:core"
const RUN_SHELL_FQ = `${SHELL_PLUGIN_ID}/run_shell`

export interface ShellAuditEntry {
  command: string
  cwd: string
  exitCode: number | null
  durationMs: number
  truncated: boolean
  timedOut: boolean
}

export interface ShellToolOptions {
  executor: ShellExecutor
  allowedRoots: () => string[]
  defaultCwd: () => string
  audit?: (entry: ShellAuditEntry) => void
  /** When false, run_shell is hidden and cannot be invoked. Defaults to always on. */
  enabled?: () => boolean
}

const DESCRIPTOR: RegisteredToolDescriptor = {
  fqName: RUN_SHELL_FQ,
  pluginId: SHELL_PLUGIN_ID,
  manifestTool: {
    name: "run_shell",
    title: "Run local command",
    description:
      "Execute a shell command on the user's local machine for general, scriptable local tasks (file inspection, git, build/test runners, data wrangling). Has side effects and ALWAYS requires user confirmation. Prefer an installed plugin when the task matches a plugin's specialty (cloud services with brokered credentials, governed/approved writeback, revocable capabilities) — call describe_plugin to check. On Windows the shell is PowerShell; on macOS/Linux it is sh.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run in the local shell." },
        cwd: {
          type: "string",
          description: "Optional working directory; must be inside an allowed root.",
        },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true, requiresConfirmation: true },
  },
}

export class ShellToolSource implements ToolHostSource {
  constructor(private readonly options: ShellToolOptions) {}

  private isEnabled(): boolean {
    return this.options.enabled?.() ?? true
  }

  ownsTool(fqName: string): boolean {
    return this.isEnabled() && fqName.startsWith(SHELL_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.isEnabled() ? [DESCRIPTOR] : []
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options?: ToolInvocationOptions
  ): Promise<ToolResult> {
    if (fqName !== RUN_SHELL_FQ) return errorResult(`Unknown tool: ${fqName}`)
    // Defense in depth: composite routing already gates on ownsTool/listTools,
    // but never execute a command when shell is disabled, even on a direct call.
    if (!this.isEnabled()) return errorResult("Local shell is disabled.")
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
    const command = typeof args.command === "string" ? args.command : ""
    if (!command.trim()) return errorResult("command is required.")

    const cwdArg = typeof args.cwd === "string" ? args.cwd : undefined
    const resolved = resolveCwd(cwdArg, this.options.defaultCwd(), this.options.allowedRoots())
    if (!resolved.ok) return errorResult(resolved.reason)

    try {
      const result = await this.options.executor.run({
        command,
        cwd: resolved.cwd,
        signal: options?.signal,
      })
      this.options.audit?.({
        command,
        cwd: resolved.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
      })
      const text = [
        `exit: ${result.exitCode ?? "killed"}${result.timedOut ? " (timed out)" : ""}`,
        `stdout:\n${result.stdout}`,
        result.stderr ? `stderr:\n${result.stderr}` : "",
        result.truncated ? "(output truncated)" : "",
      ]
        .filter(Boolean)
        .join("\n")
        .concat("\n")
      return {
        content: [{ type: "text", text }],
        structured: result,
        isError: result.exitCode !== 0,
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}
