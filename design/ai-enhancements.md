# Synapse AI 基座 —— 增强项落地方案(交接单)

> 跨会话交接单。承接 [ai-foundation-progress.md](ai-foundation-progress.md)(P0–P5 已完成、CI 绿)。
> 本文件覆盖 P5 之后的 5 项可选增强的落地设计。创建于 2026-06-04。仓库:`sunzrnobug/Synapse`(public),单 `main` 分支。

---

## 已确认的技术前提(2026-06-04 核实)

- **MCP SDK 客户端**自带传输:`@modelcontextprotocol/sdk/client/streamableHttp.js`、`sse.js`、`websocket.js`、`stdio.js`。`StreamableHTTPClientTransport(url: URL, { requestInit, sessionId })` 可注入 headers。
- **渲染层外链**已由 [src/main/window-security.ts](../src/main/window-security.ts) 自动路由到系统浏览器(`setWindowOpenHandler` + `will-navigate` → `shell.openExternal`)。Markdown 链接天然安全外开,无需额外处理。
- **Markdown 依赖**当前未安装(干净起点)。
- **HTTP MCP client 跑在主进程**(Node fetch),不受渲染层严格 CSP 限制——HTTP MCP 无需改 CSP。

## 复用的既有架构

- **`ToolHostSource` / `CompositeToolHost`**([src/main/ai/composite-tool-host.ts](../src/main/ai/composite-tool-host.ts)):多工具源按 `ownsTool(fqName)` 合并/路由。新增工具源(记忆、HTTP MCP)只需实现该接口并加进数组。
- **atomic-json-store**([src/main/lan/atomic-json-store.ts](../src/main/lan/atomic-json-store.ts)):崩溃安全 JSON 读写,所有持久化复用它(零原生依赖,设计 §11.1)。
- **三层 IPC**:pure handler → main 绑定 → preload → renderer `lib/electron.ts`(唯一 `window.electronAPI` 出口)。新增通道 = 4 触点 + 测试。
- **审批**:`decideApproval(annotations)`(只读自动放行,其余 ask);`AgentService` 内 `permanentAllow`/`conversationAllow`。

---

## 推荐落地顺序

| 顺序 | 项                               | 工作量 | 理由                       |
| ---- | -------------------------------- | ------ | -------------------------- |
| 1    | **Markdown 渲染** ✅ 已完成      | 小     | 日用价值最高、零回归       |
| 2    | **会话历史侧栏** ✅ 已完成       | 中     | IPC 基本就绪、自包含       |
| 3    | **审批 always 持久化** ✅ 已完成 | 小     | 补已知安全缺口、带撤销出口 |
| 4    | **HTTP/SSE MCP 传输** ✅ 已完成  | 中     | 干净扩展 P5a               |
| 5    | **长期记忆 / RAG** ✅ 已完成     | 中→大  | 用 **embeddings**(已拍板)  |

### 已拍板的决策

1. **记忆检索**:用 **embeddings RAG**(用户拍板,2026-06-04),不走 BM25。
2. **Markdown 排版**:采用 `@tailwindcss/typography`(已落地第 1 项)。

---

## 1. Markdown 渲染 ✅ 已完成

**目标**:助手回复从 `whitespace-pre-wrap` 升级为 Markdown(代码块、列表、表格、链接)。

**落地**:`react-markdown@10` + `remark-gfm`,`@tailwindcss/typography`(`globals.css` 经 `@plugin` 注册)。

- 新 [src/renderer/src/components/markdown.tsx](../src/renderer/src/components/markdown.tsx):**不渲染原始 HTML**(默认行为,**未**引入 `rehype-raw`)→ 防 XSS;`a` 覆写为 `target=_blank rel=noopener` → 经 window-security 外开;`prose prose-sm dark:prose-invert` + 紧凑 prose 间距。
- `chat-page.tsx` `MessageBubble`:assistant 文本走 `<Markdown>`,user 仍纯文本。
- 测试 `markdown.test.tsx`(4):标题/列表/inline code、围栏代码块、链接 target、**裸 HTML 不渲染**。
- 注意:react-markdown `children` 必须是**单一字符串**(测试里 JSX 多子节点会触发其断言)。代码高亮未上(纯 `<pre>`),后续可加 `shiki`(无 eval,符合严格 CSP)。

