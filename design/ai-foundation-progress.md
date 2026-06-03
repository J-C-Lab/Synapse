# Synapse AI 基座 —— 进度存档 & 续作指南

> 本文件是**跨会话工作交接单**。在新窗口开工前先读这份 + [ai-foundation.md](ai-foundation.md)(完整设计)。
> 最近更新:2026-06-03。仓库:`sunzrnobug/Synapse`(private),单 `main` 分支。

---

## 总览:路线图与当前位置

| 阶段                                  | 内容                                                                                       | 状态                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| **P0 协议层**                         | 清单 `contributes.tools` + SDK `tools/ToolContext/ToolResult` + schema 校验 + CLI validate | ✅ 已完成(提交 `61d9cf1`) |
| **P1 本地工具桥 + 沙箱执行**          | `PluginToolBridge` + 沙箱 `invokeTool` + 权限校验 + 单测                                   | ✅ 已完成                 |
| **P2 AgentRuntime + Claude provider** | 编排循环 + Anthropic 适配(prompt caching)+ key 凭据库                                      | ✅ 已完成                 |
| **P3 Chat UI + 审批**                 | Chat 页 + 工具卡片 + ApprovalGate + 流式 IPC                                               | ✅ 已完成                 |
| **P4 MCP server(对外)**               | 内置 MCP server 暴露插件工具给 Claude Desktop/Code                                         | ⬜ **下一步**             |
| **P5 MCP client + 多 provider**       | 接入外部 MCP server + OpenAI 适配                                                          | ⬜                        |
| **P6 记忆/RAG(可选)**                 | 长期记忆工具 + 本地向量检索                                                                | ⬜                        |

MVP 目标范围:**P0–P3** 端到端「插件工具被内置智能体调用」闭环,P4 紧随。

---

## 已定决策(design/ai-foundation.md §11,2026-06-03 拍板)

1. **会话存储**:纯 JSON(复用 LAN 的 `atomic-json-store` 思路,零原生依赖)。
2. **MCP server 传输**:仅 stdio 起步(P4);HTTP/SSE 推迟到 P5。
3. **工具命名**:`<pluginId>/<name>`,不引入别名表。Anthropic/OpenAI 工具名字符集限制由 **provider 适配器层(P2)** sanitize + 反查映射吸收。
4. **预算/用量**:P3 出会话级 token 用量展示(读 `provider.usage`);预算上限推迟到 P5。
5. **`commands` 桥接**:默认不自动桥接,仅 `tools` 显式声明。

---

## P0 成果(已落地)

协议层,纯类型 / 校验,零运行时:

- **`@synapse/plugin-manifest`**(`packages/plugin-manifest/`)
  - `src/types.ts`:`ManifestTool`、`ToolAnnotations`、`JsonSchema`;`contributes.tools?`
  - `src/schema.ts`:zod `toolSchema` + 三条校验 —— 工具名唯一、`tool.permissions ⊆ 插件 permissions`、`inputSchema` 必须 `type: "object"`
  - `schema/synapse-manifest.schema.json`:由 `scripts/gen-schema.mjs` 经 `z.toJSONSchema` 自动生成(**改了 zod 就要 `pnpm -F @synapse/plugin-manifest build` 重新生成**)
- **`@synapse/plugin-sdk`**(`packages/plugin-sdk/`)
  - `src/tools.ts`:`ToolContext`(`Omit<PluginContext,"locale"|"theme">` + `caller`/`signal`/`progress`)、`ToolResult`、`ToolContentBlock`、`ToolHandler`、`ToolCaller`
  - `src/commands.ts`:`PluginModule.tools?: Record<string, ToolHandler>`
- **`plugin-cli`**:`validate` 输出命名空间工具名
- **`create-synapse-plugin`**:模板含只读 `greet` 工具样例(清单 + 实现)

---

## P1 成果(已落地)

**插件工具可在主进程被程序化调用**,走现有沙箱、复用权限、带取消/超时。全部在 `src/main/plugins/`:

