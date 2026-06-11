# Synapse Agent 本地执行 Harness —— 方案书

> 创建于 2026-06-12。仓库: `sunzrnobug/Synapse`。
> 参考: `shareAI-lab/learn-claude-code` 的 harness 工程拆解方式。
> 范围:让 Synapse 内置 Agent 具备类似 Claude Code / Codex 的本地执行能力:读写文件、搜索项目、运行命令、看输出、修改后验证。
> 非目标:本方案不覆盖 GIS 专项能力、不扩展插件沙箱、不实现远程代码执行平台、不替代 MCP。

## 1. 核心判断

Synapse 现在已经有 Agent loop、工具注册、插件 tools、MCP tools、审批流和记忆 tools。缺的是一个**内置本地执行环境**。

参考 `learn-claude-code` 的表述:

```text
Harness = Tools + Knowledge + Observation + Action Interfaces + Permissions
```

套到 Synapse:

- **Tools**:文件、搜索、patch、shell、进程。
- **Knowledge**:仓库说明、AGENTS.md、插件 AGENT.md、docs/specs、历史会话。
- **Observation**:文件内容、命令输出、git diff、测试结果、执行日志。
- **Action Interfaces**:文件写入、patch、命令执行、进程管理。
- **Permissions**:工作区边界、命令风险分级、用户审批、审计记录。

因此目标不是“给模型一个裸 shell”,而是给模型一个可审计、可授权、可恢复的本地工作空间。

## 2. 当前状态

### 已具备

- `AgentRuntime` 已有标准工具循环:模型输出 `tool_use` → 执行 tool → 结果回填 → 继续下一轮。
- `AiToolRegistry` 已把工具描述转换为模型可见 schema,并处理工具名安全映射。
- `CompositeToolHost` 已支持多个工具源并列接入。
- 插件 tools 和外部 MCP tools 已能作为工具源。
- `ApprovalGate` 已支持 `readOnlyHint`、`requiresConfirmation`、`destructiveHint`。
- `ApprovalStore` 已支持“永久允许”工具。
- 外部 MCP stdio client 已能启动外部进程,但它面向 MCP server,不是 Agent 的原生 shell。

### 缺口

- 没有内置 `read_file` / `write_file` / `apply_patch` / `run_command`。
- 没有 workspace root 授权与路径策略。
- 没有命令风险分级。
- 没有命令执行日志、输出截断、后台任务、取消/kill 体系。
- 没有可用于代码工作的 UI 展示:命令、cwd、stdout/stderr、diff、审批理由。

## 3. 设计目标

1. Agent 可以在授权工作区内读文件、搜文件、改文件、运行命令。
2. Agent loop 不为执行能力膨胀;新增能力以工具源接入。
3. 读操作尽量低摩擦;写操作和命令执行有清晰审批。
4. 所有文件路径默认限制在 workspace root 内。
5. 命令输出可被模型消费,同时可被用户审计。
6. 长命令可取消,失败可回溯,修改可通过 git diff 观察。
7. 保留 MCP 作为外部能力扩展路径;内置 execution host 负责本机通用开发能力。

## 4. 非目标

- 不在插件 sandbox 中开放 `fs` / `child_process`。
- 不默认允许访问整台电脑。
- 不默认允许 `sudo`、系统盘删除、磁盘格式化、关机、凭据导出等高危行为。
- 不在 MVP 中实现 subagent、worktree 并行、长期后台任务调度。
- 不把 Python/GDAL/Node 作为特例;它们都通过通用命令能力执行。

## 5. 总体架构

新增内置工具源:

```text
AgentRuntime
  -> AiToolRegistry
    -> CompositeToolHost
      -> PluginHost tools
      -> McpClientManager tools
      -> MemoryToolSource
      -> ExecutionToolHostSource   <-- 新增
```

推荐目录:

```text
src/main/ai/execution/
  execution-tool-host.ts
  command-runner.ts
  file-tools.ts
  patch-tools.ts
  workspace-policy.ts
  command-policy.ts
  execution-log-store.ts
  output-store.ts
  types.ts
```

