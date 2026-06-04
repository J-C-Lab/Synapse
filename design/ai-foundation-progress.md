# Synapse AI 基座 —— 进度存档 & 续作指南

> 本文件是**跨会话工作交接单**。在新窗口开工前先读这份 + [ai-foundation.md](ai-foundation.md)(完整设计)。
> 最近更新:2026-06-04。仓库:`sunzrnobug/Synapse`(public),单 `main` 分支。

---

## 总览:路线图与当前位置

| 阶段                                  | 内容                                                                                       | 状态                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| **P0 协议层**                         | 清单 `contributes.tools` + SDK `tools/ToolContext/ToolResult` + schema 校验 + CLI validate | ✅ 已完成(提交 `61d9cf1`) |
| **P1 本地工具桥 + 沙箱执行**          | `PluginToolBridge` + 沙箱 `invokeTool` + 权限校验 + 单测                                   | ✅ 已完成                 |
| **P2 AgentRuntime + Claude provider** | 编排循环 + Anthropic 适配(prompt caching)+ key 凭据库                                      | ✅ 已完成                 |
| **P3 Chat UI + 审批**                 | Chat 页 + 工具卡片 + ApprovalGate + 流式 IPC                                               | ✅ 已完成                 |
| **P4 MCP server(对外)**               | 内置 MCP server 暴露插件工具给 Claude Desktop/Code                                         | ✅ 已完成                 |
| **P5a MCP client(对内)**              | 接入外部 stdio MCP server,工具汇入内置智能体                                               | ✅ 已完成                 |
| **P5b 多 provider**                   | OpenAI 适配 + provider/模型切换                                                            | ✅ 已完成                 |
| **P6 记忆/RAG(可选)**                 | 长期记忆工具 + 本地向量检索                                                                | ⬜ **下一步**             |

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

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` **361 passed**(P0 +6,P1 +23,P2 +22,P3 +15,P4 +5,P5a +18,P5b +7)
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

## P4 成果(已落地)

**插件工具可经 stdio MCP 暴露给 Claude Desktop/Code 等外部智能体**。依赖新增官方 `@modelcontextprotocol/sdk`(纯 JS,主进程外置)。传输只做 stdio;HTTP/SSE 仍推迟到 P5。

| 文件                                      | 作用                                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/mcp/synapse-mcp-server.ts` (新) | `SynapseMcpToolService`:复用插件 `listTools()`/`invokeTool()`;复用 P2 `sanitizeToolName`/`uniqueName`;低层 MCP `Server` 注册 `tools/list`/`tools/call`;`ToolResult` → MCP `CallToolResult` 转换 |
| `src/main/mcp/synapse-mcp-server.test.ts` | P4 单测:只读工具默认暴露、MCP caller 路由、隐藏破坏性工具、`exposurePolicy:"all"` opt-in、SDK in-memory `tools/list` + `tools/call` 协议冒烟                                                    |
| `src/main/ai/tool-registry.ts`            | 导出 `sanitizeToolName`/`uniqueName`,供 AI provider 与 MCP server 共用同一命名规则                                                                                                              |
| `src/main/index.ts`                       | 新增早期 `--mcp-stdio` 模式:只初始化 `PluginHost` + MCP stdio server;不抢 packaged app 单实例锁;不创建窗口/托盘/IPCs;退出时 dispose 插件宿主                                                    |

**关键不变量(P5+ 注意)**

- 启动入口:`Synapse --mcp-stdio`(dev 下可让 Electron 进程带该参数);该进程是 MCP 子进程模式,不会打开 UI,也不会触发 packaged app 的 single-instance lock。
- 默认安全策略:`exposurePolicy:"readOnlyOnly"`。只有 `decideApproval(annotations)==="allow"` 的工具会出现在 `tools/list`;破坏性/需要确认/未标注工具不会暴露,直接调用也返回 `isError:true`。
- 工具执行仍走 P1 链路:`PluginToolBridge` → `PluginRegistry` → `PluginSandbox`;caller 标 `{kind:"mcp"}`。输入校验、权限收窄、超时/取消语义保持一致。
- MCP schema 边界:插件 `inputSchema`/`outputSchema` 原样保留根字段,但 `properties` 会窄化为对象型 schema,以满足 MCP SDK 类型约束。
- `ToolResult.content` 转 MCP content:text 原样;json 转 JSON 字符串 text;image 转 `[image: path]` text。`structured` 为普通对象时映射到 `structuredContent`。

