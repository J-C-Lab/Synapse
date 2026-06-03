# Synapse AI 基座 —— 进度存档 & 续作指南

> 本文件是**跨会话工作交接单**。在新窗口开工前先读这份 + [ai-foundation.md](ai-foundation.md)(完整设计)。
> 最近更新:2026-06-03。仓库:`sunzrnobug/Synapse`(private),单 `main` 分支。

---

## 总览:路线图与当前位置

| 阶段                                  | 内容                                                                                       | 状态                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| **P0 协议层**                         | 清单 `contributes.tools` + SDK `tools/ToolContext/ToolResult` + schema 校验 + CLI validate | ✅ 已完成(提交 `61d9cf1`) |
| **P1 本地工具桥 + 沙箱执行**          | `PluginToolBridge` + 沙箱 `invokeTool` + 权限校验 + 单测                                   | ✅ 已完成                 |
| **P2 AgentRuntime + Claude provider** | 编排循环 + Anthropic 适配(prompt caching)+ key 凭据库                                      | ⬜ **下一步**             |
| **P3 Chat UI + 审批**                 | Chat 页 + 工具卡片 + ApprovalGate + 流式 IPC                                               | ⬜                        |
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

- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` **294 passed**(P0 +6,P1 +23)
- commitlint 生效:**subject 必须小写开头**(用 `feat(ai): add ...` 不要 `feat(ai): P1 ...`)。
- husky/lint-staged 在提交时跑 eslint --fix + prettier,可能改动暂存文件(正常)。

---

## 下一步:P2 详细落地建议

目标:**内置智能体能用插件工具完成任务**(先 CLI/测试驱动,UI 是 P3)。

### 建议新增结构(`src/main/ai/`,纯逻辑配单测,与 Electron 解耦)

```
src/main/ai/
├─ providers/
│  ├─ types.ts            # ChatProvider / ProviderRequest / ProviderEvent / ModelInfo
│  └─ anthropic.ts        # Anthropic 适配器:@anthropic-ai/sdk,stream(),工具格式翻译,prompt caching
├─ tool-registry.ts       # ToolRegistry:把 host.listTools() 的工具翻译成 provider tool schema(name sanitize + 反查)
├─ agent-runtime.ts       # 标准 tool-use 循环(流式、maxSteps、超时、AbortSignal、可取消)
├─ credential-store.ts    # key 存 OS 凭据库(复用 src/main/lan/credential-store.ts 思路);renderer 永不接触 key
└─ conversation-store.ts  # 纯 JSON 会话存储(复用 LAN 的 atomic-json-store)
```

### P2 落地要点

1. **ChatProvider 抽象**(design §4):`stream(req): AsyncIterable<ProviderEvent>`,事件含 text delta / tool_use / usage / done。
2. **Anthropic 适配器**:默认模型 `claude-opus-4-8`(或当时最新);**system + 工具定义打 prompt cache**;用 `@anthropic-ai/sdk`(新依赖,纯 JS,符合无 native toolchain)。**建议用 `claude-api` skill** 辅助,确保带 prompt caching。
3. **工具命名 sanitize**:fqName `com.x/foo` 含 `.`和`/`,不满足 Anthropic 工具名 `^[a-zA-Z0-9_-]{1,64}$`。在 ToolRegistry 层把 `.`/`/` 替换为 `_`,维护 sanitized↔fqName 反查表,调用时映射回去走 `host.invokeTool(fqName, ...)`。
4. **AgentRuntime 循环**(design §3):组装 system+历史+工具 → `provider.stream()` → 模型 `tool_use` → **(P2 先全部直接执行,审批 ApprovalGate 留 P3)** → `host.invokeTool` → `tool_result` 回灌 → 重复至最终回答或 `maxSteps`。单会话串行;每步超时 + maxSteps 防失控。
5. **key 凭据库**:参考 `src/main/lan/credential-store.ts`,key 进 OS keychain,绝不回传 renderer。
6. **会话存储**:纯 JSON,参考 LAN 的 `atomic-json-store`。

### P2 验收(无 UI,测试驱动)

- 单测:给一个 fake provider(脚本化 tool_use → tool_result → text),驱动 AgentRuntime 跑完整循环,断言它调用了 `host.invokeTool` 并把结果回灌、最终产出文本。
- 单测:工具名 sanitize 往返、maxSteps 截断、AbortSignal 取消。
- Anthropic 适配器:用录制/mock 的 SSE 验证流式解析与 usage 提取;真实 key 跑一次冒烟(手动)。

### IPC(P2 可先不做,P3 需要)

design §8 的 `ai:*` 通道(`ai:chat` 流式、`ai:listTools`、`ai:setProviderKey`、`ai:approve`、`ai:mcp:*`)按现有四段式加。P2 可纯主进程 + 测试,P3 接 UI 时再落 IPC。

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