`ExecutionToolHostSource` 实现现有 `ToolHostSource`:

- `listTools()`:返回内置 execution tools 描述。
- `ownsTool(fqName)`:识别 `execution:<workspaceId>/<tool>` 或 `execution/<tool>` 命名空间。
- `invokeTool(fqName, input, options)`:执行对应工具。

## 6. 工具设计

### 6.1 MVP 工具集

| 工具 | 用途 | 默认审批 |
| --- | --- | --- |
| `list_files` | 列目录,支持深度/隐藏文件 | read-only 自动 |
| `read_file` | 读取文本文件,支持行范围/大小上限 | read-only 自动 |
| `search_files` | 类似 `rg`,按 pattern 搜索 | read-only 自动 |
| `apply_patch` | 应用 unified patch | 必须确认 |
| `run_command` | 执行 shell 命令 | 默认确认;只读命令可配置自动 |

### 6.2 P1 工具集

| 工具 | 用途 | 默认审批 |
| --- | --- | --- |
| `write_file` | 写入或新建文件 | 必须确认 |
| `move_file` | 移动/重命名 | 必须确认 |
| `delete_file` | 删除文件 | destructive,强制确认 |
| `git_diff` | 查看 diff | read-only 自动 |
| `git_status` | 查看状态 | read-only 自动 |
| `list_processes` | 查看相关进程 | read-only 自动 |
| `kill_process` | 终止进程 | destructive,强制确认 |

### 6.3 工具 schema 示例

`run_command`:

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string" },
    "cwd": { "type": "string" },
    "timeoutMs": { "type": "number" },
    "reason": { "type": "string" }
  },
  "required": ["command"]
}
```

`read_file`:

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "startLine": { "type": "number" },
    "maxLines": { "type": "number" }
  },
  "required": ["path"]
}
```

## 7. Workspace 模型

### 7.1 Workspace Root

每个 Agent 会话绑定一个或多个 workspace root:

- 默认使用当前打开项目目录。
- 用户可在 UI 中添加/移除授权目录。
- 文件工具和命令 `cwd` 必须在授权目录内。
- 默认不允许访问用户 HOME、桌面、系统目录,除非用户显式添加。

### 7.2 路径策略

`workspace-policy.ts` 负责:

1. 规范化路径。
2. 解析相对路径到 workspace root。
3. 禁止 `..` 逃逸。
4. 禁止绝对路径访问未授权目录。
5. 检查 symlink 最终路径仍在 root 内。
6. 区分 text/binary 文件。
7. 设置单次读取大小上限。

路径判断必须使用 `fs.realpath` 后的真实路径,不能只靠字符串前缀。

## 8. 命令执行模型

### 8.1 Shell 选择

Windows:

- 默认 PowerShell。
- 可选 `cmd.exe`。

macOS/Linux:

- 默认用户 shell 或 `/bin/bash`。

配置项:

- 默认 shell。
- 默认 timeout。
- 最大输出大小。
- 环境变量白名单/覆盖。
- 是否允许继承完整用户环境。

### 8.2 Runner

`command-runner.ts`:

- 使用 `child_process.spawn`。
- 支持 cwd。
- 支持 env。
- 收集 stdout/stderr。
- 支持 timeout。
- 支持 `AbortSignal` 取消。
- Windows 需要处理进程树终止。
- 返回 `exitCode`、`signal`、`durationMs`、`stdoutPreview`、`stderrPreview`、`outputFile?`。

### 8.3 输出策略

- 小输出直接返回给模型。
- 大输出截断为 preview,完整输出写入 `userData/ai/execution-output/`。
- stderr 单独保留。
- 模型结果中包含“输出已截断”的提示和日志路径。

## 9. 权限与风险管线

参考 `learn-claude-code` 的 permission 章节,工具执行前统一走管线:

```text
schema validate
  -> tool validateInput
  -> workspace policy
  -> command policy
  -> hooks
  -> approval gate
  -> execute
  -> log
```

### 9.1 决策类型

沿用/扩展现有 `ApprovalDecision`:

