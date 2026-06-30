# Agent 本地 Shell（受治理）+ 模型自驱路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent 一个受治理的本地 shell 工具 `run_shell`（默认关、永远逐次确认、cwd 范围、超时/输出上限、审计），并通过系统提示路由准则让模型自行判断走 shell 还是现有插件。

**Architecture:** `run_shell` 是 host 内建 `ToolHostSource`（与 MemoryToolSource 同构），仅在用户开启 `allowAgentShell` 时挂进 composite host；执行经注入式 `ShellExecutor` 端口（唯一触碰 child_process 处），治理复用既有 agent 审批门（`requiresConfirmation → 永远询问`）。路由智能靠系统提示准则 + 工具描述 + 既有 `describe_plugin` 能力画像，不写判断层。

**Tech Stack:** TypeScript 5 (strict)、Electron 33、Node child_process、Vitest。

---

## 设计参考

- Spec：[2026-07-01-agent-local-shell-design.md](../specs/2026-07-01-agent-local-shell-design.md)
- 真实接口（实现时对照）：
  - `ToolHostSource` 接口 + `asFallbackSource`：[`src/main/ai/composite-tool-host.ts`](../../../src/main/ai/composite-tool-host.ts)
  - 内建工具源范式：[`src/main/ai/memory/memory-tools.ts:102`](../../../src/main/ai/memory/memory-tools.ts)（`MemoryToolSource`、`ToolResult` 的 `json`/`errorResult` 辅助）
  - `RegisteredToolDescriptor` 形状：`{ fqName, pluginId, manifestTool }`，见 [`src/main/plugins/types.ts:167`](../../../src/main/plugins/types.ts)
  - 审批判定：[`src/main/ai/approval-gate.ts`](../../../src/main/ai/approval-gate.ts)（`destructiveHint/requiresConfirmation → "ask"`）
  - agent 循环 + system prompt：[`src/main/ai/agent-runtime.ts:13`](../../../src/main/ai/agent-runtime.ts)（`DEFAULT_SYSTEM_PROMPT`、`AgentRuntimeOptions`、`run()` 里 `const system = …`）
  - 路径根校验可复用思路：[`packages/plugin-manifest/src/fs-path-scope.ts:248`](../../../packages/plugin-manifest/src/fs-path-scope.ts)（`isRealPathWithinRoot`）
  - settings：[`src/main/settings/settings.ts`](../../../src/main/settings/settings.ts)（`UserSettings` / `defaultSettings` / `normalizeSettings`）
  - composite 装配位置：[`src/main/index.ts:706-720`](../../../src/main/index.ts)

## 文件结构

新增：

- `src/main/ai/shell/allowed-root.ts` — cwd 是否落在允许根内（纯函数）
- `src/main/ai/shell/shell-executor.ts` — child_process 薄封装（唯一副作用处）
- `src/main/ai/shell/shell-tool-source.ts` — `run_shell` 的 ToolHostSource（核心逻辑）
- 各自 `.test.ts`

修改：

- `src/main/settings/settings.ts` — 加 `allowAgentShell` / `agentShellRoots`
- `src/main/ai/agent-runtime.ts` — 路由准则注入 + `shellEnabled` 选项
- `src/main/index.ts` — 按开关装配 ShellToolSource + fallback predicate 加 `shell:` 前缀
- 渲染端设置页 + i18n — shell 开关与允许根（UI 任务）

---

## Task 1: allowed-root — cwd 范围校验（纯函数）

**Files:**
- Create: `src/main/ai/shell/allowed-root.ts`
- Test: `src/main/ai/shell/allowed-root.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest"
import { isWithinAllowedRoot, resolveCwd } from "./allowed-root"

describe("isWithinAllowedRoot", () => {
  it("accepts a path inside a root and the root itself", () => {
    expect(isWithinAllowedRoot("/work/proj", ["/work"])).toBe(true)
    expect(isWithinAllowedRoot("/work", ["/work"])).toBe(true)
  })
  it("rejects escape via .. and sibling-prefix collisions", () => {
    expect(isWithinAllowedRoot("/work/../etc", ["/work"])).toBe(false)
    expect(isWithinAllowedRoot("/workshop", ["/work"])).toBe(false) // not "/work" + sep
  })
  it("rejects when there are no roots", () => {
    expect(isWithinAllowedRoot("/work", [])).toBe(false)
  })
})

describe("resolveCwd", () => {
  it("uses defaultCwd when candidate is undefined", () => {
    expect(resolveCwd(undefined, "/work", ["/work"])).toEqual({ ok: true, cwd: "/work" })
  })
  it("resolves a relative candidate against defaultCwd and validates it", () => {
    expect(resolveCwd("proj", "/work", ["/work"])).toEqual({ ok: true, cwd: "/work/proj" })
  })
  it("fails a candidate outside the roots", () => {
    expect(resolveCwd("/etc", "/work", ["/work"]).ok).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/main/ai/shell/allowed-root.test.ts`