---

## 2. 会话历史侧栏 ✅ 已完成

**目标**:左侧列历史会话(标题/时间),点击加载,支持新建/删除。

**落地**:

- 新增 `AgentService.deleteConversation`(先 `cancel` 在飞轮次再 `ConversationStore.delete`)+ `ai:delete-conversation` IPC + preload/wrapper(`deleteAiConversation`)。
- 新 [chat-message-model.ts](../src/renderer/src/components/pages/chat-message-model.ts):抽出 `DisplayMessage`/`ToolCard` 类型 + `hydrateMessages(stored)` —— `ChatMessage[]` IR → `DisplayMessage[]`。**仅含 tool_result 的 user 轮不产生气泡**(只回填工具卡状态,按 `toolUseId` 配对 `isError`);有文本的 user 轮才出气泡。配 3 个单测。
- 新 [conversation-sidebar.tsx](../src/renderer/src/components/conversation-sidebar.tsx):新建按钮 + 列表(标题/未命名,active 高亮,hover 删除),`ScrollArea`。
- `chat-page.tsx`:`conversationId` 改 state;`selectConversation`(拉取并水合)、`newConversation`、`removeConversation`;列表在挂载 + 每次 `done` 事件后刷新;Header 加 `PanelLeft` 折叠按钮(`showSidebar`)。
- i18n `chat.newConversation/noHistory/untitled/deleteConversation/toggleSidebar`(en/zh-CN);`launcher-settings.test.tsx` mock 补 `deleteAiConversation`。

**注意/已知限制**:

- 工具卡显示的是 IR 里的 **sanitized** 名(如 `com_x_act`),非 live 时的 fqName(渲染层无反查表);历史工具卡默认 `success`(被 `tool_result.isError` 覆写为 error)。
- `crypto.randomUUID()` 返回模板字面量类型,`useState<string>(...)` 显式标注以便 `setConversationId(普通 string)`。

---

## 3. 审批「always」持久化 ✅ 已完成

**目标**:`resolveApproval(..., "always")` 重启后仍生效(原 `permanentAllow` 内存 Set,重启丢失——见 P3 不变量)。

**落地**:

- 新 [approval-store.ts](../src/main/ai/approval-store.ts):`{ alwaysAllow: string[] }` 经 atomic-json-store 持久化;`list/add/remove`。
- `AgentService`:`ensurePermanentAllowLoaded()` 惰性把持久集合灌入 `permanentAllow`(在 `approve()` 入口 await);`resolveApproval(...,"always")` 同步加内存 + `void approvals.add()` 落盘;新增 `listAllowedTools()` / `revokeTool(fqName)`。`"conversation"` 维持内存。
- IPC `ai:list-allowed-tools` / `ai:revoke-tool` + preload/wrapper(`listAiAllowedTools`/`revokeAiTool`)。
- index.ts 装配 `new ApprovalStore(aiApprovalsFilePath(userDataDir))`。
- 「AI 设置」弹窗底部加「始终允许的工具」列表(fqName + 撤销),open 时加载;`providers.allowedTools/allowedEmpty/revoke` i18n(en/zh-CN)。
- 测试:`approval-store.test.ts`(3:跨实例持久、删除、丢弃损坏数据)+ agent-service(2:store 种子→工具免审运行、持久+撤销)。
- 键用 fqName(外部 MCP 含 serverId);删 server/插件留下的孤儿项可在列表手动撤销。

---

## 4. HTTP/SSE MCP 传输 ✅ 已完成

**目标**:除 stdio 外,支持连接远程 HTTP MCP server(Streamable HTTP,SSE 兜底)。

**落地**:

