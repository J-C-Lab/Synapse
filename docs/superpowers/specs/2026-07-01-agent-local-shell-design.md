# Agent 本地 Shell（受治理）+ 模型自驱路由 — 设计文档

- 日期：2026-07-01
- 状态：已确认，待实现
- 关联：[capability-governance](2026-06-25-plugin-capability-governance-design.md)、[capability-profile](2026-06-30-plugin-capability-profile-design.md)、[agent-execution-harness](2026-06-12-agent-execution-harness-design.md)

## 1. 背景与问题

用户的插件价值原则：**插件 = agent 单靠 shell + 脚本跑不通的特定能力**（带凭证的云服务、需写回审批、可治理可撤销）。其推论是：**通用、可脚本化的本地任务，应由本地 shell 承担**，而不是硬塞进插件。

当前 agent（[`agent-runtime.ts`](../../../src/main/ai/agent-runtime.ts)）能调用插件工具、内建工具（memory、describe_plugin），但**没有任何通用本地命令执行能力**。仓库刻意把 arbitrary shell 列为 capability 红线（[`capabilities.ts:12`](../../../packages/plugin-manifest/src/capabilities.ts)：shell/raw fs 不可声明、sandbox 够不到）。

本设计在**不破坏插件红线精神**的前提下，给 agent 一个**受治理的本地 shell 工具**，并让**模型自己**判断一个需求该走 shell 还是走现有插件。

## 2. 目标与非目标

### 目标

1. 新增一个 host 内建工具 `run_shell`，执行本地命令，受最高级治理（默认关 + 永远逐次确认 + cwd 范围 + 超时/输出上限 + 审计）。
2. 让模型自驱路由：面对需求自行判断走 `run_shell` 还是现有插件，依据系统提示路由准则 + 工具描述 + 既有 capability 画像（`describe_plugin`）。
3. shell **不进 capability 模型**，走 host 级的 agent 审批门（既有机制），插件红线语义不变（插件仍不能声明 shell）。

### 非目标

- 不把 shell 做成可被插件声明/继承的 capability。
- 不做确定性前置路由器或两阶段“先路由再执行”——路由完全交给模型。
- 不假装能对任意命令做细粒度限网/限路径沙箱（诚实边界，见 §6）。
- 不新增独立的文件读写工具（`run_shell` 已可 cat/写文件，YAGNI）。

## 3. 架构总览

`run_shell` 是 host 内建工具源，与 [`MemoryToolSource`](../../../src/main/ai/memory/memory-tools.ts)、`PluginIntrospectionToolSource` 同构，实现 `ToolHostSource`，挂进 composite host。**仅在用户开启总开关时注册**。

```
agent loop（agent-runtime）→ AiToolRegistry.list() 含 run_shell（开启时）
   → 模型决定调 run_shell / 插件工具 / describe_plugin
   → approve 门（decideApproval：requiresConfirmation → 永远询问；UI 显示命令 + cwd）
   → ShellToolSource.invokeTool → ShellExecutor（cwd 校验 + 超时 + 输出上限）
   → 结构化结果回灌模型 + 审计记录
```

治理通道复用既有 agent 审批系统（[`approval-gate.ts`](../../../src/main/ai/approval-gate.ts) 的 `decideApproval` + [`agent-service.ts`](../../../src/main/ai/agent-service.ts) 的 `approval_request` 往返 / RememberScope），不新建审批 UI。

## 4. 组件与接口

### 4.1 `ShellExecutor`（薄执行端口，可测）

`src/main/ai/shell/shell-executor.ts` —— 唯一触碰 `child_process` 的模块。

```ts
export interface ShellRunRequest {
  command: string
  cwd: string // 已被上层校验落在允许根内的绝对路径
  signal?: AbortSignal
}

export interface ShellRunResult {
  stdout: string
  stderr: string
  exitCode: number | null // null = 被信号/超时终止
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

export interface ShellExecutor {
  run: (request: ShellRunRequest) => Promise<ShellRunResult>
}

/** 默认实现：Windows → PowerShell；其它 → `sh -c`。带超时与输出上限。 */
export function createNodeShellExecutor(limits: ShellLimits): ShellExecutor
```

- 平台选择：`process.platform === "win32"` → `powershell.exe -NoProfile -NonInteractive -Command <cmd>`；否则 `sh -c <cmd>`。
- 超时：到点 kill 进程树，返回 `timedOut: true`、`exitCode: null`。
- 输出上限：stdout/stderr 各自截断到 `maxOutputBytes`，置 `truncated: true`。

