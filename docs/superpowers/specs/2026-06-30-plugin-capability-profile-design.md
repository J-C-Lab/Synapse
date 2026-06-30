# 插件能力画像 Capability Profile + 双端投影 — 设计文档

- 日期：2026-06-30
- 状态：已确认，待实现
- 关联：[capability-governance](2026-06-25-plugin-capability-governance-design.md)、[credential-brokering](2026-06-27-credential-brokering-design.md)、[event-driven-triggers](2026-06-27-event-driven-triggers-design.md)、[github-inbox-triage](2026-06-30-github-inbox-triage-design.md)

## 1. 背景与问题

插件生态的底层机制(capability 注册表 + tier 分级、credential broker/vault、triggers + budget、JIT 审批 + 撤销、marketplace、agent tool-bridge)已基本建成且 LIVE。但这些信号**散落在各处**：

- capability 的风险等级藏在 [`capabilities.ts`](../../../packages/plugin-manifest/src/capabilities.ts) 的 `CapabilityTier`；
- scope 的人话描述在每个 scope adapter 的 `summarize()`；
- 后台运行在 `triggers[]`、凭证在 `contributes.credentials`、写回在 tool annotations；
- renderer 只有逐条 capability 列表([`plugin-capability-list.tsx`](../../../src/renderer/src/components/plugins/plugin-capability-list.tsx))与原始权限标签([`permission-tags.tsx`](../../../src/renderer/src/components/plugins/permission-tags.tsx))；
- agent 经 [`composite-tool-host.ts`](../../../src/main/ai/composite-tool-host.ts) 拿到的是**孤立的工具**(name/description/schema/annotations)，看不到插件级的"连什么、写不写回、要不要审批"。

**插件的产品定义**(本里程碑第一受众)：用户能看明白这是个什么东西；安装后 agent 能看到并据此调用。当前两端都缺**插件级的聚合画像**。连通性不缺，缺的是**理解层**。

## 2. 目标与非目标

### 目标

1. 引入一个**纯派生**的插件级画像 `PluginCapabilityProfile`，无新真相源，复用既有 capability tier / scope adapter / triggers / credentials / tool annotations。
2. 用同一份派生服务**四个消费点**：marketplace 详情、启用确认、agent 工具清单 note、agent `describe-plugin` 元工具。
3. 让"人看到的风险描述"与"agent 看到的能力描述"**同源不漂移**。

### 非目标

- 不新增/修改任何 capability、tier、运行时授权逻辑(本设计只读既有模型)。
- 不做跨插件总控台(Plugin Control Center)与开发者多模板——它们是后续独立里程碑。
- 不引入第二套风险定义；`riskLevel` 必须从既有 tier + surfaces 推导。

## 3. 架构总览

```
PluginManifest + capability 注册表 + grants?(可选授权态)
            │
            ▼
  derivePluginProfile()        ← 纯函数，packages/plugin-manifest/src/profile.ts
            │                     不 import electron / 不依赖运行时
   ┌────────┴───────────────────────────────┐
   ▼              ▼                ▼          ▼
[人·marketplace] [人·启用确认] [agent·工具清单note] [agent·describe-plugin]
```

`profile.ts` 落在 `packages/plugin-manifest`(已是共享包，被主进程、marketplace-server、docs 站引用)，因此四个消费点共享同一派生逻辑。

## 4. 数据模型

放在 `packages/plugin-manifest/src/profile.ts`。

