# Synapse AI 基座设计方案 (v0.1 draft)

> 目标:在现有插件体系之上构建一个 **AI 基座**,让插件成为 **AI 工具(tool)**——
> 智能体可直接调用,用户也能自行开发。
>
> 已定方向:
>
> - **工具协议:MCP 兼容**(Model Context Protocol)。插件工具自动暴露为 MCP tools,
>   可被 Claude / 其他智能体复用;同时 Synapse 也能作为 MCP client 接入外部 server。
> - **LLM 接入:多厂商 BYOK**,默认 Claude,provider 抽象层支持 OpenAI 等,用户自带 key。

---

## 0. 现状基线(设计的出发点)

| 现有能力                                     | 位置                       | 与 AI 基座的关系                  |
| -------------------------------------------- | -------------------------- | --------------------------------- |
| 插件清单 `synapse.json`                      | `@synapse/plugin-manifest` | 新增 `contributes.tools` 贡献点   |
| 插件运行时(CJS 模块 `{commands, events}`)    | `@synapse/plugin-sdk`      | 新增 `tools` 导出 + `ToolContext` |
| 插件宿主 / 沙箱 / 权限串                     | `src/main/plugins/*`       | 复用沙箱与权限,新增工具调用通道   |
| IPC 四段式(pure → main → preload → renderer) | `src/main/ipc/*`           | 新增 `ai:*` 通道                  |
| 启动器命令(返回 `View`)                      | `commands`                 | **保持不变**;工具是并列的新概念   |

**核心张力**:现有 `command.run(input, ctx)` 入参只有 `{commandId, initialQuery}`、返回 `View`(UI)。
AI 工具需要 **结构化入参(JSON Schema)→ 结构化结果**、且 **无界面、可被程序化调用**。
因此引入独立的 `tools` 贡献点,而非改造 `commands`。

---

## 1. 架构总览

```
┌──────────────────────────────── Renderer (Chromium) ────────────────────────────────┐
│  Chat UI  ·  工具调用卡片/审批  ·  会话历史  ·  设置(provider/key/MCP servers)        │
│                         └── lib/electron.ts (唯一 IPC 出口) ──┐                        │
└──────────────────────────────────────────────────────────────┼───────────────────────┘
                                            ipcMain.handle('ai:*')│ (stream via webContents.send)
┌──────────────────────────────────── Main (Node) ──────────────▼───────────────────────┐
│  AgentRuntime  ── 编排循环(LLM ↔ tool calls)                                          │
│     ├─ ProviderRegistry   (Claude / OpenAI / …  BYOK)                                  │
│     ├─ ToolRegistry       ← PluginToolBridge(插件工具)  + McpClientBridge(外部MCP)   │
│     ├─ ApprovalGate       (人审 / 权限校验 / 注解)                                      │
│     └─ ConversationStore  (会话 + 记忆)                                                 │
│                                                                                        │
│  PluginHost (现有)  ──沙箱执行──►  插件 tools 处理器                                     │
│  McpServer (新, 对外)  ──把插件工具暴露给 Claude Desktop/Code 等外部智能体──            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **AgentRuntime 在主进程**:它持有 key、直接发起 HTTPS、执行工具(都在 Node 侧),
  渲染层只负责对话 UI 与审批。符合现有"renderer 不碰 OS / 不读 process.env"的安全基线。
- **ToolRegistry 是统一抽象**:不论工具来自本地插件还是外部 MCP server,对 LLM 都长一个样。

---

## 2. 核心:插件即工具(`contributes.tools`)

### 2.1 清单扩展(`@synapse/plugin-manifest`)

```ts
// types.ts 新增
export interface ManifestTool {
  /** LLM 可见的工具名,插件内唯一。最终对外名为 `${pluginId}/${name}`(命名空间隔离)。 */
  name: string
  /** LLM 可见的标题(本地化,仅展示用)。 */
  title?: LocalizedString
  /** **给模型读的说明** —— 决定调用质量,要写清用途/边界。非本地化:面向模型用英文为主。 */
  description: string
  /** 入参 JSON Schema(draft 2020-12 子集),= MCP tool.inputSchema。 */
  inputSchema: JsonSchema
  /** 出参 JSON Schema(可选),= MCP tool.outputSchema。 */
  outputSchema?: JsonSchema
  /** MCP 风格注解,驱动审批与 UI。 */
  annotations?: {
    readOnlyHint?: boolean // 只读 → 可免确认
    destructiveHint?: boolean // 破坏性 → 强制人审
    idempotentHint?: boolean
    requiresConfirmation?: boolean // 显式要求人审(覆盖默认)
  }
  /** 复用现有权限串体系(clipboard:read / storage:plugin / system:open …)。 */
  permissions?: string[]
}