```ts
export interface ShellLimits {
  timeoutMs: number // 默认 30_000
  maxOutputBytes: number // 默认 100_000（每个流）
}
```

### 4.2 `ShellToolSource`（ToolHostSource）

`src/main/ai/shell/shell-tool-source.ts`

```ts
export const SHELL_FQ_PREFIX = "shell:"
const SHELL_PLUGIN_ID = "shell:core"

export interface ShellToolOptions {
  executor: ShellExecutor
  /** 允许的工作根（绝对路径数组）。cwd 必须落在其一之内。 */
  allowedRoots: () => string[]
  /** 默认 cwd（命令未指定时用）。须是 allowedRoots 之一或其子目录。 */
  defaultCwd: () => string
  /** 审计每次执行。 */
  audit?: (entry: ShellAuditEntry) => void
}

export interface ShellAuditEntry {
  command: string
  cwd: string
  exitCode: number | null
  durationMs: number
  truncated: boolean
  timedOut: boolean
}

export class ShellToolSource implements ToolHostSource { /* listTools / ownsTool / invokeTool */ }
```

`listTools()` 返回单一描述符：

```ts
{
  fqName: "shell:core/run_shell",
  pluginId: "shell:core",
  manifestTool: {
    name: "run_shell",
    title: "Run local command",
    description:
      "Execute a shell command on the user's local machine for general, scriptable local tasks (file inspection, git, build/test runners, data wrangling). Has side effects and ALWAYS requires user confirmation. Prefer an installed plugin when the task matches a plugin's specialty (cloud services with brokered credentials, governed/approved writeback, revocable capabilities) — call describe_plugin to check. On Windows the shell is PowerShell; on macOS/Linux it is sh.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run in the local shell." },
        cwd: { type: "string", description: "Optional working directory; must be inside an allowed root." },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true, requiresConfirmation: true },
  },
}
```

`invokeTool` 流程：
1. 解析 `command`（非空 string，否则结构化错误）。
2. 解析 `cwd`：缺省用 `defaultCwd()`；给定则规范化为绝对路径并校验 `isWithinAllowedRoot(cwd, allowedRoots())`，越界 → 结构化错误（不执行）。
3. `executor.run({ command, cwd, signal })`。
4. `audit?.(…)`。
5. 返回 `ToolResult`：`content` 为人读文本（exitCode + 截断后的 stdout/stderr），`structured` 为完整 `ShellRunResult`。失败/超时也作为**正常结果**（`isError` 视 exitCode）回灌，不抛。

### 4.3 路径校验

`src/main/ai/shell/allowed-root.ts`：`isWithinAllowedRoot(candidate, roots)` —— 复用项目既有的 path-traversal-safe 思路（参考 [`resolve-static-path.ts`](../../../src/main/protocol/resolve-static-path.ts) 与 fs scope 的 `isRealPathWithinRoot`），`path.resolve` 后逐根判断前缀边界（防 `..` 逃逸、规范分隔符）。

### 4.4 装配（`src/main/index.ts`）

```ts
// 仅当设置开启时构造并加入 sources（排在 fallback 源之前）。
if (settings.allowAgentShell) {
  const shellSource = new ShellToolSource({
    executor: createNodeShellExecutor({ timeoutMs: 30_000, maxOutputBytes: 100_000 }),
    allowedRoots: () => settings.agentShellRoots,
    defaultCwd: () => settings.agentShellDefaultCwd,
    audit: (entry) => shellAudit.record(entry),
  })
  sources.unshift(shellSource) // 拥有 shell: 前缀，需在 fallback 源之前
}
```

开关关闭时 `run_shell` 不出现在 `AiToolRegistry.list()`，模型看不到、也无法调用。

## 5. 路由大脑（模型自驱，无判断层）

不写路由代码。三个支点：

1. **系统提示路由准则**：扩展 [`agent-runtime.ts`](../../../src/main/ai/agent-runtime.ts) 的 `DEFAULT_SYSTEM_PROMPT`（或经 `defaultSystem` 注入），加入一段（英文，供模型读）：
   > When a task matches an installed plugin's specialty — cloud services with brokered credentials, governed/approved writeback, revocable or audited actions, or a specific declared scenario — prefer that plugin; call `describe_plugin` to confirm its capability boundary first. Use `run_shell` only for general, local, scriptable tasks where no suitable plugin exists. Plugins exist for what shell + scripts cannot safely do; shell is the generalist for local scripting.
2. **工具描述**：`run_shell` 描述讲清边界（§4.2）；插件工具描述已带插件级 capability note（capability-profile 工作）。
3. **能力画像**：`describe_plugin` 让模型查"有没有更合适的插件"。