Expected: FAIL（模块缺失）

- [ ] **Step 3: 实现**

```ts
import * as path from "node:path"

/** True if `candidate` (absolute) is the same as, or nested under, one of `roots`. */
export function isWithinAllowedRoot(candidate: string, roots: readonly string[]): boolean {
  const target = path.resolve(candidate)
  return roots.some((root) => {
    const base = path.resolve(root)
    if (target === base) return true
    const withSep = base.endsWith(path.sep) ? base : base + path.sep
    return target.startsWith(withSep)
  })
}

export type ResolveCwdResult = { ok: true; cwd: string } | { ok: false; reason: string }

/**
 * Resolve the working directory for a shell call. `candidate` may be absolute or
 * relative (resolved against `defaultCwd`). The result must lie within `roots`.
 */
export function resolveCwd(
  candidate: string | undefined,
  defaultCwd: string,
  roots: readonly string[]
): ResolveCwdResult {
  const resolved =
    candidate === undefined || candidate.trim() === ""
      ? path.resolve(defaultCwd)
      : path.resolve(defaultCwd, candidate)
  if (!isWithinAllowedRoot(resolved, roots)) {
    return { ok: false, reason: `cwd is outside the allowed roots: ${resolved}` }
  }
  return { ok: true, cwd: resolved }
}
```

> 注：测试里的 `/work` 风格断言在 POSIX CI 上成立；Windows 上 `path.resolve` 会加盘符。若该测试在 Windows 本地跑，用 `path.resolve` 包裹期望值或仅在 posix 断言绝对前缀——核心 CI（见 spec）跑 Node Linux，断言成立。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/main/ai/shell/allowed-root.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/shell/allowed-root.ts src/main/ai/shell/allowed-root.test.ts
git commit -m "feat(shell): add allowed-root cwd validation"
```

---

## Task 2: shell-executor — child_process 薄封装

**Files:**
- Create: `src/main/ai/shell/shell-executor.ts`
- Test: `src/main/ai/shell/shell-executor.test.ts`

- [ ] **Step 1: 写失败测试（仅安全命令）**

```ts
import { describe, expect, it } from "vitest"
import { createNodeShellExecutor } from "./shell-executor"

const isWin = process.platform === "win32"
const limits = { timeoutMs: 5000, maxOutputBytes: 1000 }