```ts
export type RiskLevel = "low" | "medium" | "high"

export type ProfileControl =
  | "revoke"            // 任一 consent/elevated 能力可撤销
  | "disconnect"        // 持有凭证 → 可断开凭证
  | "pause-background"  // 有后台 trigger → 可暂停
  | "approval-required" // 含 elevated 能力或 destructive 工具 → 写回/高危需逐次确认
  | "audit"             // capability-audit 存在 → 可查审计

/** i18n 解耦：纯包只产出 code + 参数，渲染语言留给消费端 */
export interface ProfileLine {
  code: string                              // 例 "profile.summary.cloudAccess"
  params?: Record<string, string | number> // 例 { host: "api.github.com" }
}

export interface ProfileSurfaces {
  cloudAccess: boolean
  credentials: boolean
  remoteWriteback: boolean
  background: boolean
  localFileRead: boolean
  localFileWrite: boolean
  osIntegration: boolean
  agentCallable: boolean
}

export interface PluginCapabilityProfile {
  riskLevel: RiskLevel
  surfaces: ProfileSurfaces
  summaries: ProfileLine[]   // 正向人话："连接 GitHub"、"凭证由 Synapse 保管，插件读不到 token"
  warnings: ProfileLine[]    // 风险人话："可写回：评论/标签/PR review，需你确认"
  controls: ProfileControl[]
}

export interface DeriveProfileInput {
  manifest: PluginManifest
  /** 可选授权态。缺省 = 装前静态视图(展示"声明"而非"已授权")。 */
  grantedCapabilityIds?: ReadonlySet<string>
}

export function derivePluginProfile(input: DeriveProfileInput): PluginCapabilityProfile
```

### 4.1 surfaces 推导口径

| surface | 判定 |
| --- | --- |
| `cloudAccess` | 声明 `network:https` |
| `credentials` | 声明 `credentials:broker` 或 `contributes.credentials` 非空 |
| `remoteWriteback` | 存在某 `tool`，其 `capabilities` 含 `network:https` 且 `annotations.readOnlyHint !== true` |
| `background` | `triggers[]` 非空，或声明 `clipboard:watch` / `fs:watch` |
| `localFileRead` | 声明 `fs:read` / `fs:resolvePath` |
| `localFileWrite` | 声明 `fs:write` |
| `osIntegration` | 声明 `hotkey:global` / `system:open-url` / `system:open-path` / `system:capture-screen` / `clipboard:*` |
| `agentCallable` | `contributes.tools` 非空 |

### 4.2 riskLevel 推导(复用既有 tier)

取插件所有**已声明** capability 在注册表中的 tier 的最高档：

- 任一 `elevated` → `high`
- 否则任一 `consent` → `medium`
- 否则(全 `auto` 或无能力) → `low`

**未知 capability id**(注册表查不到 → 可能是更高版本声明)：保守计入 `high`，并产出一条 `warnings`(`profile.warning.unknownCapability`)，绝不静默忽略。

### 4.3 controls 推导

- `revoke`：存在任一 tier ∈ {consent, elevated} 的能力。
- `disconnect`：`surfaces.credentials`。
- `pause-background`：`surfaces.background`。
- `approval-required`：存在 `elevated` 能力，或任一 tool `annotations.destructiveHint === true || requiresConfirmation === true`。
- `audit`：恒为真(capability-audit 始终在)。

### 4.4 summaries / warnings 生成

按 surface 逐条产出 `ProfileLine`(i18n code + params)。网络/凭证类尽量带 scope 参数(host 取自 network scope adapter 的规范化结果；凭证 provider 取自 `contributes.credentials`)。**纯包不产出任何自然语言**——只产 code+params。

## 5. 人端两个投影

新增 `src/renderer/src/components/plugins/plugin-capability-profile.tsx`：

- 渲染 risk 徽章 + `summaries` + `warnings` + `controls` 图标行。
- `ProfileLine` 经 `t(code, params)` 落地中文/英文(沿用现有 i18n)。
- 复用既有 `Badge` / `Button` 等 shadcn 原语，风格与 `plugin-capability-list` 一致。

接入点：

1. **marketplace 详情**：[`marketplace-page.tsx`](../../../src/renderer/src/components/pages/marketplace-page.tsx) 与 docs [`marketplace/[id]/page.tsx`](../../../docs/app/marketplace/[id]/page.tsx)(docs 站在 server 端调 `derivePluginProfile`)。
2. **已装插件**：[`plugins-page.tsx`](../../../src/renderer/src/components/pages/plugins-page.tsx) 用带 `grantedCapabilityIds` 的画像(展示已授权态)。
3. **启用确认**：接入现有 capability-prompt 流程,启用时优先展示同一张卡(后台/凭证/写回/本地写入/预算)。

renderer 经一个 IPC `plugins:getCapabilityProfile(pluginId)` 拿派生结果(主进程组装 manifest + 当前 grants 调 `derivePluginProfile`)。新增 IPC 走既有四触点：纯 handler `src/main/ipc/plugin-profile.ts` + 注册 + preload + `lib/electron.ts` 包装 + 纯 handler 测试。