export interface PluginManifest {
  // …现有字段…
  contributes: {
    activationEvents?: PluginActivationEvent[]
    commands: ManifestCommand[]
    preferences?: ManifestPreference[]
    tools?: ManifestTool[] // ← 新增
  }
}
```

> JSON Schema 校验直接进入现有 `gen-schema.mjs` 产出的 `synapse-manifest.schema.json`,
> `plugin-cli validate` 会顺带校验工具定义(name 唯一、schema 合法)。

### 2.2 SDK 扩展(`@synapse/plugin-sdk`)

```ts
// tools.ts 新增
export interface ToolContext extends Omit<PluginContext, "locale" | "theme"> {
  /** 本次调用的请求来源:本地智能体 / 外部 MCP / 用户手动。 */
  caller: { kind: "agent" | "mcp" | "user"; conversationId?: string }
  /** 协作式取消(长任务应监听)。 */
  signal: AbortSignal
  /** 进度回传(流式 UI / MCP progress)。 */
  progress?: (pct: number, message?: string) => void
}

/** 工具结果 = MCP content blocks 的子集,host 负责序列化给模型。 */
export type ToolResult = { content: ToolContentBlock[]; isError?: boolean; structured?: unknown }
export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "json"; json: unknown }
  | { type: "image"; path: string; mimeType: string } // 复用沙箱内 plugin-data 路径

export type ToolHandler<I = unknown> = (
  input: I,
  ctx: ToolContext
) => Promise<ToolResult> | ToolResult

export interface PluginModule {
  commands: Record<string, CommandHandler>
  events?: PluginEventHandlers
  tools?: Record<string, ToolHandler> // ← 新增,key = ManifestTool.name
}
```

作者侧体验(`create-synapse-plugin` 模板新增工具样例):

```ts
import type { PluginModule } from "@synapse/plugin-sdk"