describe("createNodeShellExecutor", () => {
  it("runs a safe command and captures stdout + exit code", async () => {
    const exec = createNodeShellExecutor(limits)
    const cmd = isWin ? "Write-Output hi" : "echo hi"
    const result = await exec.run({ command: cmd, cwd: process.cwd() })
    expect(result.stdout.trim()).toBe("hi")
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it("reports a non-zero exit code", async () => {
    const exec = createNodeShellExecutor(limits)
    const cmd = isWin ? "exit 3" : "exit 3"
    const result = await exec.run({ command: cmd, cwd: process.cwd() })
    expect(result.exitCode).toBe(3)
  })

  it("truncates output beyond maxOutputBytes", async () => {
    const exec = createNodeShellExecutor({ timeoutMs: 5000, maxOutputBytes: 5 })
    const cmd = isWin ? "Write-Output 0123456789" : "echo 0123456789"
    const result = await exec.run({ command: cmd, cwd: process.cwd() })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(5)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/main/ai/shell/shell-executor.test.ts`
Expected: FAIL（模块缺失）

- [ ] **Step 3: 实现**

```ts
import { spawn } from "node:child_process"

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

        const finish = (exitCode: number | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ stdout, stderr, exitCode, truncated, timedOut, durationMs: Date.now() - started })
        }

        const timer = setTimeout(() => {
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
          finish(code)
        })
      }),
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/main/ai/shell/shell-executor.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/shell/shell-executor.ts src/main/ai/shell/shell-executor.test.ts
git commit -m "feat(shell): add node shell executor with timeout and output cap"
```

---

## Task 3: shell-tool-source — run_shell 工具源（核心）

**Files:**
- Create: `src/main/ai/shell/shell-tool-source.ts`
- Test: `src/main/ai/shell/shell-tool-source.test.ts`

- [ ] **Step 1: 写失败测试（注入 fake executor，不真跑命令）**

```ts
import type { ShellExecutor, ShellRunResult } from "./shell-executor"
import { describe, expect, it, vi } from "vitest"
import { SHELL_FQ_PREFIX, ShellToolSource } from "./shell-tool-source"

const RUN_SHELL = `shell:core/run_shell`
const okResult: ShellRunResult = {
  stdout: "hi",
  stderr: "",
  exitCode: 0,
  truncated: false,
  timedOut: false,
  durationMs: 5,
}

function makeSource(overrides: Partial<Parameters<typeof ShellToolSource.prototype.constructor>[0]> = {}) {
  const run = vi.fn<[unknown], Promise<ShellRunResult>>().mockResolvedValue(okResult)
  const executor: ShellExecutor = { run: run as never }
  const audit = vi.fn()
  const source = new ShellToolSource({
    executor,
    allowedRoots: () => ["/work"],
    defaultCwd: () => "/work",
    audit,
    ...overrides,
  })
  return { source, run, audit }
}

describe("ShellToolSource", () => {
  it("owns the shell namespace and lists run_shell with confirmation annotations", () => {
    const { source } = makeSource()
    expect(source.ownsTool(`${SHELL_FQ_PREFIX}run_shell`)).toBe(true)
    expect(source.ownsTool("com.x/y")).toBe(false)
    const [tool] = source.listTools()
    expect(tool.manifestTool.name).toBe("run_shell")
    expect(tool.manifestTool.annotations).toMatchObject({ requiresConfirmation: true })
  })

  it("runs a command in the default cwd and returns structured output", async () => {
    const { source, run, audit } = makeSource()
    const result = await source.invokeTool(RUN_SHELL, { command: "echo hi" })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: "echo hi", cwd: "/work" }))
    expect(result.structured).toMatchObject({ exitCode: 0 })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ command: "echo hi", cwd: "/work" }))
  })

  it("rejects an out-of-root cwd without calling the executor", async () => {
    const { source, run } = makeSource()
    const result = await source.invokeTool(RUN_SHELL, { command: "ls", cwd: "/etc" })
    expect(result.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it("errors on empty command", async () => {
    const { source, run } = makeSource()
    const result = await source.invokeTool(RUN_SHELL, { command: "  " })
    expect(result.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it("marks the result as error when exitCode is non-zero", async () => {
    const { source, run } = makeSource()
    run.mockResolvedValueOnce({ ...okResult, exitCode: 2 })
    const result = await source.invokeTool(RUN_SHELL, { command: "false" })
    expect(result.isError).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/main/ai/shell/shell-tool-source.test.ts`
Expected: FAIL（模块缺失）

- [ ] **Step 3: 实现**

```ts
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

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(SHELL_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return [DESCRIPTOR]
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options?: ToolInvocationOptions
  ): Promise<ToolResult> {
    if (fqName !== RUN_SHELL_FQ) return errorResult(`Unknown tool: ${fqName}`)
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
      const text =
        `exit: ${result.exitCode ?? "killed"}${result.timedOut ? " (timed out)" : ""}\n` +
        `stdout:\n${result.stdout}\n` +
        (result.stderr ? `stderr:\n${result.stderr}\n` : "") +
        (result.truncated ? "(output truncated)\n" : "")
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
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/main/ai/shell/shell-tool-source.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/shell/shell-tool-source.ts src/main/ai/shell/shell-tool-source.test.ts
git commit -m "feat(shell): add governed run_shell tool source"
```

---

## Task 4: settings — allowAgentShell / agentShellRoots

**Files:**
- Modify: `src/main/settings/settings.ts`
- Test: `src/main/settings/settings.test.ts`

- [ ] **Step 1: 追加失败测试**

```ts
it("defaults agent shell to disabled with no roots", () => {
  const s = normalizeSettings({})
  expect(s.allowAgentShell).toBe(false)
  expect(s.agentShellRoots).toEqual([])
})

it("accepts allowAgentShell and string roots, ignoring non-strings", () => {
  const s = normalizeSettings({ allowAgentShell: true, agentShellRoots: ["/work", 5, "/data"] })
  expect(s.allowAgentShell).toBe(true)
  expect(s.agentShellRoots).toEqual(["/work", "/data"])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/main/settings/settings.test.ts`
Expected: FAIL（字段不存在）

- [ ] **Step 3: 实现**

在 `UserSettings` 接口加：

```ts
  /** Whether the assistant may run local shell commands (high-risk; off by default). */
  allowAgentShell: boolean
  /** Absolute directories the assistant's shell may run in. Empty = host falls back to home. */
  agentShellRoots: string[]
```

在 `defaultSettings` 加：

```ts
  allowAgentShell: false,
  agentShellRoots: [],
```

在 `normalizeSettings` 的 `if (raw && typeof raw === "object")` 块内加：

```ts
    if (typeof r.allowAgentShell === "boolean") {
      next.allowAgentShell = r.allowAgentShell
    }
    if (Array.isArray(r.agentShellRoots)) {
      next.agentShellRoots = r.agentShellRoots.filter((p): p is string => typeof p === "string")
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/main/settings/settings.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/settings/settings.ts src/main/settings/settings.test.ts
git commit -m "feat(settings): add allowAgentShell and agentShellRoots"
```

---

## Task 5: agent-runtime — 路由准则注入

**Files:**
- Modify: `src/main/ai/agent-runtime.ts`
- Test: `src/main/ai/agent-runtime.test.ts`

- [ ] **Step 1: 追加失败测试**

在 [`agent-runtime.test.ts`](../../../src/main/ai/agent-runtime.test.ts) 中（复用文件内既有的 fake provider 构造方式；本测试断言传给 provider.stream 的 `system`）：

```ts
import { buildSystemPrompt } from "./agent-runtime"

describe("buildSystemPrompt", () => {
  it("always appends the plugin-vs-shell routing guidance", () => {
    const prompt = buildSystemPrompt("BASE", { shellEnabled: false })
    expect(prompt).toContain("BASE")
    expect(prompt).toContain("prefer that plugin")
    expect(prompt).not.toContain("run_shell")
  })
  it("mentions run_shell only when shell is enabled", () => {
    const prompt = buildSystemPrompt("BASE", { shellEnabled: true })
    expect(prompt).toContain("run_shell")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/main/ai/agent-runtime.test.ts`
Expected: FAIL（`buildSystemPrompt` 未导出）

- [ ] **Step 3: 实现**

在 `agent-runtime.ts` 顶部、`DEFAULT_SYSTEM_PROMPT` 附近新增并导出：

```ts
const ROUTING_GUIDANCE_BASE =
  "When a task matches an installed plugin's specialty — cloud services with brokered " +
  "credentials, governed/approved writeback, revocable or audited actions, or a specific " +
  "declared scenario — prefer that plugin, and call describe_plugin first to confirm its " +
  "capability boundary. Plugins exist for what shell and scripts cannot safely do."

const ROUTING_GUIDANCE_SHELL =
  " Use run_shell only for general, local, scriptable tasks where no suitable plugin exists; " +
  "it always requires user confirmation."

export function buildSystemPrompt(base: string, opts: { shellEnabled: boolean }): string {
  const guidance = ROUTING_GUIDANCE_BASE + (opts.shellEnabled ? ROUTING_GUIDANCE_SHELL : "")
  return `${base}\n\n${guidance}`
}
```

在 `AgentRuntimeOptions` 接口加：

```ts
  /** Whether the governed run_shell tool is available this run (drives routing guidance). */
  shellEnabled?: boolean
```

在 `run()` 内，把：

```ts
const system = options.system ?? this.options.defaultSystem ?? DEFAULT_SYSTEM_PROMPT
```

改为：

```ts
const base = options.system ?? this.options.defaultSystem ?? DEFAULT_SYSTEM_PROMPT
const system = buildSystemPrompt(base, { shellEnabled: this.options.shellEnabled ?? false })
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/main/ai/agent-runtime.test.ts`
Expected: PASS（既有用例不回归 + 2 个新用例）

> 若既有用例硬断言了完整 system 字符串，更新它们以包含 routing guidance（这是预期的行为变更）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat(ai): inject plugin-vs-shell routing guidance into system prompt"
```

---

## Task 6: 装配 — 按开关挂载 ShellToolSource（index.ts）

**Files:**
- Modify: `src/main/index.ts`

> 编排入口（coverage 排除），靠 `pnpm typecheck` + `pnpm build` 验证。

- [ ] **Step 1: import**

在 index.ts 顶部 import 区加：

```ts
import * as os from "node:os"
import { SHELL_FQ_PREFIX, ShellToolSource } from "./ai/shell/shell-tool-source"
import { createNodeShellExecutor } from "./ai/shell/shell-executor"
```

- [ ] **Step 2: 构造 shell 源并按开关加入 sources**

定位 [`src/main/index.ts:706-720`](../../../src/main/index.ts) 的 `new AiToolRegistry(new CompositeToolHost([...]), pluginNote)`。在构造前，用已加载的用户设置（该模块在装配 AgentService 时可访问 `UserSettings`；如当前函数签名未传入，将 `allowAgentShell` / `agentShellRoots` 透传进来——它们来自 `loadSettings` 的结果）构造：

```ts
const shellEnabled = settings.allowAgentShell
const shellRoots = settings.agentShellRoots.length > 0 ? settings.agentShellRoots : [os.homedir()]
const shellSource = shellEnabled
  ? new ShellToolSource({
      executor: createNodeShellExecutor({ timeoutMs: 30_000, maxOutputBytes: 100_000 }),
      allowedRoots: () => shellRoots,
      defaultCwd: () => shellRoots[0],
      audit: (entry) => logger.info("agent shell", entry), // 走既有 @main/logging
    })
  : undefined
```

把 sources 数组改为（shell 源排在 fallback 之前，并加入 fallback 的 claimedBy 前缀）：

```ts
const sources = [
  introspectionSource,
  ...(shellSource ? [shellSource] : []),
  asFallbackSource(
    plugins,
    (fqName) =>
      fqName.startsWith(MCP_FQ_PREFIX) ||
      fqName.startsWith(MEMORY_FQ_PREFIX) ||
      fqName.startsWith(PLUGIN_INTROSPECT_PREFIX) ||
      fqName.startsWith(SHELL_FQ_PREFIX),
  ),
  manager,
  new MemoryToolSource(memory),
]
const tools = new AiToolRegistry(new CompositeToolHost(sources), pluginNote)
```

- [ ] **Step 3: 把 shellEnabled 传给 AgentService → AgentRuntime**

`AgentService` 构造 `AgentRuntime`（或等价）处需透传 `shellEnabled`，使 routing guidance 与可用性一致。在 `new AgentService({ … })` 选项里加 `shellEnabled`（若 AgentService 未透传到 runtime，则在 AgentService 内把它并入 `AgentRuntimeOptions`）：

```ts
return new AgentService({
  // …既有字段…
  shellEnabled,
})
```

并在 `AgentService` 里把该字段透传给它构造的 `AgentRuntime`（`AgentServiceOptions` 加可选 `shellEnabled?: boolean`，构造 runtime 时带上）。

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/index.ts src/main/ai/agent-service.ts
git commit -m "feat(main): mount governed shell tool when enabled and thread shellEnabled"
```

---

## Task 7: 渲染端设置开关 + i18n

**Files:**
- Modify: 设置页（[`src/renderer/src/components/pages/settings-page.tsx`](../../../src/renderer/src/components/pages/settings-page.tsx)）或既有 AI/隐私设置子组件
- Modify: `src/renderer/src/i18n/messages/en.json`、`zh-CN.json`
- Modify: settings 读写链路（preload / `lib/electron.ts`），若这两个字段尚未随既有 settings 往返

- [ ] **Step 1: 确认 settings 往返是否已带新字段**

settings 走整对象 `UserSettings` 持久化（main `saveSettings`/`loadSettings`）。若 renderer 是读写整个 settings 对象（常见），新字段会自动随对象往返，无需新 IPC；只需 UI 控件。先确认 renderer 的 settings 类型来自 `UserSettings`——若是，跳到 Step 2；若 renderer 有独立的 settings 类型镜像，补上 `allowAgentShell: boolean` 与 `agentShellRoots: string[]`。

- [ ] **Step 2: 加开关 UI**

在设置页新增一个高危区块：`Switch`（`allowAgentShell`）+ 说明文案（强调高危、每次需确认、仅在允许目录内、无法细粒度限网）。允许根编辑可用一个简单的目录列表（MVP：展示 + 通过 `electronAPI` 的目录选择器添加；若暂无目录选择器，MVP 仅展示「未设置时默认为用户主目录」并允许后续迭代）。开关 on 时才显示允许根编辑。

```tsx
<Switch
  checked={settings.allowAgentShell}
  onCheckedChange={(v) => updateSettings({ allowAgentShell: v })}
/>
```

- [ ] **Step 3: i18n 文案（en + zh-CN）**

en.json 加：

```json
"settings": {
  "agentShell": {
    "title": "Allow the assistant to run local commands",
    "description": "High-risk. The assistant can run shell commands on your machine. Every command needs your confirmation and runs only inside the allowed folders. Commands cannot be network- or path-sandboxed once they run.",
    "rootsLabel": "Allowed folders",
    "rootsEmpty": "Defaults to your home folder when none are set."
  }
}
```

zh-CN.json 加：

```json
"settings": {
  "agentShell": {
    "title": "允许助手运行本地命令",
    "description": "高危。助手可在你的电脑上执行 shell 命令。每条命令都需你确认，且仅在允许的目录内运行。命令一旦执行无法做细粒度限网/限路径。",
    "rootsLabel": "允许的目录",
    "rootsEmpty": "未设置时默认为你的主目录。"
  }
}
```

> 若 `settings` 命名空间已存在，合并而非覆盖。

- [ ] **Step 4: 运行设置页测试 + 类型检查**

Run: `pnpm test -- src/renderer/src/components/pages/settings-page.test.tsx && pnpm typecheck`
Expected: PASS（若设置页有测试；并补齐其 electronAPI/ settings mock 的新字段，默认 `allowAgentShell: false`、`agentShellRoots: []`）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/pages/settings-page.tsx src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(renderer): add agent local shell settings toggle"
```

---

## Task 8: 全量验证

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS（覆盖率不低于既有阈值）

- [ ] **Step 2: lint + 类型 + 格式**

Run: `pnpm lint && pnpm typecheck && pnpm format:check`
Expected: 全 PASS（format 失败先 `pnpm format`）

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 4: 收尾提交（若 format 有改动）**

```bash
git add -A
git commit -m "chore: format and lint agent local shell work"
```

---

## 验收对照（对 Spec §10）

1. ✅ 开关关 → `run_shell` 不挂载（Task 6 条件装配 + Task 5 guidance 不提 run_shell）。
2. ✅ 开关开 → 可调且每次逐次确认（Task 3 annotations `requiresConfirmation` + 既有审批门）。
3. ✅ 越界 cwd 拒绝、超时/输出护栏（Task 1/2/3）。
4. ✅ 模型自驱路由（Task 5 系统提示准则 + Task 3 工具描述 + 既有 describe_plugin）。
5. ✅ 危险命令不在 CI 真跑（Task 3 全 fake executor；Task 2 仅 echo/exit 安全命令）。
6. ✅ 插件红线不变（shell 仅作 host 内建工具，不进 capabilities 注册表）。

## Self-Review 记录

- **Spec 覆盖**：§4.1 executor→T2；§4.2 tool source→T3；§4.3 allowed-root→T1；§4.4 装配→T6；§5 路由→T5；§6 治理（开关/确认/cwd/护栏/审计）→T3/T4/T6；§7 错误处理→T3；§8 测试→各任务 TDD + T8。无遗漏。
- **类型一致性**：`ShellRunResult`/`ShellExecutor`/`ShellLimits`（T2）被 T3 一致引用；`ShellToolOptions`/`ShellAuditEntry`（T3）自洽；`resolveCwd`/`isWithinAllowedRoot`（T1）签名在 T3 一致；`buildSystemPrompt(base,{shellEnabled})`（T5）与 T6 透传一致；settings 字段名 `allowAgentShell`/`agentShellRoots`（T4）全程一致。
- **Placeholder 扫描**：无 TODO/TBD；index.ts（T6）与设置页（T7）因体量给出「锚点 + 完整新增片段 + 条件说明」，符合在既有大文件中聚焦改动的原则。
- **已知实现注记**：T6 的 `settings` / `logger` 变量名以 index.ts 既有命名为准；T7 Step 1 先确认 renderer settings 是否复用 `UserSettings`，避免重复类型。