路由是否准确，由系统提示 + 描述 + 画像共同决定，不引入确定性分类层（决策与模型意图一致、无额外脱节）。

## 6. 治理与已知风险

- **总开关默认关**：设置项 `allowAgentShell`（默认 false）。关闭 → 工具不挂载。这是对红线的诚实兑现：shell 是用户**显式**开启的高危能力。
- **永远逐次确认**：`requiresConfirmation: true` 使 `decideApproval` 恒返回 `ask`；每条命令弹确认、显示 `command` + `cwd`；用户可"本次/记住"（RememberScope）。
- **cwd 范围**：`agentShellRoots` 限定可执行目录；越界拒绝。
- **执行护栏**：超时（30s）、输出上限（每流 100KB）、（可选）并发上限。
- **审计**：每次执行记 `ShellAuditEntry`，并入既有审计/治理面板可见路径。
- **诚实边界（写入 spec）**：shell 一旦执行即获进程级权限，**无法**像 `network:https` 那样细粒度限网/限路径。本设计不假装沙箱化任意命令；安全由"总开关 + 永远逐次确认 + cwd 范围 + 审计"四层兜底。该限制需在设置项说明与文档中对用户明示。

## 7. 错误处理

- 未开启：工具不存在（模型不可见）——无需运行时分支。
- 空/非法 `command`：结构化错误结果（`isError: true`），不执行。
- 越界 `cwd`：结构化错误结果，不执行。
- 超时：`timedOut: true`、`exitCode: null`，作为正常结果回灌。
- 执行抛错（spawn 失败等）：捕获 → 结构化错误结果，不使 agent loop 崩溃。

## 8. 测试策略

注入式 `ShellExecutor` 端口让绝大多数测试**不真跑命令**：

- `shell-tool-source.test.ts`（核心）：
  - 成功命令 → stdout/exitCode 正确回灌（fake executor）。
  - 越界 cwd → 错误结果，executor **未被调用**。
  - 缺省 cwd → 用 `defaultCwd`。
  - 超时/截断结果 → 正确映射 `timedOut`/`truncated`，`isError` 由 exitCode 决定。
  - 审计回调被调用且字段正确。
- `allowed-root.test.ts`：`..` 逃逸、符号化分隔符、根前缀边界（`/a/bc` 不算在 `/a/b` 内）。
- `shell-executor.test.ts`（少量真实执行，跨平台安全命令）：在 posix 跑 `echo hi`、Windows 跑 `Write-Output hi`，验证平台分支、超时（用 `sleep`/`Start-Sleep` 的短命令）、输出上限。标注允许在 CI 跑（安全命令），但危险路径一律走 fake。
- `approval-gate` 既有测试已覆盖 `requiresConfirmation → ask`；补一条断言 `run_shell` 的 annotations 触发 ask。
- 装配：`AiToolRegistry.list()` 在开关关/开两态下 `run_shell` 的缺席/在场（用 fake source 或开关位）。
- 系统提示：断言路由准则文本被纳入 agent 的 system（`agent-runtime` 默认 system 或注入）。

## 9. 触点清单

新增：

- `src/main/ai/shell/shell-executor.ts`（+ test）
- `src/main/ai/shell/shell-tool-source.ts`（+ test）
- `src/main/ai/shell/allowed-root.ts`（+ test）
- 设置项类型与默认值（`allowAgentShell` / `agentShellRoots` / `agentShellDefaultCwd`）—— 落在既有 settings 模块
- 渲染端设置 UI 开关 + 允许根选择（既有设置页）

修改：

- `src/main/ai/agent-runtime.ts`（系统提示路由准则）
- `src/main/index.ts`（按开关装配 ShellToolSource）
- settings 读写（main + preload + renderer，如新增持久化字段）
- i18n（设置项文案，中英）

## 10. 验收标准

1. 开关关闭时，agent 工具清单无 `run_shell`，模型无法执行本地命令。
2. 开关开启时，模型可调 `run_shell`，且**每次**执行前弹逐次确认、显示命令与 cwd。
3. 越界 cwd 被拒、不执行；超时/输出过大被正确护栏化并回灌。
4. 模型在“有合适插件”的场景倾向插件、“通用本地脚本”场景才用 shell（由系统提示准则驱动；以提示文本与工具描述落地为准，不做在线行为断言）。
5. 危险命令不在 CI 真跑；执行逻辑经 fake executor 全覆盖。
6. 插件 capability 红线语义不变：插件仍不能声明 shell；shell 仅作 host 内建工具存在。