| 文件                            | 作用                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-input-validation.ts` (新) | 零依赖 JSON Schema 子集校验器(type/required/properties/items/enum,递归)。执行前拦截非法入参                                                                      |
| `plugin-tool-bridge.ts` (新)    | `PluginToolBridge`:`list()`/`get()`/`invoke()`,入参校验后委派;`ToolInputValidationError` 带逐字段问题                                                            |
| `types.ts`                      | `ToolInvocationOptions`、`PluginToolInvokeRequest`、`RegisteredTool(Descriptor)`、`toolFqName()`;`PluginSandboxRuntime.invokeTool`                               |
| `plugin-bridge.ts`              | 抽出共享 `createCapabilities`;新增 `createToolContext`(去 locale/theme,加 caller/signal/progress,**按 tool.permissions 最小权限收窄**)                           |
| `plugin-sandbox.ts`             | `invokeTool` + 工具 hook 脚本 + `AbortSignal`/超时联动(默认 30s);handler 抛错→`isError` 结果,超时/取消/权限错误→抛出;模块 `tools` 形状校验;跨 realm 错误消息提取 |
| `plugin-registry.ts`            | `toolIndex`、`listTools`、`invokeTool`、`validateManifestTools`。**工具出错不拖垮整个插件**(与 command 的 crash 语义不同)                                        |
| `plugin-host.ts`                | 实例化 `tools` 桥;暴露 `host.listTools()` / `host.invokeTool(fqName, input, options)`                                                                            |

**关键不变量(P2 必须遵守)**

- 调用入口:`host.invokeTool(fqName, input, { caller, signal?, progress? })` → 返回 `ToolResult`。
- 分层:`PluginToolBridge`(校验)→ `PluginRegistry`(编排/索引/active 校验)→ `PluginSandbox`(vm 执行)。
- `ToolResult.content` 是给模型看的内容块;`structured` 是可选机器可读载荷(将来按 `outputSchema` 校验)。
- 工具 handler 抛错 = `{ isError: true, content:[{type:"text",text}] }`,**不**抛异常;超时/取消/权限拒绝 = 抛异常,由 P2 编排层决定如何处理。
- 跨 vm realm:`instanceof Error` 不可靠,已用 duck-typing 取 `.message`。新代码注意同类陷阱。

---

## 质量基线(当前)

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` **331 passed**(P0 +6,P1 +23,P2 +22,P3 +15)
- commitlint 生效:**subject 必须小写开头**(用 `feat(ai): add ...` 不要 `feat(ai): P1 ...`)。
- husky/lint-staged 在提交时跑 eslint --fix + prettier,可能改动暂存文件(正常)。

---

## P2 成果(已落地)

**内置智能体能用插件工具完成任务**(主进程 + 测试驱动,UI 是 P3)。全部在 `src/main/ai/`,与 Electron 解耦、纯逻辑配单测。依赖新增 `@anthropic-ai/sdk`(纯 JS,由 `externalizeDepsPlugin` 外置)。