**P4 验收状态**

- P4 单测/协议冒烟 ✅:`pnpm test src/main/mcp/synapse-mcp-server.test.ts src/main/ai/tool-registry.test.ts`
- 类型/静态检查 ✅:`pnpm typecheck`、`pnpm lint`
- 手动外部客户端冒烟 ⬜:在 Claude Desktop/Code 配置 `Synapse --mcp-stdio`,确认能列出并调用只读插件工具(如模板 `greet`)。

## P5a 成果(已落地)

**内置智能体可调用外部 stdio MCP server 的工具**。复用 P4 已引入的 `@modelcontextprotocol/sdk`(Client 端),无新依赖。

| 文件                                                      | 作用                                                                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ai/composite-tool-host.ts` (新)                 | `CompositeToolHost`(实现 `ToolHostPort`,合并多个 `ToolHostSource`,按 `ownsTool(fqName)` 路由)+ `asFallbackSource`(把裸 PluginHost 包成兜底 source)                                             |
| `src/main/ai/mcp-server-config-store.ts` (新)             | `McpServerConfigStore`:外部 server 启动配置(id/name/command/args/env/cwd/enabled)持久化为纯 JSON(复用 atomic-json-store);id 校验 `^[\w-]{1,64}$`;加载时丢弃损坏/重复项                         |
| `src/main/ai/mcp-client-manager.ts` (新)                  | `McpClientManager`(实现 `ToolHostSource`):连接/断开/重启每个 server,缓存 `tools/list`,工具命名空间 `mcp:<id>/<tool>`;`callTool` 映射 MCP `CallToolResult`→`ToolResult`;client 端口注入便于测试 |
| `src/main/ai/mcp-stdio-client.ts` (新)                    | 生产 stdio 客户端工厂(`createStdioMcpClient`):`Client` + `StdioClientTransport`;env 合并 `getDefaultEnvironment()` 以保留 PATH;隔离 SDK/子进程面                                               |
| `src/main/ai/agent-service.ts`                            | 新增 `mcp?` 选项;`startMcpServers`/`listMcpServers`/`mcpServerStatus`/`saveMcpServer`(持久化+重连)/`deleteMcpServer`                                                                           |
| `src/main/ipc/ai.ts`                                      | 新增 `ai:mcp:list`/`status`/`save`/`delete` + `coerceMcpServer` 校验                                                                                                                           |
| `src/main/index.ts`                                       | `createAgentService` 改用 `CompositeToolHost([asFallbackSource(plugins, mcp:前缀), manager])`;init 后台 `startMcpServers`;退出 `mcpClients.dispose()`                                          |
| preload/d.ts、renderer `lib/electron.ts`                  | `listAiMcpServers`/`getAiMcpServerStatus`/`saveAiMcpServer`/`deleteAiMcpServer` + `SynapseMcpServer*` 类型                                                                                     |
| `src/renderer/src/components/mcp-servers-dialog.tsx` (新) | MCP 服务器管理弹窗(列表+状态徽章+工具数+增改删表单),从 Chat 页头部 `MCP servers` 按钮打开;`mcp.*` i18n(en/zh-CN)                                                                               |

**关键不变量(P5b+ 注意)**

- 工具来源统一为 `ToolHostPort`;`AiToolRegistry` 不感知插件 vs 外部 MCP,二者经 `CompositeToolHost` 合并、按 fqName 前缀(`mcp:`)路由。要再加来源(如 HTTP MCP)只需实现 `ToolHostSource` 并加进数组。
- 外部 server **不可信**:其 annotations 仅作提示。采用统一审批规则——`readOnlyHint` 自动放行,其余(含未标注)ask;启用某 server 本身即一次信任决定,用户可按会话/永久记忆放行。
- 外部工具执行**不走** P1 沙箱(那是给插件 vm 的);直接经 MCP 协议 `tools/call`,`caller` 仍标 `{kind:"agent"}`;取消经 `AbortSignal` 透传到 `callTool`。
- 对外 MCP server(P4,`--mcp-stdio`)仍直接用 `PluginHost`,**不**经 CompositeToolHost——避免把外部工具再转发出去形成环。
- env 配置以明文持久化(它是启动指令,非密钥库);UI 已提示勿存密钥。provider key 仍只在加密的 `AiCredentialStore`。

## P5b 成果(已落地)

**多 provider BYOK:OpenAI 适配 + provider/模型切换**。工具层、审批、MCP 全部 provider 无关,只在装配层选 provider。新增 `openai` 依赖(纯 JS,外置)。

| 文件                                                      | 作用                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/openai-provider.ts` (新)                       | `OpenAiProvider` 实现 `ChatProvider`:IR ↔ Chat Completions;流式 text delta;**跨 chunk 累积 tool_calls** 成 IR `tool_use`(parse arguments JSON);usage 映射(`cached_tokens`→cacheRead);`OpenAiChatClient` 端口注入便于测试;默认模型 `gpt-4.1` |
| `providers/catalog.ts` (新)                               | `ProviderDescriptor`(id/label/defaultModel/models/`create(apiKey)`)+ `defaultProviderCatalog()`(anthropic + openai)+ `DEFAULT_PROVIDER_ID`。provider 元数据与工厂的单一来源                                                                 |
| `ai-settings-store.ts` (新)                               | `AiSettingsStore`:活动 provider + 每 provider 模型,纯 JSON 持久化(无密钥)                                                                                                                                                                   |
| `agent-service.ts`                                        | 移除硬编码 anthropic;`selection()` 解析活动 provider+模型;`createProviderFor()`(catalog.create 或注入 override);`getStatus` 返回 `{provider, hasKey, model, providers[]}`;`setKey/deleteKey(providerId)`、`setActiveProvider`、`setModel`   |
| `ipc/ai.ts`                                               | `ai:set-key`(payload `{providerId,key}`)、`ai:delete-key(providerId)`、`ai:set-provider`、`ai:set-model` + `coerceProviderKey`/`coerceProviderModel`                                                                                        |
| preload/d.ts、renderer `lib/electron.ts`                  | provider 参数化的 key 操作 + `setAiProvider`/`setAiModel`;`SynapseAiProviderStatus`、`AiStatus` 扩展                                                                                                                                        |
| `src/renderer/src/components/ai-settings-dialog.tsx` (新) | 「AI 设置」弹窗:provider 选择、模型选择、每 provider key 录入/移除;Chat 页头部齿轮按钮打开;`providers.*` i18n(en/zh-CN)。Chat 空状态的 key 录入改用活动 provider                                                                            |

**关键不变量(P6+ 注意)**

- 装配处用 `providers: defaultProviderCatalog()` + `settings: AiSettingsStore`;测试可注入 `createProvider(providerId, apiKey)` override 绕开真实 SDK。
- 模型经 `AgentRuntime.model` → `ProviderRequest.model` 流动,**不**进 provider 构造器;故 catalog 工厂只接收 key。
- 每 provider 各存各的 key(`AiCredentialStore` 按 providerId),切换 provider 不清除其它 key;`getStatus().providers[]` 报告每个的 hasKey。
- 工具名 sanitize(`[\w-]≤128`)对 OpenAI(限 64)偏宽:插件工具名短,暂不收紧;如接入超长名外部 MCP 工具需注意。
- 默认 provider 仍是 anthropic(catalog 首项 / `DEFAULT_PROVIDER_ID`)。

## 下一步:P6 — 记忆 / RAG(可选)

目标:**长期记忆工具 + 本地向量检索**(设计 §未定,可选增强)。也可转向此前列出的非阻塞增强:会话历史侧栏、Markdown 渲染、HTTP/SSE MCP 传输、审批「always」持久化、预算上限。

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
