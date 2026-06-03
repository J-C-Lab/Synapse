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
| **P3 Chat UI + 审批**                 | Chat 页 + 工具卡片 + ApprovalGate + 流式 IPC                                               | ⬜ **下一步**             |
| **P4 MCP server(对外)**               | 内置 MCP server 暴露插件工具给 Claude Desktop/Code                                         | ⬜                        |
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

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` **316 passed**(P0 +6,P1 +23,P2 +22)
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

## 下一步:P3 — Chat UI + 审批 + 流式 IPC

目标:**用户在 app 内对话并调用工具**。把 P2 的主进程能力接到渲染层。

### 落地要点

1. **AgentService(主进程装配层)**:把 `AiCredentialStore` + `AnthropicProvider` + `AiToolRegistry`(包 `pluginHost`)+ `AgentRuntime` + `ConversationStore` 组装起来,提供 `chat(conversationId, userText, { signal, onText, onEvent, approve })`。从凭据库取 key 构造 provider;无 key 时报可恢复错误。
2. **ApprovalGate**(纯函数 + 主进程绑定):依据工具 `annotations` 决定自动放行 / 弹审批。需要把 `RegisteredToolDescriptor` 传进 `approve`(见上「关键不变量」——扩展 `ApprovalRequest`)。审批结果可「记住本会话/永久允许」。
3. **IPC(四段式,design §8)**:`ai:listProviders`/`ai:setProviderKey`(key 不回传)、`ai:listTools`、`ai:chat`(流式:主进程 `webContents.send('ai:chat:event', …)` 回推 text/tool 事件)、`ai:approve`(审批回传)、`ai:listConversations`/`ai:getConversation`。纯逻辑放 `src/main/ipc/ai.ts` 配单测。
4. **Chat 页(渲染层)**:与 launcher/plugins/lan 并列的路由;消息流 Markdown + **工具调用卡片**(名称/入参/状态:待审批/运行中/成功/失败/可展开结果);破坏性工具弹 `alert-dialog` 审批;设置页 provider 选择 + key 录入 + 模型选择 + 工具开关 + **会话级 token 用量展示**(读 `result.usage`,decision §11.4)。i18n en/zh-CN。
5. 渲染层只经 `lib/electron.ts` 调 IPC(唯一出口),key 永不到渲染层。

### P3 验收

- 主进程:AgentService + ApprovalGate + `ai:*` 纯逻辑单测(fake provider 驱动,审批放行/拒绝路径)。
- 真实 key 在 app 内对话冒烟:模型调用 hello-world 的 `greet` 工具并把结果讲回来。

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