## 6. agent 两个投影(都做)

### 6.1 工具清单 note

在 [`composite-tool-host.ts`](../../../src/main/ai/composite-tool-host.ts) 暴露插件工具时,给每个插件的工具组前置一段**插件级 capability note**(英文 one-liner)：连什么云服务、是否能写回、写回是否需审批、凭证是否托管。note 文本由 profile 的 `surfaces` + `controls` 生成(英文,供模型读),不依赖 renderer i18n。

### 6.2 `describe-plugin` 元工具

新增一个 agent 可调用的内建工具 `describe-plugin`：

- 入参：`{ pluginId: string }`。
- 出参：完整 profile(surfaces + 全量 summaries/warnings(英文化) + controls + 已授权态)。
- 用途：agent 在"选哪个插件 / 要不要触发审批 / 这插件能不能写回"上拉完整画像。

两投影共用同一 `derivePluginProfile` + 一个 `profileToAgentText(profile)` 英文化函数(纯函数,放 profile.ts 旁)。

## 7. 错误处理与边界

- **未知 capability**：保守 high + warning,见 §4.2。
- **grants 缺省**：静态装前视图,只反映声明。
- **manifest 无 tools/triggers/credentials**：surfaces 对应位 false,不报错。
- **i18n 缺 key**：renderer 用 `defaultValue` 兜底(沿用现有 `permission-tags` 模式)。
- **profile 派生失败**(理论上不应发生,纯函数):IPC 层捕获并返回 `ElectronIpcError`,renderer toast,UI 退化为现有 permission-tags。

## 8. 测试策略

- `packages/plugin-manifest/src/profile.test.ts`(纯单测,占大头)：
  - `github-inbox` → `riskLevel: "high"`,surfaces `{cloudAccess, credentials, remoteWriteback, background, agentCallable}` 为真,controls 含 `approval-required` / `disconnect` / `pause-background` / `revoke` / `audit`。
  - `downloads-organizer` → `riskLevel: "medium"`(fs:write 是 elevated → 实际应为 high?见下),surfaces `{localFileWrite, background}` 为真,无 cloud/credentials。
    - 注：`fs:write` 在注册表是 `elevated` → riskLevel 实为 `high`。验收以"surfaces 正确 + riskLevel 与 tier 推导一致"为准,不强行压成 medium。
  - 未知 capability → high + unknownCapability warning。
  - grants 缺省 vs 传入 → 授权态差异。
  - 快照覆盖 summaries/warnings 的 code+params。
- `plugin-profile.ts` IPC 纯 handler 测试。
- renderer `plugin-capability-profile.test.tsx`：给定 profile 渲染 risk 徽章/summaries/warnings/controls。
- agent 投影：`composite-tool-host` note 注入测试 + `describe-plugin` 工具测试(给定 pluginId 返回 profile)。

## 9. 触点清单

新增：

- `packages/plugin-manifest/src/profile.ts`(+ `profile.test.ts`、`index.ts` 导出)
- `src/main/ipc/plugin-profile.ts`(+ 测试)
- `src/renderer/src/components/plugins/plugin-capability-profile.tsx`(+ 测试)
- agent `describe-plugin` 工具模块(+ 测试)

修改：

- `src/main/index.ts`(注册 `plugins:getCapabilityProfile`)
- `src/preload/index.ts` + `src/preload/index.d.ts`、`src/renderer/src/lib/electron.ts`(IPC 包装 + 类型)
- `src/main/ai/composite-tool-host.ts`(插件级 note)
- `marketplace-page.tsx` / `plugins-page.tsx` / capability-prompt 流程 / docs `marketplace/[id]/page.tsx`(消费画像)
- i18n messages(新增 `profile.*` key)

## 10. 验收标准

1. 用户在 marketplace / 启用确认页**无需读 manifest**即可知道插件"连什么、写不写回、风险在哪、怎么管"。
2. agent 在工具清单中即可见插件级 note,并能调 `describe-plugin` 拉完整画像。
3. 人端与 agent 端的风险/能力描述源自同一 `derivePluginProfile`,无重复定义。
4. `github-inbox` / `downloads-organizer` 的画像快照符合 §8。
5. 既有 capability/tier/授权运行时逻辑零改动。