- `McpServerConfig` 加判别字段 `transport?: "stdio" | "http"`(缺省 stdio,向后兼容);http 用 `url` + `headers`,`command` 改为可选。`normalizeConfig` 按 transport 分支:http 校验 `url` 为 http(s)、stdio 校验 `command`;落库时丢弃另一传输的字段。
- 新 [mcp-http-client.ts](../src/main/ai/mcp-http-client.ts):`createHttpMcpClient` 先 `StreamableHTTPClientTransport`,connect 失败用**新 Client** 回退 `SSEClientTransport`;`headers` 经 `requestInit` 注入。
- 新 [mcp-client-factory.ts](../src/main/ai/mcp-client-factory.ts):`createMcpClient` 按 `transport` 派发;index.ts 注入它(`McpClientManager` 不变——工厂本就是注入点);`createStdioMcpClient` 加 command 缺失守卫。
- UI:`mcp-servers-dialog` 加传输 `NativeSelect`,http 显示 url/headers、stdio 显示 command/args/env;`draftIsValid` 按传输判定;`coerceMcpServer` 放宽为仅 require id(命令/URL 校验下沉到 store)。`SynapseMcpServerConfig` 加 transport/url/headers。
- 测试:config-store(http 保存/丢 stdio 字段、缺 url 拒绝、默认 stdio)+ `mcp-client-factory`(派发 + 缺 command/url 抛错)+ ipc coerce(http 透传)。

**关键取舍/caveat**:headers 里的鉴权 token 明文存于配置(同 env),UI 已提示勿存密钥;更稳做法是存进加密 `AiCredentialStore`(键 `mcp:<id>`)再注入——留作后续。HTTP client 跑主进程,不受渲染层 CSP 限制。

---

## 5. 长期记忆 / RAG ✅ 已完成(embeddings)

**目标**:跨会话的长期记忆,语义召回(用 embeddings,用户拍板)。

**落地**(全部 `src/main/ai/memory/`):

- [memory-store.ts](../src/main/ai/memory/memory-store.ts):`MemoryEntry { id, text, tags, createdAt, embedding? }` JSON 持久化(atomic-json-store);`all/add/remove`,加载丢弃损坏项。
- [openai-embedding-provider.ts](../src/main/ai/memory/openai-embedding-provider.ts):`Embedder.embed(texts) => number[][] | null`;OpenAI `text-embedding-3-small`,key 经 `getApiKey`(复用 BYOK 的 openai key)**调用时**解析——无 key 返回 `null`;client 可注入测试。
- [memory-service.ts](../src/main/ai/memory/memory-service.ts):`save/search/list/delete`。save 嵌入并存;search 有嵌入则 **cosine** 排序,否则**词法回退**(词项重叠);`safeEmbed` 吞掉嵌入失败(无 key/网络/配额)→ 回退词法。导出 `cosineSimilarity`。
- [memory-tools.ts](../src/main/ai/memory/memory-tools.ts):`MemoryToolSource implements ToolHostSource`(命名空间 `memory:core/…`),暴露 `memory_save`(写,需审批)、`memory_search`/`memory_list`(`readOnlyHint` 自动放行)、`memory_delete`(`destructiveHint` 需审批);入参就地校验(不走 vm 沙箱),错误→`isError`。
- index.ts:`OpenAiEmbeddingProvider` + `MemoryService` + `MemoryToolSource` 接入 `CompositeToolHost`(plugin 兜底谓词加 `memory:` 排除);与 mcp 共享同一 `AiCredentialStore`。
- 测试:memory-store(2)、memory-service(cosine 排序 + 词法回退 + 列表/删除 + 空文本 + cosine 工具,5)、memory-tools(命名空间/列表、存→召回、错误、注解审批,4)。

**说明/已知限制**:

- 嵌入需 **OpenAI key**;只配了 Anthropic key 时自动走词法回退(仍可用,但非语义)。RAG 文档分块 ingest(P6b)未做——当前「语料」即记忆条目本身。
- `memory_save` 每次写入会触发审批(与统一安全模型一致);可用「始终允许」(已持久化,见第 3 项)免后续询问。
- 工具名 `memory_*` 对 OpenAI 64 字符限制安全。

---

## 常用命令速查

```bash
pnpm typecheck   # 全量类型检查(SDK/node/web)
pnpm test        # vitest 一次过
pnpm lint        # eslint(commitlint subject 必须小写开头)
```