| 文件                              | 作用                                                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/types.ts`              | provider 中立 IR:`ChatMessage`(text/tool_use/tool_result 块)、`ChatProvider.stream()`、`ProviderRequest`、`ProviderStreamEvent`、`TokenUsage`(含 cache 命中字段)、`addUsage`/`emptyUsage`                                                                         |
| `providers/anthropic-provider.ts` | Anthropic 适配:`stream()` 转发 text delta + 终结 message;**prompt caching**(system 块打 1 个 breakpoint 同时缓存 tools+system;最后一条消息打 breakpoint 缓存会话前缀);IR↔Messages API 互转;`AnthropicMessagesClient` 端口便于注入测试。默认模型 `claude-opus-4-8` |
| `tool-registry.ts`                | `AiToolRegistry`:`host.listTools()` → provider schema,**工具名 sanitize**(`com.x/foo`→`com_x_foo`,charset `^[\w-]{1,128}$`,冲突加 `_2`)+ sanitized↔fqName 反查表;`invoke()` 路由回 `host.invokeTool`;`renderToolResultText()` 把 ToolResult 扁平成文本            |
| `agent-runtime.ts`                | `AgentRuntime.run()`:tool-use 循环(流式→tool_use→执行→tool_result 回灌→重复);`maxSteps`/`maxTokens` 防失控;`AbortSignal` 取消;`approve?` 钩子(P2 默认放行,**P3 ApprovalGate 接这里**);`onText`/`onEvent` 回调供 UI                                                |
| `credential-store.ts`             | `AiCredentialStore`:provider key 经 `SecretProtector`(safeStorage)加密落盘,**仅主进程**,renderer 永不接触;`get/set/has/delete/list`                                                                                                                               |
| `conversation-store.ts`           | `ConversationStore`:纯 JSON,每会话一文件,复用 LAN `atomic-json-store`;`get/save/list/delete`;`safeId` 拒绝路径穿越                                                                                                                                                |

**关键不变量(P3 必须遵守)**

- AgentRuntime 入口:`runtime.run({ conversationId, messages, system?, signal?, onText?, onEvent?, approve? })` → `{ messages, stopReason, usage }`。
- 审批:P3 的 ApprovalGate 实现 `approve(request) => boolean`,按工具 `annotations`(`readOnlyHint` 自动放行 / `destructiveHint`/`requiresConfirmation` 强制人审)决定。注意 `approve` 当前只收到 `{ toolName(sanitized), input }`——P3 若需 annotations,扩展 `AgentRunOptions`/`ApprovalRequest` 把 descriptor 带进来。
- 流式:`onText` 是增量文本,`onEvent` 是工具生命周期(`tool_call`/`tool_result`);P3 经 `webContents.send('ai:chat:event', …)` 推到渲染层。
- IR `ChatMessage` 是 provider 中立的;assistant 轮含 text+tool_use,user 轮含 text/tool_result。P2 未启用 extended thinking(保持简单)。
- 装配:`new AiToolRegistry(pluginHost)`(host 满足 `ToolHostPort`)+ `new AnthropicProvider({ apiKey })` + `new AgentRuntime({ provider, tools })`。

---

## P3 成果(已落地)

**用户可在 app 内对话并调用工具**。P2 的主进程能力已接到渲染层。

| 文件                                                   | 作用                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ai/approval-gate.ts` (新)                    | `decideApproval(annotations, settings)` 纯函数:`readOnlyHint`→自动放行;`destructiveHint`/`requiresConfirmation`/未标注→ask;`alwaysAsk` 覆盖                                                                                                                           |
| `src/main/ai/agent-service.ts` (新)                    | `AgentService`:装配 credentials+tools+runtime+store+gate。`chat()` 跑一轮并经 `sendEvent` 流式回推;审批往返(`approve` 钩子→发 `approval_request`→`resolveApproval`);`cancel`、记忆放行(本会话/永久);会话持久化(标题取首条用户消息);无 key 抛 `AgentMissingKeyError`   |
| `src/main/ai/tool-registry.ts`                         | 新增 `describe(safeName)` 供审批查 annotations(map 改存 descriptor)                                                                                                                                                                                                   |
| `src/main/ipc/ai.ts` (新)                              | `registerAiIpc` + `AiIpcService`:`ai:status`/`set-key`/`delete-key`/`list-tools`/`list-conversations`/`get-conversation`/`chat`/`cancel`/`approve`;trusted-sender 守卫;`coerceChat`/`coerceApprove` 校验。流式事件经 main 的 `broadcastAiChatEvent` → `ai:chat:event` |
| `src/main/index.ts`                                    | `createAgentService()` 装配(复用 `osSecretProtector()`);`registerAiIpc`;`broadcastAiChatEvent`                                                                                                                                                                        |
| `src/preload/index.{ts,d.ts}`                          | ai 方法 + `onAiChatEvent` 订阅 + `Synapse Ai*` 全局类型                                                                                                                                                                                                               |
| `src/renderer/src/lib/electron.ts`                     | ai 包装函数(唯一 IPC 出口);key 永不回渲染层                                                                                                                                                                                                                           |
| `src/renderer/src/components/pages/chat-page.tsx` (新) | Chat 页:无 key 时录入 key;消息流;**工具卡片**(名称/状态 running/success/error);破坏性工具弹 Dialog 审批(允许一次/始终允许/拒绝);会话级 token 用量展示;Enter 发送                                                                                                      |
| `app-shell.tsx` + i18n                                 | 侧栏「智能助手」入口 + `chat.*` / `nav.assistant`(en/zh-CN)                                                                                                                                                                                                           |

