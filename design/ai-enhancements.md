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

| 顺序 | 项                              | 工作量 | 理由                        |
| ---- | ------------------------------- | ------ | --------------------------- |
| 1    | **Markdown 渲染** ✅ 已完成     | 小     | 日用价值最高、零回归        |
| 2    | **会话历史侧栏** ✅ 已完成      | 中     | IPC 基本就绪、自包含        |
| 3    | **审批 always 持久化** ⬅ 下一项 | 小     | 补已知安全缺口、带撤销出口  |
| 4    | **HTTP/SSE MCP 传输**           | 中     | 干净扩展 P5a                |
| 5    | **长期记忆 / RAG**              | 中→大  | 最开放;先 P6a 词法,RAG 选做 |

### 待你拍板的决策

1. **记忆检索默认**:词法 BM25(推荐,零依赖)还是直接 embeddings RAG?(仅影响第 5 项)
2. **Markdown 排版**:可加 `@tailwindcss/typography`?——**已采纳为默认**,第 1 项按此实现。

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

## 3. 审批「always」持久化

**目标**:`resolveApproval(..., "always")` 重启后仍生效(现 `permanentAllow` 内存 Set,重启丢失——见 P3 不变量)。

**方案**:

- 新 `src/main/ai/approval-store.ts`:`{ alwaysAllow: string[] }` 经 atomic-json-store 持久化。
- `AgentService`:惰性 `ensureLoaded()` 把持久集合灌入 `permanentAllow`;`resolveApproval(...,"always")` 同时落盘。`"conversation"` 维持内存。
- **撤销入口**(建议一并做):`ai:list-allowed-tools` / `ai:revoke-tool`,在「AI 设置」弹窗加「始终允许的工具」列表 + 移除——因为 always 允许破坏性工具是实打实授权,需反悔出口。
- 键用 fqName(外部 MCP 含 serverId);删 server/插件留下的孤儿项可在列表中手动清。

**触点**:新 `approval-store.ts`、`agent-service.ts`、`ipc/ai.ts`(+撤销通道)、preload、`lib/electron.ts`、`ai-settings-dialog.tsx`、测试。

---

## 4. HTTP/SSE MCP 传输

**目标**:除 stdio 外,支持连接远程 HTTP MCP server(Streamable HTTP,SSE 兜底)。

**方案**:

- `McpServerConfig` 加判别字段 `transport: "stdio" | "http"`(缺省 `"stdio"`,向后兼容);http 用 `url` + `headers`,stdio 保持 `command/args/env/cwd`。`normalizeConfig` 按 transport 分支校验。
- 新 `mcp-http-client.ts`:`createHttpMcpClient`(`StreamableHTTPClientTransport`,connect 失败回退 `SSEClientTransport`)。
- 新 `mcp-client-factory.ts`:`createMcpClient(config)` 按 transport 派发;index.ts 注入这个派发工厂(`McpClientManager` 不变——工厂已是注入点)。
- UI:`mcp-servers-dialog` 加 transport 选择,http 显示 url/headers;`coerceMcpServer` 扩展。
- 取消经 `AbortSignal` 已透传到 `callTool`。

**关键取舍**:headers 里的鉴权 token 敏感。MVP 同 env 明文存 + UI 提示;更稳做法是 token 存进加密 `AiCredentialStore`(键 `mcp:<id>`)再注入——标为后续项。

**触点**:`mcp-server-config-store.ts`、新 `mcp-http-client.ts` / `mcp-client-factory.ts`、`index.ts`、`mcp-client-manager.ts`(status 带 transport,可选)、UI + coerce + 类型、测试(config 校验 + 工厂派发)。

---

## 5. 长期记忆 / RAG(拆 P6a / P6b)

**架构契合**:做成内置工具源 `BuiltinToolSource implements ToolHostSource`,塞进 `CompositeToolHost([plugins, mcp, builtin])`——与 P5a 同构,自动进 registry、走同一审批/命名。命名空间 `memory:`。

- **P6a 记忆工具(零原生依赖,先落地)**:`MemoryStore`(JSON,atomic-json-store)+ 工具 `memory_save`(text+tags,非破坏)、`memory_search`(query→top-k,`readOnlyHint` 自动放行)、`memory_list`/`memory_delete`。检索用**词法 BM25/TF-IDF**(纯 JS、零依赖、无密钥成本)。
- **P6b 向量 RAG(可选)**:加 `provider.embed()`(OpenAI `text-embedding-3-small` / Anthropic 侧 Voyage),embedding 存 JSON,JS 算 cosine;文档 ingest = 分块→embed→存。**取舍**:引入 embedding 成本/额外 key,偏离「零原生依赖」需斟酌 → 与 P6a 解耦、按需上。

**触点**:`src/main/ai/memory/memory-store.ts`、`memory/builtin-tools.ts`、index.ts CompositeToolHost 加一项、(P6b)`providers/*` 加 embed + ingest、测试。

---

## 常用命令速查

```bash
pnpm typecheck   # 全量类型检查(SDK/node/web)
pnpm test        # vitest 一次过
pnpm lint        # eslint(commitlint subject 必须小写开头)
```