const plugin: PluginModule = {
  commands: {
    /* …启动器命令… */
  },
  tools: {
    convertTimestamp: async (input: { value: number; unit?: "s" | "ms" }, ctx) => {
      const ms = input.unit === "s" ? input.value * 1000 : input.value
      return { content: [{ type: "json", json: { iso: new Date(ms).toISOString() } }] }
    },
  },
}
export = plugin
```

### 2.3 桥接:`PluginToolBridge`(`src/main/plugins/`)

- 遍历所有 active 插件的 `contributes.tools`,产出 `RegisteredTool`:
  `{ fqName: "com.x.plugin/convertTimestamp", manifestTool, run(input, ctx) }`。
- `run` → 走 **现有沙箱**(`PluginSandboxRuntime`,新增 `invokeTool`),
  注入受权限约束的 `ToolContext`,带 `AbortSignal` 与超时。
- 权限:工具的 `permissions` ⊆ 插件清单顶层 `permissions`(构建期 + 运行期双校验)。

---

## 3. AgentRuntime(编排循环)

```ts
// src/main/ai/agent-runtime.ts
interface AgentRunOptions {
  conversationId: string
  messages: ChatMessage[]
  toolFilter?: (t: RegisteredTool) => boolean // 用户可在会话级开关工具
  signal: AbortSignal
}
```

循环(标准 tool-use loop,流式):

1. 组装 system + 历史 + 当前可用工具(`ToolRegistry.list()` → provider 各自的 tool schema)。
2. 调 `provider.stream()` → 增量 token 经 IPC 推到渲染层。
3. 模型产生 `tool_use` → 经 **ApprovalGate**(见 §5)→ `ToolRegistry.invoke(fqName, input)`。
4. 工具结果作为 `tool_result` 回灌,回到 1,直至模型给出最终回答或达步数上限。

并发/安全:单会话串行步进;只读工具可并行;每步有超时与 `maxSteps` 上限,防失控循环。

---

## 4. Provider 抽象(多厂商 BYOK)

```ts
// src/main/ai/providers/types.ts
export interface ChatProvider {
  id: "anthropic" | "openai" | string
  models(): Promise<ModelInfo[]>
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent> // text delta / tool_use / usage / done
}
```

- 统一中间表示 `ProviderRequest`(messages + tools(JSON Schema)+ params),
  各 provider 适配器负责翻译到自家工具格式(Anthropic `tools` / OpenAI `tools`)。
- **默认 Claude**(`claude-opus-4-8` 等),适配器内置 **prompt caching**(system + 工具定义打 cache,降本)。
- Key 存储:OS 凭据库(复用 LAN 的 `credential-store` 思路,而非明文落盘);renderer 永不接触 key。
- 工具调用差异(Anthropic vs OpenAI 的 schema/并行调用语义)在适配器层吸收,对 ToolRegistry 透明。

---

## 5. 安全与权限(AI 调用工具的关键)

复用现有 **权限串 + 沙箱**,叠加 **MCP 注解 + 人审**:

| 场景                                       | 策略                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `readOnlyHint` 工具                        | 默认 **自动放行**(可在设置里改为始终询问)                                          |
| `destructiveHint` / `requiresConfirmation` | **强制人审**:渲染层弹工具调用卡片(工具名+入参 diff),用户确认/拒绝/编辑入参后才执行 |
| 权限校验                                   | 工具 `permissions` 必须 ⊆ 插件已授权权限;运行期由沙箱的能力注入兜底                |
| 外部 MCP server                            | 默认全部按 `requiresConfirmation` 处理(不可信),用户可对单个 server 提升信任级别    |
| 失控防护                                   | `maxSteps`、单工具超时、`AbortSignal` 取消、单会话 token/调用预算                  |

ApprovalGate = 纯函数(可单测)+ 主进程绑定(弹审批 IPC)。审批结果可"记住本会话/永久允许"。

---

## 6. MCP 双向集成

### 6.1 Synapse as MCP **server**(对外)

- 主进程内置一个 MCP server(stdio + 可选本地 HTTP/SSE),把 `PluginToolBridge` 的工具
  暴露为标准 MCP tools。→ **Claude Desktop / Claude Code / 其他智能体可直接调用 Synapse 插件**。
- 这正是"插件即 AI 工具,智能体可直接调用"的对外落地点。

### 6.2 Synapse as MCP **client**(对内)

- 用户在设置里添加外部 MCP server(命令/URL + 凭据)。`McpClientBridge` 把其 tools 注册进
  同一个 `ToolRegistry`,Synapse 内置智能体即可使用。
- 命名空间:`mcp:<serverId>/<toolName>`,与插件工具 `<pluginId>/<toolName>` 区隔。

> 因为内部 `ManifestTool` 本就按 MCP 字段(inputSchema/annotations)建模,两个方向几乎是
> 直接映射,无额外转换层。

---

## 7. 上下文与记忆

- **会话存储**:`ConversationStore`(SQLite 或 atomic-json,复用 LAN 的 `atomic-json-store`)。
- **工具结果**作为 `tool_result` 进入上下文;大结果做截断 + 引用(避免爆 context)。
- **记忆(后续)**:插件 `storage` 已是 per-plugin KV;基座层加一个跨会话"长期记忆"工具
  (可被模型读写),以及可选的本地向量检索(RAG)——列入后期里程碑,不进 MVP。

---

## 8. IPC 新增面(遵循四段式)

| 通道                                           | 说明                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `ai:listProviders` / `ai:setProviderKey`       | provider 与 key 管理(key 不回传渲染层)                                 |
| `ai:listTools`                                 | 当前可用工具(插件 + MCP),供会话级开关                                  |
| `ai:chat` (stream)                             | 发起/续写会话;主进程经 `webContents.send('ai:chat:event', …)` 流式回推 |
| `ai:approve`                                   | 工具调用审批结果回传                                                   |
| `ai:mcp:add` / `ai:mcp:remove` / `ai:mcp:list` | 外部 MCP server 管理                                                   |

每个纯逻辑(provider 适配、工具编排、审批判定)放 `src/main/ai/*` 并配单测,与 Electron 解耦。

---

## 9. UI/UX(渲染层)

- 新增 **Chat 页**(与现有 launcher/plugins/lan 并列的 app-shell 路由)。
- 消息流:Markdown 渲染 + **工具调用卡片**(名称、入参、状态:待审批/运行中/成功/失败、可展开结果)。
- 破坏性工具弹 **审批对话框**(复用 shadcn `alert-dialog`)。
- 设置页:provider 选择 + key 录入 + 模型选择 + MCP server 列表 + 工具开关。
- i18n:en / zh-CN 同步。

---

## 10. 分期路线图

| 阶段                                  | 内容                                                                                       | 产出                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **P0 协议层**                         | 清单 `contributes.tools` + SDK `tools/ToolContext/ToolResult` + schema 校验 + CLI validate | 插件能"声明并实现"工具(暂不被调用)           |
| **P1 本地工具桥 + 沙箱执行**          | `PluginToolBridge` + 沙箱 `invokeTool` + 权限校验 + 单测                                   | 工具可在主进程被程序化调用                   |
| **P2 AgentRuntime + Claude provider** | 编排循环 + Anthropic 适配(含 prompt caching)+ key 凭据库                                   | 内置智能体能用插件工具完成任务(CLI/测试驱动) |
| **P3 Chat UI + 审批**                 | Chat 页 + 工具卡片 + ApprovalGate + 流式 IPC                                               | 用户可在 app 内对话并调用工具                |
| **P4 MCP server(对外)**               | 内置 MCP server 暴露插件工具                                                               | Claude Desktop/Code 直接调用 Synapse 插件    |
| **P5 MCP client + 多 provider**       | 接入外部 MCP server + OpenAI 适配                                                          | 工具生态互通、模型可选                       |
| **P6 记忆/RAG(可选)**                 | 长期记忆工具 + 本地向量检索                                                                | 跨会话上下文增强                             |

MVP 建议范围:**P0–P3**(端到端"插件工具被内置智能体调用"闭环),P4 紧随(对外互通是差异化卖点)。

---

## 11. 决策(已定 — 2026-06-03)

1. **会话存储**:**纯 JSON**(复用 LAN 的 `atomic-json-store` 思路,零原生依赖,符合"无 native toolchain")。
2. **MCP server 传输**:**仅 stdio 起步**(P4,直供 Claude Code/Desktop);本地 HTTP/SSE 推迟到 P5 生态扩张时。
3. **工具命名**:**`<pluginId>/<name>`,不引入别名表**。模型表现不足时优先改进 system prompt 说明;Anthropic/OpenAI 工具名字符集限制由 **provider 适配器层**(P2)做 sanitize + 反查映射吸收。
4. **预算/用量**:**P3 出会话级 token 用量展示**(读 `provider.usage`,零额外开发);**预算上限推迟到 P5**。
5. **`commands` 桥接**:**默认不自动桥接**,仅 `tools` 显式声明;opt-in 适配器列为后期可选,不进 MVP。

### P0 完成状态(本次)

`contributes.tools` 协议层已落地,纯类型 / 校验层,零运行时:

- `@synapse/plugin-manifest`:`ManifestTool` / `ToolAnnotations` / `JsonSchema` 类型 + zod schema(工具名唯一性、`permissions ⊆ 插件权限`、inputSchema 必须为 object 型 JSON Schema)+ 重新生成 `synapse-manifest.schema.json`。
- `@synapse/plugin-sdk`:`ToolContext` / `ToolResult` / `ToolContentBlock` / `ToolHandler` / `ToolCaller` 导出;`PluginModule.tools?`。
- `plugin-cli validate`:输出工具列表(命名空间名 `<pluginId>/<name>`)。
- `create-synapse-plugin` 模板:新增只读 `greet` 工具样例(清单 + 实现)。
- 测试:6 条工具校验用例;typecheck / lint / 271 测试全绿。

> 下一步 **P1**:`PluginToolBridge` + 沙箱 `invokeTool` + 运行期权限校验(工具可在主进程被程序化调用)。