- `allow`:直接运行。
- `ask`:弹出审批。
- `deny`:硬拒绝。

### 9.2 命令风险分级

`command-policy.ts` 输出:

| 等级 | 示例 | 行为 |
| --- | --- | --- |
| read-only | `git status`, `rg`, `ls`, `pnpm test` | 可配置自动运行 |
| write | `pnpm install`, `npm run build`, `apply_patch` | 默认 ask |
| destructive | `rm`, `del`, `git reset --hard`, `kill` | 强制 ask |
| forbidden | `format disk`, `shutdown`, `sudo rm -rf /`, 凭据导出 | deny |

注意:命令分类不是安全证明,只是用户体验优化。真正安全边界仍是 workspace policy 和硬拒绝。

### 9.3 审批 UI 信息

审批弹窗必须展示:

- 工具名。
- 命令或 patch 摘要。
- cwd。
- 风险原因。
- 将访问/修改的路径。
- 允许范围:一次 / 本对话 / 永久。

对 destructive/forbidden:

- destructive 不建议提供“永久允许”。
- forbidden 不进入审批,直接拒绝。

## 10. Hooks

新增 execution hooks,保持 Agent loop 干净:

- `beforeToolUse`
- `afterToolUse`
- `onToolError`
- `beforeCommand`
- `afterCommand`
- `beforeFileWrite`

初期先做内部 hook pipeline,不暴露给插件。后续可以让企业策略、项目策略、插件扩展接入。

## 11. 配置来源

参考 Claude Code 的多层权限来源,但 MVP 简化为 4 层:

1. **Built-in policy**:硬编码高危 deny。
2. **User settings**:用户全局允许/拒绝规则。
3. **Workspace settings**:`.synapse/settings.json`。
4. **Session approvals**:本次会话临时授权。

后续可扩:

- enterprise policy。
- CLI flags。
- project local settings。

## 12. UI/UX

### 12.1 聊天流展示

每次工具调用展示为可折叠卡片:

- 标题:`run_command: pnpm test`
- cwd。
- 状态:waiting approval / running / succeeded / failed / cancelled。
- stdout/stderr preview。
- exit code。
- duration。

### 12.2 审批交互

按钮:

- Deny。
- Allow once。
- Allow for conversation。
- Always allow(仅低风险)。

### 12.3 工作区设置

新增设置页:

- 当前授权 workspace。
- 默认 shell。
- 命令 timeout。
- 输出截断上限。
- 已永久允许工具/规则。
- 执行历史。

## 13. 审计与恢复

`execution-log-store.ts` 记录:

- conversationId。
- toolName。
- input。
- cwd。
- normalized paths。
- decision。
- start/end time。
- exitCode。
- stdout/stderr preview。
- output file path。

写入型工具额外记录:

- 修改前摘要。
- 修改后摘要。
- patch。
- 是否创建备份。

MVP 不做自动 rollback,但必须让用户能看到 diff 并用 git 恢复。

## 14. 与插件/MCP的关系

### 插件

插件仍运行在 vm sandbox 内,不因 execution host 获得 `fs` / `child_process`。

原因:

- 插件是第三方分发单位。
- 一旦开放本机执行,插件市场安全模型会显著复杂化。
- 本地执行能力属于用户授权给 Agent 的核心 harness,不是插件默认能力。

### MCP

MCP 继续用于外部能力扩展:

- 数据库。
- 浏览器。
- 专业工具服务。
- 第三方平台 API。

Execution host 用于本机通用开发能力:

- 读写工作区。
- 运行测试。
- 运行 Python/Node/GDAL/任意 CLI。

两者共用审批和工具注册系统。

## 15. 实施阶段

### Phase 1 — 只读工作区观察

新增:

- `ExecutionToolHostSource`
- `workspace-policy`
- `list_files`
- `read_file`
- `search_files`

验收:

- Agent 能读取授权工作区文件。
- 路径逃逸被拒绝。
- 大文件读取有上限。
- 只读工具可自动运行。

### Phase 2 — 命令执行