**关键不变量(P4+ 注意)**

- 流式协议:`ai:chat` invoke 触发一轮并在结束时 resolve;text/tool/approval/done/error 事件经 `ai:chat:event` 广播(带 `conversationId`,渲染层按 id 过滤)。
- key 只在主进程:`ai:status` 只回 `{hasKey, model}`;`get` 仅 AgentService 内部用。
- 审批默认:只读自动放行,其余 ask;记忆「always」存进程内存(非持久——重启重置,P5 可考虑持久化)。
- 当前单会话/单轮 UI(每次开页 `crypto.randomUUID()` 新会话);会话列表 IPC 已就绪但 UI 未做侧栏历史。

### P3 未尽（可选增强，非阻塞）

- 会话历史侧栏(IPC `ai:list-conversations`/`ai:get-conversation` 已就绪,UI 未接)。
- 设置页的 provider/模型/工具开关(目前 key 录入在 Chat 空状态;模型固定默认)。
- Markdown 渲染(目前纯文本 `whitespace-pre-wrap`)。
- 真实 key 的 app 内端到端冒烟(需手动:配置 key → 让模型调用 hello-world 的 `greet`)。

---

## 下一步:P4 — 内置 MCP server(对外)

目标:**把插件工具经 MCP 暴露给 Claude Desktop/Code 等外部智能体**(decision §11.2:仅 stdio 起步)。

### 落地要点

1. **MCP server(stdio)**:主进程内置一个 MCP server,把 `pluginHost.listTools()`/`invokeTool()` 暴露为标准 MCP tools。建议用官方 `@modelcontextprotocol/sdk`(纯 JS)。工具的 inputSchema/annotations 已按 MCP 字段建模,几乎直接映射。
2. **传输**:stdio。需要一个可执行入口(单独的 Node 进程 / Electron 子命令),让外部客户端用命令行拉起。考虑 `electron … --mcp-stdio` 或独立 bin。
3. **复用 P1 桥**:工具执行仍走 `PluginToolBridge`(校验+沙箱+权限),caller 标 `{kind:"mcp"}`;外部 MCP 默认按 `requiresConfirmation` 处理(design §5)——但 stdio server 无 UI,需决定:拒绝破坏性工具 / 配置允许清单 / 仅暴露 readOnly。建议先只暴露 readOnly + 非破坏工具,破坏性需显式 opt-in。
4. **复用 sanitize**:工具名同样要 sanitize(MCP 工具名约束)。可抽出 `tool-registry.ts` 的 sanitize 供 server 复用。

### P4 验收

- MCP server 纯逻辑单测:list/call 往返,readOnly 放行、破坏性按策略处理。
- 手动:在 Claude Desktop 配置该 stdio server,确认能列出并调用 Synapse 插件工具(如 `greet`)。

---

## 常用命令速查

```bash
pnpm typecheck            # 全量类型检查(SDK/node/web)
pnpm test                 # vitest 一次过
pnpm lint                 # eslint(subject 小写!)
pnpm -F @synapse/plugin-manifest build   # 改了 zod schema 后重新生成 JSON Schema

# 提交(subject 必须小写开头,否则 commitlint 拒绝)
# 推送已配置 origin=https://github.com/sunzrnobug/Synapse.git, main 跟踪 origin/main
```

## 提交历史(AI 基座相关)

- `61d9cf1` feat(ai): add contributes.tools manifest/SDK contract and validation —— P0
- `6513b86` docs: add AI foundation design —— 设计文档
- P1 提交:见 `git log`(本次)