新增:

- `command-runner`
- `run_command`
- timeout/cancel/stdout/stderr。
- 命令执行卡片。

验收:

- Agent 能运行 `pnpm test`、`git status`、`python --version`。
- 用户可拒绝命令。
- 超时命令会被终止。
- 输出过长会截断并落盘。

### Phase 3 — 文件修改

新增:

- `apply_patch`
- `write_file`
- 写操作审批。
- diff preview。

验收:

- Agent 能修改代码文件。
- 修改前显示 patch。
- 工作区外写入被拒绝。
- 写入后可运行测试验证。

### Phase 4 — 权限策略与持久化

新增:

- command risk classifier。
- user/workspace/session 规则。
- 永久允许管理 UI。
- forbidden deny list。

验收:

- `git status` 可自动运行。
- `rm`、`git reset --hard` 强制确认。
- 系统级危险命令直接拒绝。
- 用户可撤销永久允许。

### Phase 5 — 开发体验完善

新增:

- 执行历史。
- 输出文件查看。
- 进程列表/终止。
- workspace 设置页。
- 项目 `.synapse/settings.json`。

验收:

- 用户能审计过去的所有执行。
- 长任务可取消。
- 项目可声明推荐权限策略。

## 16. 测试策略

### 单元测试

- `workspace-policy.test.ts`
  - 相对路径。
  - 绝对路径。
  - `..`。
  - symlink 逃逸。
  - Windows 盘符。

- `command-policy.test.ts`
  - read-only 分类。
  - destructive 分类。
  - forbidden 分类。
  - PowerShell/cmd/bash 差异。

- `command-runner.test.ts`
  - exit 0。
  - exit 非 0。
  - timeout。
  - cancel。
  - stdout/stderr 截断。

- `execution-tool-host.test.ts`
  - tools list。
  - invoke route。
  - approval annotations。
  - cwd 越界拒绝。

### 集成测试

- Agent 调 `read_file` 后回答。
- Agent 调 `run_command` 后使用输出继续下一轮。
- 拒绝审批后工具结果为 error。
- patch + test 闭环。

## 17. 关键风险

1. **安全风险**:裸 shell 权限过大。
   - 缓解:workspace root、硬拒绝、审批、审计。

2. **命令分类误判**。
   - 缓解:分类只影响是否自动运行,不作为唯一安全边界。

3. **输出过大拖垮上下文**。
   - 缓解:preview + output file。

4. **Windows 进程树难杀**。
   - 缓解:封装 runner,单独测试 PowerShell/cmd 行为。

5. **模型过度使用 shell**。
   - 缓解:提供专用 file/search/patch tools,降低 shell 使用频率。

## 18. 推荐 MVP

第一版只做 5 个工具:

```text
list_files
read_file
search_files
apply_patch
run_command
```

这 5 个足以让 Agent 完成:

```text
观察项目 -> 定位文件 -> 修改代码 -> 跑测试 -> 根据失败继续修复
```

这也是最接近 Claude Code / Codex 的最小闭环。

## 19. 开放问题

1. 是否需要每个聊天会话都显式选择 workspace,还是默认使用当前仓库?
2. `run_command` 的默认 shell 在 Windows 上用 PowerShell 还是 cmd?
3. `pnpm install`、`npm publish` 这类网络/发布命令是否应单独标记高风险?
4. 是否允许 Agent 修改 `.env`、密钥文件、系统配置文件?
5. 是否需要项目级 `.synapse/settings.json` 进入版本库?
6. 是否要支持“计划模式”:Agent 先列出将执行的命令,用户批准后批量执行?

## 20. 结论

Synapse 已有工具注册和审批骨架,不需要重写 Agent loop。只要新增一个内置 `ExecutionToolHostSource`,并把文件工具、命令 runner、workspace policy、command policy 接入现有 `CompositeToolHost`,就能获得类似 Claude Code / Codex 的本地执行能力。

第一阶段应保持克制:先做可审计的工作区文件观察和命令执行,再逐步加入写入、patch、进程管理和更细粒度权限。
