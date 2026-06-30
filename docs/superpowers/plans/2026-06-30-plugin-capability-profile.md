# 插件能力画像 Capability Profile + 双端投影 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入一个纯派生的插件级 `PluginCapabilityProfile`，用同一份派生服务 marketplace 详情、启用确认、agent 工具清单 note 与 agent `describe-plugin` 元工具，让"用户看得懂、agent 看得到"两端同源不漂移。

**Architecture:** 在共享包 `@synapse/plugin-manifest` 内新增纯函数 `derivePluginProfile(manifest, grantedCapabilityIds?)`，复用既有 `getCapability` 的 tier 分级、tool annotations、triggers、credentials。主进程经 IPC 把派生结果(带授权态)送给 renderer；agent 侧由 `AiToolRegistry` 在工具描述前置插件级 note，并新增 `PluginIntrospectionToolSource` 暴露 `describe_plugin` 工具。

**Tech Stack:** TypeScript 5 (strict)、Electron 33、React 19、Vitest、i18next。包名 `@synapse/plugin-manifest`（注意：源码 import 用 `@synapse/plugin-manifest`，见既有 `src/main/ipc/capabilities.ts:1`）。

---

## 设计参考

- Spec：[2026-06-30-plugin-capability-profile-design.md](../specs/2026-06-30-plugin-capability-profile-design.md)
- 关键真实接口（实现时对照）：
  - `getCapability(id)` / `CapabilityTier`：[`packages/plugin-manifest/src/capabilities.ts:96`](../../../packages/plugin-manifest/src/capabilities.ts)，tier ∈ `auto|consent|elevated`
  - `PluginManifest` 形状：[`packages/plugin-manifest/src/types.ts:102`](../../../packages/plugin-manifest/src/types.ts)，`capabilities: {id, scope?}[]`、`contributes.tools?`、`contributes.credentials?`、`triggers?`
  - IPC 范式：[`src/main/ipc/capabilities.ts`](../../../src/main/ipc/capabilities.ts)（`CapabilityIpcService.listPluginCapabilities` 第 137 行展示 `getHost().get(pluginId).manifest` 与 `getHost().grants.isGranted(identity, id)`）
  - agent 工具描述生成：[`src/main/ai/tool-registry.ts:54`](../../../src/main/ai/tool-registry.ts)（`AiToolRegistry.refresh()` 用 `descriptor.manifestTool.description`）
  - 内建工具源范式：[`src/main/ai/memory/memory-tools.ts:102`](../../../src/main/ai/memory/memory-tools.ts)（`MemoryToolSource implements ToolHostSource`）
  - 测试 fixture：[`resources/builtin-plugins/github-inbox/synapse.json`](../../../resources/builtin-plugins/github-inbox/synapse.json)、[`resources/builtin-plugins/downloads-organizer/synapse.json`](../../../resources/builtin-plugins/downloads-organizer/synapse.json)

## 文件结构

新增：

- `packages/plugin-manifest/src/profile.ts` — 纯派生 + agent 英文化（一个职责：从 manifest 派生画像）
- `packages/plugin-manifest/src/profile.test.ts`
- `src/main/ai/plugin-introspection-tools.ts` — `describe_plugin` 工具源（+ `.test.ts`）
- `src/renderer/src/components/plugins/plugin-capability-profile.tsx`（+ `.test.tsx`）

修改：

- `packages/plugin-manifest/src/index.ts` — 导出 profile API
- `src/main/ipc/capabilities.ts` — 新增 `getCapabilityProfile` 方法 + handler + 注册
- `src/main/ai/tool-registry.ts` — `AiToolRegistry` 接受可选 `pluginNote` provider
- `src/preload/index.ts`、`src/preload/index.d.ts`、`src/renderer/src/lib/electron.ts` — IPC 包装与类型
- `src/main/index.ts` — 装配 `pluginNote` 闭包 + 注册 `PluginIntrospectionToolSource` + 注册新 IPC
- `src/renderer/src/components/pages/plugins-page.tsx`、`marketplace-page.tsx`、capability-prompt 启用流程 — 渲染画像卡
- `docs/app/marketplace/[id]/page.tsx` — server 端渲染画像
- `src/renderer/src/i18n/messages/en.json`、`zh-CN.json` — `profile.*` 文案

---

## Task 1: profile.ts — surfaces / riskLevel / controls 核心派生

**Files:**

- Create: `packages/plugin-manifest/src/profile.ts`
- Test: `packages/plugin-manifest/src/profile.test.ts`

- [ ] **Step 1: 写失败测试（surfaces + riskLevel + controls）**

`packages/plugin-manifest/src/profile.test.ts`：

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseManifest } from "./schema"
import { derivePluginProfile } from "./profile"

function loadFixture(name: string) {
  const path = join(__dirname, "../../../resources/builtin-plugins", name, "synapse.json")
  return parseManifest(JSON.parse(readFileSync(path, "utf8")))
}

describe("derivePluginProfile — surfaces/risk/controls", () => {
  it("classifies github-inbox as high-risk cloud/credential/writeback/background", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("github-inbox") })
    expect(profile.riskLevel).toBe("high")
    expect(profile.surfaces).toMatchObject({
      cloudAccess: true,
      credentials: true,
      remoteWriteback: true,
      background: true,
      localFileRead: false,
      localFileWrite: false,
      osIntegration: false,
      agentCallable: true,
    })
    expect(profile.controls).toEqual([
      "revoke",
      "disconnect",
      "pause-background",
      "approval-required",
      "audit",
    ])
  })

  it("classifies downloads-organizer as local fs-write background automation", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("downloads-organizer") })
    expect(profile.riskLevel).toBe("high") // fs:write is an elevated capability
    expect(profile.surfaces).toMatchObject({
      cloudAccess: false,
      credentials: false,
      remoteWriteback: false,
      background: true,
      localFileRead: false,
      localFileWrite: true,
      osIntegration: false,
      agentCallable: true,
    })
    expect(profile.controls).toEqual(["revoke", "pause-background", "approval-required", "audit"])
  })

  it("treats an unknown capability id conservatively as high risk", () => {
    const manifest = loadFixture("downloads-organizer")
    const mutated = { ...manifest, capabilities: [{ id: "future:teleport" }] }
    const profile = derivePluginProfile({ manifest: mutated })
    expect(profile.riskLevel).toBe("high")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- packages/plugin-manifest/src/profile.test.ts`
Expected: FAIL（`derivePluginProfile` 未定义 / 模块缺失）

- [ ] **Step 3: 实现核心派生**

`packages/plugin-manifest/src/profile.ts`（本步只写到 controls，summaries/warnings 在 Task 2 补）：

```ts
import type { PluginManifest } from "./types"
import { getCapability } from "./capabilities"

export type RiskLevel = "low" | "medium" | "high"

export type ProfileControl =
  | "revoke"
  | "disconnect"
  | "pause-background"
  | "approval-required"
  | "audit"

export interface ProfileLine {
  code: string
  params?: Record<string, string | number>
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
  summaries: ProfileLine[]
  warnings: ProfileLine[]
  controls: ProfileControl[]
}

export interface DeriveProfileInput {
  manifest: PluginManifest
  /** 缺省 = 装前静态视图（只反映声明，不反映已授权）。 */
  grantedCapabilityIds?: ReadonlySet<string>
}

const OS_INTEGRATION_IDS = [
  "hotkey:global",
  "system:open-url",
  "system:open-path",
  "system:capture-screen",
  "clipboard:read",
  "clipboard:write",
  "clipboard:watch",
]

function deriveSurfaces(manifest: PluginManifest): ProfileSurfaces {
  const ids = new Set(manifest.capabilities.map((cap) => cap.id))
  const tools = manifest.contributes.tools ?? []
  return {
    cloudAccess: ids.has("network:https"),
    credentials: ids.has("credentials:broker") || (manifest.contributes.credentials?.length ?? 0) > 0,
    remoteWriteback: tools.some(
      (tool) =>
        (tool.capabilities ?? []).some((cap) => cap.id === "network:https") &&
        tool.annotations?.readOnlyHint !== true
    ),
    background:
      (manifest.triggers?.length ?? 0) > 0 || ids.has("clipboard:watch") || ids.has("fs:watch"),
    localFileRead: ids.has("fs:read") || ids.has("fs:resolvePath"),
    localFileWrite: ids.has("fs:write"),
    osIntegration: OS_INTEGRATION_IDS.some((id) => ids.has(id)),
    agentCallable: (manifest.contributes.tools?.length ?? 0) > 0,
  }
}

/** True 表示存在注册表查不到的 capability（前向兼容 → 保守计高危）。 */
function hasUnknownCapability(manifest: PluginManifest): boolean {
  return manifest.capabilities.some((cap) => getCapability(cap.id) === undefined)
}

function deriveRiskLevel(manifest: PluginManifest): RiskLevel {
  if (hasUnknownCapability(manifest)) return "high"
  let highest = 0 // 0 auto, 1 consent, 2 elevated
  for (const { id } of manifest.capabilities) {
    const tier = getCapability(id)?.tier
    const rank = tier === "elevated" ? 2 : tier === "consent" ? 1 : 0
    if (rank > highest) highest = rank
  }
  return highest === 2 ? "high" : highest === 1 ? "medium" : "low"
}

function deriveControls(manifest: PluginManifest, surfaces: ProfileSurfaces): ProfileControl[] {
  const tiers = manifest.capabilities.map((cap) => getCapability(cap.id)?.tier)
  const tools = manifest.contributes.tools ?? []
  const controls: ProfileControl[] = []
  if (tiers.some((tier) => tier === "consent" || tier === "elevated")) controls.push("revoke")
  if (surfaces.credentials) controls.push("disconnect")
  if (surfaces.background) controls.push("pause-background")
  const needsApproval =
    tiers.some((tier) => tier === "elevated") ||
    tools.some(
      (tool) => tool.annotations?.destructiveHint === true || tool.annotations?.requiresConfirmation === true
    )
  if (needsApproval) controls.push("approval-required")
  controls.push("audit")
  return controls
}

export function derivePluginProfile(input: DeriveProfileInput): PluginCapabilityProfile {
  const { manifest } = input
  const surfaces = deriveSurfaces(manifest)
  return {
    riskLevel: deriveRiskLevel(manifest),
    surfaces,
    summaries: [], // Task 2
    warnings: [], // Task 2
    controls: deriveControls(manifest, surfaces),
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- packages/plugin-manifest/src/profile.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add packages/plugin-manifest/src/profile.ts packages/plugin-manifest/src/profile.test.ts
git commit -m "feat(plugin-manifest): derive plugin capability profile surfaces/risk/controls"
```

---

## Task 2: profile.ts — summaries / warnings（ProfileLine）

**Files:**

- Modify: `packages/plugin-manifest/src/profile.ts`
- Test: `packages/plugin-manifest/src/profile.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `profile.test.ts` 末尾追加：

```ts
describe("derivePluginProfile — summaries/warnings", () => {
  it("emits brokered-credential summary and writeback warning for github-inbox", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("github-inbox") })
    const codes = profile.summaries.map((line) => line.code)
    expect(codes).toContain("profile.summary.cloud")
    expect(codes).toContain("profile.summary.credentialsBrokered")
    expect(profile.warnings.map((line) => line.code)).toContain("profile.warning.remoteWriteback")
    const cloud = profile.summaries.find((line) => line.code === "profile.summary.cloud")
    expect(cloud?.params?.hosts).toBe("api.github.com")
  })

  it("emits local-write warning for downloads-organizer", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("downloads-organizer") })
    expect(profile.warnings.map((line) => line.code)).toContain("profile.warning.localWrite")
  })

  it("warns on unknown capability", () => {
    const manifest = loadFixture("downloads-organizer")
    const mutated = { ...manifest, capabilities: [{ id: "future:teleport" }] }
    const profile = derivePluginProfile({ manifest: mutated })
    expect(profile.warnings.map((line) => line.code)).toContain("profile.warning.unknownCapability")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- packages/plugin-manifest/src/profile.test.ts`
Expected: FAIL（summaries/warnings 仍为空数组）

- [ ] **Step 3: 实现 summaries/warnings**

在 `profile.ts` 中新增辅助并替换 `derivePluginProfile` 里的 `summaries`/`warnings` 占位：

```ts
/** 安全提取 network:https 声明里的 hosts 字符串（scope 形状对本包不透明）。 */
function networkHosts(manifest: PluginManifest): string | undefined {
  const cap = manifest.capabilities.find((entry) => entry.id === "network:https")
  const scope = cap?.scope as { hosts?: unknown } | undefined
  if (!scope || !Array.isArray(scope.hosts)) return undefined
  const hosts = scope.hosts.filter((host): host is string => typeof host === "string")
  return hosts.length > 0 ? hosts.join(", ") : undefined
}

function deriveSummaries(manifest: PluginManifest, surfaces: ProfileSurfaces): ProfileLine[] {
  const lines: ProfileLine[] = []
  if (surfaces.cloudAccess) {
    const hosts = networkHosts(manifest)
    lines.push({ code: "profile.summary.cloud", params: hosts ? { hosts } : undefined })
  }
  if (surfaces.credentials) lines.push({ code: "profile.summary.credentialsBrokered" })
  if (surfaces.background) lines.push({ code: "profile.summary.background" })
  if (surfaces.localFileRead) lines.push({ code: "profile.summary.localRead" })
  if (surfaces.agentCallable) {
    lines.push({
      code: "profile.summary.agentCallable",
      params: { count: manifest.contributes.tools?.length ?? 0 },
    })
  }
  return lines
}

function deriveWarnings(
  manifest: PluginManifest,
  surfaces: ProfileSurfaces,
  controls: ProfileControl[]
): ProfileLine[] {
  const lines: ProfileLine[] = []
  if (surfaces.remoteWriteback) lines.push({ code: "profile.warning.remoteWriteback" })
  if (surfaces.localFileWrite) lines.push({ code: "profile.warning.localWrite" })
  if (controls.includes("approval-required")) lines.push({ code: "profile.warning.approvalRequired" })
  if (hasUnknownCapability(manifest)) lines.push({ code: "profile.warning.unknownCapability" })
  return lines
}
```

并把 `derivePluginProfile` 返回值改为：

```ts
export function derivePluginProfile(input: DeriveProfileInput): PluginCapabilityProfile {
  const { manifest } = input
  const surfaces = deriveSurfaces(manifest)
  const controls = deriveControls(manifest, surfaces)
  return {
    riskLevel: deriveRiskLevel(manifest),
    surfaces,
    summaries: deriveSummaries(manifest, surfaces),
    warnings: deriveWarnings(manifest, surfaces, controls),
    controls,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- packages/plugin-manifest/src/profile.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add packages/plugin-manifest/src/profile.ts packages/plugin-manifest/src/profile.test.ts
git commit -m "feat(plugin-manifest): add profile summaries and warnings"
```

---

## Task 3: profileToAgentText — agent 英文化

**Files:**

- Modify: `packages/plugin-manifest/src/profile.ts`
- Test: `packages/plugin-manifest/src/profile.test.ts`

- [ ] **Step 1: 追加失败测试**

```ts
import { derivePluginProfile, profileToAgentText } from "./profile"
// ...（已 import derivePluginProfile，补 profileToAgentText 到同一行）

describe("profileToAgentText", () => {
  it("renders an English one-liner the model can read", () => {
    const profile = derivePluginProfile({ manifest: loadFixture("github-inbox") })
    const text = profileToAgentText(profile)
    expect(text).toContain("risk: high")
    expect(text).toContain("connects to the internet")
    expect(text).toContain("credentials are held by Synapse")
    expect(text).toContain("can write back to remote services (requires user approval)")
    expect(text).toContain("Controls: revoke, disconnect, pause-background, approval-required, audit")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- packages/plugin-manifest/src/profile.test.ts`
Expected: FAIL（`profileToAgentText` 未导出）

- [ ] **Step 3: 实现**

在 `profile.ts` 末尾：

```ts
export function profileToAgentText(profile: PluginCapabilityProfile): string {
  const facts: string[] = []
  if (profile.surfaces.cloudAccess) facts.push("connects to the internet")
  if (profile.surfaces.credentials) {
    facts.push("credentials are held by Synapse and not readable by the plugin")
  }
  if (profile.surfaces.remoteWriteback) {
    facts.push(
      profile.controls.includes("approval-required")
        ? "can write back to remote services (requires user approval)"
        : "can write back to remote services"
    )
  }
  if (profile.surfaces.background) facts.push("runs in the background")
  if (profile.surfaces.localFileRead) facts.push("reads local files")
  if (profile.surfaces.localFileWrite) facts.push("writes local files")
  if (profile.surfaces.osIntegration) facts.push("integrates with the OS")
  const body = facts.length > 0 ? facts.join("; ") : "no sensitive capabilities"
  return `Plugin capability profile (risk: ${profile.riskLevel}): ${body}. Controls: ${profile.controls.join(", ")}.`
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- packages/plugin-manifest/src/profile.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/plugin-manifest/src/profile.ts packages/plugin-manifest/src/profile.test.ts
git commit -m "feat(plugin-manifest): add profileToAgentText English serializer"
```

---

## Task 4: 从包入口导出 profile API

**Files:**

- Modify: `packages/plugin-manifest/src/index.ts`

- [ ] **Step 1: 追加导出**

在 [`index.ts`](../../../packages/plugin-manifest/src/index.ts) 的 `./schema` 导出附近追加：

```ts
export { derivePluginProfile, profileToAgentText } from "./profile"
export type {
  DeriveProfileInput,
  PluginCapabilityProfile,
  ProfileControl,
  ProfileLine,
  ProfileSurfaces,
  RiskLevel,
} from "./profile"
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: PASS（无新错误）

- [ ] **Step 3: 提交**

```bash
git add packages/plugin-manifest/src/index.ts
git commit -m "feat(plugin-manifest): export plugin capability profile API"
```

---

## Task 5: 主进程 IPC — getCapabilityProfile

**Files:**

- Modify: `src/main/ipc/capabilities.ts`
- Test: `src/main/ipc/capabilities.test.ts`

- [ ] **Step 1: 追加失败测试**

在 [`capabilities.test.ts`](../../../src/main/ipc/capabilities.test.ts) 中新增（沿用该文件已有的 host fake 构造方式——参考文件内 `listPluginCapabilities` 的现有用例如何 mock `getHost`）：

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseManifest } from "@synapse/plugin-manifest"

function ghManifest() {
  const path = join(__dirname, "../../../resources/builtin-plugins/github-inbox/synapse.json")
  return parseManifest(JSON.parse(readFileSync(path, "utf8")))
}

it("getCapabilityProfile returns the derived profile with grant state", async () => {
  const manifest = ghManifest()
  const host = {
    get: () => ({ manifest, source: { kind: "builtin" } }),
    grants: { isGranted: async () => true },
  }
  const service = new CapabilityIpcService(() => host as never, {
    sendGrantRequest: () => {},
    sendApprovalRequest: () => {},
  })
  const profile = await service.getCapabilityProfile("com.synapse.github-inbox")
  expect(profile.riskLevel).toBe("high")
  expect(profile.surfaces.remoteWriteback).toBe(true)
})
```

> 注：若 `capabilities.test.ts` 已有共享的 host fake 工厂，复用它并补上 `get`/`grants.isGranted`，不要新建重复 fake。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/main/ipc/capabilities.test.ts`
Expected: FAIL（`getCapabilityProfile` 不存在）

- [ ] **Step 3: 实现**

在 `capabilities.ts` 顶部 import 补充：

```ts
import type { PluginCapabilityProfile } from "@synapse/plugin-manifest"
import { derivePluginProfile, getCapability } from "@synapse/plugin-manifest"
```

在 `CapabilityIpcService` 类内、`listPluginCapabilities` 之后新增：

```ts
async getCapabilityProfile(pluginId: string): Promise<PluginCapabilityProfile> {
  const entry = this.getHost().get(pluginId)
  if (!entry?.manifest) throw new Error(`Plugin not found: ${pluginId}`)

  const identity = buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
  const granted = new Set<string>()
  for (const { id } of entry.manifest.capabilities) {
    if (getCapability(id) && (await this.getHost().grants.isGranted(identity, id))) {
      granted.add(id)
    }
  }
  return derivePluginProfile({ manifest: entry.manifest, grantedCapabilityIds: granted })
}
```

在 `CapabilityIpcHandlers` 接口与 `createCapabilityIpcHandlers` 中加入 `getProfile`：

```ts
// 接口里：
getProfile: (pluginId: unknown) => Promise<PluginCapabilityProfile>
// createCapabilityIpcHandlers 返回对象里：
getProfile: (pluginId) => service.getCapabilityProfile(requireString(pluginId, "pluginId")),
```

在 `registerCapabilitiesIpc` 中注册：

```ts
ipcMain.handle("capabilities:profile", (event, pluginId: unknown) =>
  invokePluginIpcHandler(
    "capabilities:profile",
    event,
    () => handlers.getProfile(pluginId),
    options.isTrustedSender
  )
)
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/main/ipc/capabilities.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/capabilities.ts src/main/ipc/capabilities.test.ts
git commit -m "feat(ipc): expose capabilities:profile derived plugin capability profile"
```

---

## Task 6: preload + renderer electron.ts 包装

**Files:**

- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

- [ ] **Step 1: preload 暴露**

在 [`src/preload/index.ts`](../../../src/preload/index.ts) 中，找到既有 `capabilities` 相关暴露（`listPluginCapabilities` 走的 `capabilities:list`），在同一对象里追加：

```ts
getCapabilityProfile: (pluginId: string) => ipcRenderer.invoke("capabilities:profile", pluginId),
```

- [ ] **Step 2: preload 类型**

在 [`src/preload/index.d.ts`](../../../src/preload/index.d.ts) 对应接口里追加（类型从包导入，与既有 capability 行为一致）：

```ts
getCapabilityProfile: (pluginId: string) => Promise<import("@synapse/plugin-manifest").PluginCapabilityProfile>
```

- [ ] **Step 3: renderer 包装**

在 [`src/renderer/src/lib/electron.ts`](../../../src/renderer/src/lib/electron.ts) 中，参照既有 `listPluginCapabilities` 导出，新增：

```ts
import type { PluginCapabilityProfile } from "@synapse/plugin-manifest"

export type { PluginCapabilityProfile } from "@synapse/plugin-manifest"

export async function getPluginCapabilityProfile(
  pluginId: string
): Promise<PluginCapabilityProfile> {
  return window.electronAPI.getCapabilityProfile(pluginId)
}
```

> 若 `window.electronAPI` 的属性命名在该文件用了别的访问封装，对齐既有 `listPluginCapabilities` 的写法即可。

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(preload): wire getCapabilityProfile through preload and renderer"
```

---

## Task 7: renderer 画像卡组件

**Files:**

- Create: `src/renderer/src/components/plugins/plugin-capability-profile.tsx`
- Test: `src/renderer/src/components/plugins/plugin-capability-profile.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import type { PluginCapabilityProfile } from "@/lib/electron"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PluginCapabilityProfileCard } from "./plugin-capability-profile"

const profile: PluginCapabilityProfile = {
  riskLevel: "high",
  surfaces: {
    cloudAccess: true,
    credentials: true,
    remoteWriteback: true,
    background: true,
    localFileRead: false,
    localFileWrite: false,
    osIntegration: false,
    agentCallable: true,
  },
  summaries: [{ code: "profile.summary.cloud", params: { hosts: "api.github.com" } }],
  warnings: [{ code: "profile.warning.remoteWriteback" }],
  controls: ["revoke", "disconnect", "pause-background", "approval-required", "audit"],
}

describe("PluginCapabilityProfileCard", () => {
  it("renders risk badge, summaries and warnings", () => {
    render(<PluginCapabilityProfileCard profile={profile} />)
    expect(screen.getByTestId("profile-risk")).toHaveTextContent(/high/i)
    expect(screen.getByTestId("profile-summaries")).toBeInTheDocument()
    expect(screen.getByTestId("profile-warnings")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/renderer/src/components/plugins/plugin-capability-profile.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

```tsx
import type { PluginCapabilityProfile, ProfileLine } from "@/lib/electron"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const RISK_VARIANT: Record<PluginCapabilityProfile["riskLevel"], string> = {
  low: "bg-emerald-500/15 text-emerald-600",
  medium: "bg-amber-500/15 text-amber-600",
  high: "bg-red-500/15 text-red-600",
}

export function PluginCapabilityProfileCard({
  className,
  profile,
}: {
  className?: string
  profile: PluginCapabilityProfile
}) {
  const { t } = useTranslation()
  const line = (item: ProfileLine) =>
    t(item.code, { defaultValue: item.code, nsSeparator: false, ...item.params })

  return (
    <div className={cn("space-y-3 rounded-md border border-border/60 p-3", className)}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{t("profile.title", { defaultValue: "Capabilities" })}</span>
        <Badge
          data-testid="profile-risk"
          className={cn("font-normal capitalize", RISK_VARIANT[profile.riskLevel])}
        >
          {t(`profile.risk.${profile.riskLevel}`, { defaultValue: profile.riskLevel })}
        </Badge>
      </div>

      {profile.summaries.length > 0 ? (
        <ul data-testid="profile-summaries" className="space-y-1 text-sm text-muted-foreground">
          {profile.summaries.map((item) => (
            <li key={item.code}>{line(item)}</li>
          ))}
        </ul>
      ) : null}

      {profile.warnings.length > 0 ? (
        <ul data-testid="profile-warnings" className="space-y-1 text-sm text-amber-600">
          {profile.warnings.map((item) => (
            <li key={item.code}>⚠ {line(item)}</li>
          ))}
        </ul>
      ) : null}

      {profile.controls.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {profile.controls.map((control) => (
            <Badge key={control} variant="outline" className="font-normal">
              {t(`profile.control.${control}`, { defaultValue: control })}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/renderer/src/components/plugins/plugin-capability-profile.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/plugins/plugin-capability-profile.tsx src/renderer/src/components/plugins/plugin-capability-profile.test.tsx
git commit -m "feat(renderer): add plugin capability profile card"
```

---

## Task 8: i18n 文案

**Files:**

- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`

- [ ] **Step 1: 加 en.json key**

在 `en.json` 顶层加入 `profile` 命名空间（若已有同名键则合并）：

```json
"profile": {
  "title": "Capabilities",
  "risk": { "low": "Low risk", "medium": "Medium risk", "high": "High risk" },
  "summary": {
    "cloud": "Connects to {{hosts}}",
    "credentialsBrokered": "Credentials are held by Synapse; the plugin cannot read your token",
    "background": "Runs in the background",
    "localRead": "Reads local files you scope",
    "agentCallable": "Exposes {{count}} tool(s) the agent can call"
  },
  "warning": {
    "remoteWriteback": "Can write back to remote services; writeback requires your confirmation",
    "localWrite": "Can write to local files in the folders you allow",
    "approvalRequired": "High-risk actions require per-call approval",
    "unknownCapability": "Declares a capability this version does not recognize"
  },
  "control": {
    "revoke": "Revocable",
    "disconnect": "Disconnect credentials",
    "pause-background": "Pause background",
    "approval-required": "Approval required",
    "audit": "Audited"
  }
}
```

- [ ] **Step 2: 加 zh-CN.json key**

```json
"profile": {
  "title": "能力",
  "risk": { "low": "低风险", "medium": "中风险", "high": "高风险" },
  "summary": {
    "cloud": "连接 {{hosts}}",
    "credentialsBrokered": "凭证由 Synapse 保管，插件读不到你的 token",
    "background": "在后台运行",
    "localRead": "读取你授权范围内的本地文件",
    "agentCallable": "向 agent 暴露 {{count}} 个可调用工具"
  },
  "warning": {
    "remoteWriteback": "可写回远端服务；写回需你确认",
    "localWrite": "可在你允许的目录内写入本地文件",
    "approvalRequired": "高危动作需逐次确认",
    "unknownCapability": "声明了当前版本不识别的能力"
  },
  "control": {
    "revoke": "可撤销",
    "disconnect": "断开凭证",
    "pause-background": "暂停后台",
    "approval-required": "需确认",
    "audit": "可审计"
  }
}
```

- [ ] **Step 3: 验证 JSON 合法 + 测试**

Run: `pnpm test -- src/renderer/src/components/plugins/plugin-capability-profile.test.tsx`
Expected: PASS（i18n key 现在落地）

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/i18n/messages/en.json src/renderer/src/i18n/messages/zh-CN.json
git commit -m "feat(i18n): add plugin capability profile strings"
```

---

## Task 9: 在已装插件页与 marketplace 页渲染画像卡

**Files:**

- Modify: `src/renderer/src/components/pages/plugins-page.tsx`
- Modify: `src/renderer/src/components/pages/marketplace-page.tsx`

- [ ] **Step 1: plugins-page 拉取并渲染**

在 [`plugins-page.tsx`](../../../src/renderer/src/components/pages/plugins-page.tsx) 里，参照其加载单插件详情的现有逻辑，新增按 `pluginId` 拉 profile 并在详情区渲染卡片。新增一个小 hook 内联即可：

```tsx
import { useEffect, useState } from "react"
import { getPluginCapabilityProfile, type PluginCapabilityProfile } from "@/lib/electron"
import { PluginCapabilityProfileCard } from "@/components/plugins/plugin-capability-profile"

function useCapabilityProfile(pluginId: string | undefined) {
  const [profile, setProfile] = useState<PluginCapabilityProfile | null>(null)
  useEffect(() => {
    if (!pluginId) {
      setProfile(null)
      return
    }
    let alive = true
    void getPluginCapabilityProfile(pluginId)
      .then((value) => alive && setProfile(value))
      .catch(() => alive && setProfile(null))
    return () => {
      alive = false
    }
  }, [pluginId])
  return profile
}
```

在选中插件的详情 JSX 中（紧邻现有 `PluginCapabilityList` / `PermissionTagList` 处）插入：

```tsx
{profile ? <PluginCapabilityProfileCard profile={profile} className="mt-3" /> : null}
```

其中 `const profile = useCapabilityProfile(selectedPluginId)`（变量名对齐该页对"当前选中插件 id"的既有命名）。

- [ ] **Step 2: marketplace-page 同样渲染**

在 [`marketplace-page.tsx`](../../../src/renderer/src/components/pages/marketplace-page.tsx) 的插件详情区，复用同一 `useCapabilityProfile` + `PluginCapabilityProfileCard`。若 marketplace 列表项尚未安装、拿不到 host 端 manifest，则 `getPluginCapabilityProfile` 会抛错 → catch 后 `profile` 为 null，卡片不渲染（优雅降级，保留既有 permission tags）。

- [ ] **Step 3: 运行相关页测试**

Run: `pnpm test -- src/renderer/src/components/pages/plugins-page.test.tsx src/renderer/src/components/pages/marketplace-page.test.tsx`
Expected: PASS（既有用例不回归；若用例对 `window.electronAPI` 做了完整 mock，需在 mock 里补 `getCapabilityProfile: vi.fn().mockResolvedValue(null as never)` 之类——按该测试文件既有 mock 风格补齐）

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/components/pages/plugins-page.tsx src/renderer/src/components/pages/marketplace-page.tsx
git commit -m "feat(renderer): show capability profile on plugins and marketplace pages"
```

---

## Task 10: 启用确认流程展示画像

**Files:**

- Modify: capability-prompt 启用确认组件（[`src/renderer/src/components/capability-prompt-host.tsx`](../../../src/renderer/src/components/capability-prompt-host.tsx)）

- [ ] **Step 1: 在启用/授权确认 UI 中插入画像卡**

定位 capability-prompt-host 中渲染"启用某插件需授权"提示的分支（它已有 `pluginId`）。复用 Task 9 的 `useCapabilityProfile(pluginId)`（提取为共享 hook：新建 `src/renderer/src/hooks/use-capability-profile.ts` 导出该 hook，Task 9 的两页改为 import 它，避免重复）。

新建 `src/renderer/src/hooks/use-capability-profile.ts`：

```ts
import { useEffect, useState } from "react"
import { getPluginCapabilityProfile, type PluginCapabilityProfile } from "@/lib/electron"

export function useCapabilityProfile(pluginId: string | undefined): PluginCapabilityProfile | null {
  const [profile, setProfile] = useState<PluginCapabilityProfile | null>(null)
  useEffect(() => {
    if (!pluginId) {
      setProfile(null)
      return
    }
    let alive = true
    void getPluginCapabilityProfile(pluginId)
      .then((value) => alive && setProfile(value))
      .catch(() => alive && setProfile(null))
    return () => {
      alive = false
    }
  }, [pluginId])
  return profile
}
```

把 Task 9 两页内联的 `useCapabilityProfile` 删除、改为 `import { useCapabilityProfile } from "@/hooks/use-capability-profile"`。在 capability-prompt 授权确认区渲染 `<PluginCapabilityProfileCard profile={profile} />`（profile 非空时）。

- [ ] **Step 2: 运行测试**

Run: `pnpm test -- src/renderer/src/components/capability-prompt-host.test.tsx`
Expected: PASS（若该文件有测试；无则跑 `pnpm typecheck`）

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/hooks/use-capability-profile.ts src/renderer/src/components/capability-prompt-host.tsx src/renderer/src/components/pages/plugins-page.tsx src/renderer/src/components/pages/marketplace-page.tsx
git commit -m "feat(renderer): show capability profile at enable confirmation"
```

---

## Task 11: agent 工具清单 note

**Files:**

- Modify: `src/main/ai/tool-registry.ts`
- Test: `src/main/ai/tool-registry.test.ts`

- [ ] **Step 1: 追加失败测试**

在 [`tool-registry.test.ts`](../../../src/main/ai/tool-registry.test.ts) 中（复用文件内既有的 fake host 构造）：

```ts
it("prepends a plugin capability note to tool descriptions when a provider is given", () => {
  const host = {
    listTools: () => [
      {
        fqName: "com.example.demo/greet",
        pluginId: "com.example.demo",
        manifestTool: { name: "greet", description: "Say hi.", inputSchema: { type: "object" } },
      },
    ],
    invokeTool: async () => ({ content: [] }),
  }
  const registry = new AiToolRegistry(host as never, (pluginId) =>
    pluginId === "com.example.demo" ? "Capability note." : undefined
  )
  const [schema] = registry.list()
  expect(schema.description).toBe("Capability note.\n\nSay hi.")
})

it("leaves descriptions unchanged when no provider is given", () => {
  const host = {
    listTools: () => [
      {
        fqName: "memory:core/memory_list",
        pluginId: "memory:core",
        manifestTool: { name: "memory_list", description: "List.", inputSchema: { type: "object" } },
      },
    ],
    invokeTool: async () => ({ content: [] }),
  }
  const [schema] = new AiToolRegistry(host as never).list()
  expect(schema.description).toBe("List.")
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/main/ai/tool-registry.test.ts`
Expected: FAIL（构造函数第二参数未支持）

- [ ] **Step 3: 实现**

修改 `AiToolRegistry`：

```ts
export class AiToolRegistry {
  private safeToDescriptor = new Map<string, RegisteredToolDescriptor>()

  constructor(
    private readonly host: ToolHostPort,
    /** 可选：返回某插件的 agent 可读能力 note，前置到该插件每个工具的描述。 */
    private readonly pluginNote?: (pluginId: string) => string | undefined
  ) {}
```

在 `refresh()` 里，把构造 schema 的 `description` 改为：

```ts
const note = this.pluginNote?.(descriptor.pluginId)
const description = note
  ? `${note}\n\n${descriptor.manifestTool.description}`
  : descriptor.manifestTool.description
// ...
schema: {
  name: safeName,
  description,
  inputSchema: descriptor.manifestTool.inputSchema,
},
```

> note provider 每次 `refresh()` 会对同一 pluginId 多次调用（每工具一次）。这是廉价的纯函数（在 index.ts 装配时会做 per-refresh 记忆化，见 Task 13），此处保持无状态。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/main/ai/tool-registry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/tool-registry.ts src/main/ai/tool-registry.test.ts
git commit -m "feat(ai): prepend plugin capability note to agent tool descriptions"
```

---

## Task 12: describe_plugin 元工具源

**Files:**

- Create: `src/main/ai/plugin-introspection-tools.ts`
- Test: `src/main/ai/plugin-introspection-tools.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest"
import { PLUGIN_INTROSPECT_PREFIX, PluginIntrospectionToolSource } from "./plugin-introspection-tools"

const profile = {
  riskLevel: "high" as const,
  surfaces: {
    cloudAccess: true,
    credentials: true,
    remoteWriteback: true,
    background: true,
    localFileRead: false,
    localFileWrite: false,
    osIntegration: false,
    agentCallable: true,
  },
  summaries: [],
  warnings: [],
  controls: ["revoke", "audit"] as const,
}

describe("PluginIntrospectionToolSource", () => {
  it("owns its namespace and lists describe_plugin", () => {
    const source = new PluginIntrospectionToolSource(async () => profile)
    expect(source.ownsTool(`${PLUGIN_INTROSPECT_PREFIX}describe_plugin`)).toBe(true)
    expect(source.ownsTool("com.x/y")).toBe(false)
    expect(source.listTools().map((tool) => tool.manifestTool.name)).toEqual(["describe_plugin"])
  })

  it("returns the resolved profile as json", async () => {
    const source = new PluginIntrospectionToolSource(async () => profile)
    const result = await source.invokeTool(`${PLUGIN_INTROSPECT_PREFIX}describe_plugin`, {
      pluginId: "com.synapse.github-inbox",
    })
    expect(result.structured).toMatchObject({ riskLevel: "high" })
  })

  it("errors when the plugin is unknown", async () => {
    const source = new PluginIntrospectionToolSource(async () => undefined)
    const result = await source.invokeTool(`${PLUGIN_INTROSPECT_PREFIX}describe_plugin`, {
      pluginId: "nope",
    })
    expect(result.isError).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/main/ai/plugin-introspection-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
import type { PluginCapabilityProfile } from "@synapse/plugin-manifest"
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor } from "../plugins/types"
import type { ToolHostSource } from "./composite-tool-host"

// Built-in introspection tool exposed to the agent as a ToolHostSource. Lets the
// model pull a plugin's full capability profile (risk, surfaces, controls) to
// decide whether/how to use it — the agent half of the capability profile work.

export const PLUGIN_INTROSPECT_PREFIX = "synapse:introspect/"
const INTROSPECT_PLUGIN_ID = "synapse:introspect"

/** Resolve a plugin's profile (grant-aware) by id, or undefined if unknown. */
export type ProfileResolver = (pluginId: string) => Promise<PluginCapabilityProfile | undefined>

const TOOLS: RegisteredToolDescriptor[] = [
  {
    fqName: `${INTROSPECT_PLUGIN_ID}/describe_plugin`,
    pluginId: INTROSPECT_PLUGIN_ID,
    manifestTool: {
      name: "describe_plugin",
      title: "Describe plugin",
      description:
        "Return the capability profile of an installed plugin: risk level, what it touches (cloud, credentials, remote writeback, background, local files), and how it is governed (revoke, approval-required, audit). Call before using an unfamiliar plugin's tools to understand its risk and approval boundaries.",
      inputSchema: {
        type: "object",
        properties: { pluginId: { type: "string", description: "The plugin id to describe." } },
        required: ["pluginId"],
      },
      annotations: { readOnlyHint: true },
    },
  },
]

export class PluginIntrospectionToolSource implements ToolHostSource {
  constructor(private readonly resolveProfile: ProfileResolver) {}

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(PLUGIN_INTROSPECT_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return TOOLS
  }

  async invokeTool(fqName: string, input: unknown): Promise<ToolResult> {
    if (fqName !== `${INTROSPECT_PLUGIN_ID}/describe_plugin`) {
      return errorResult(`Unknown tool: ${fqName}`)
    }
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
    if (typeof args.pluginId !== "string" || !args.pluginId.trim()) {
      return errorResult("pluginId is required.")
    }
    try {
      const profile = await this.resolveProfile(args.pluginId.trim())
      if (!profile) return errorResult(`Plugin not found: ${args.pluginId}`)
      return { content: [{ type: "json", json: profile }], structured: profile }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/main/ai/plugin-introspection-tools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/plugin-introspection-tools.ts src/main/ai/plugin-introspection-tools.test.ts
git commit -m "feat(ai): add describe_plugin introspection tool source"
```

---

## Task 13: 主进程装配 — note provider + introspection 源 + IPC 注册

**Files:**

- Modify: `src/main/index.ts`

> `src/main/index.ts` 是编排入口（coverage 排除，经 seam 测试）。本任务无独立单测，靠 `pnpm typecheck` + `pnpm build` + 既有 e2e 兜底。

- [ ] **Step 1: 注册 capabilities:profile IPC**

`registerCapabilitiesIpc` 已在 index.ts 调用（随 `CapabilityIpcService` 装配）。Task 5 已把新 handler 加进 `registerCapabilitiesIpc` 内部，故无需改 index.ts 的 IPC 注册——确认 `registerCapabilitiesIpc(ipcMain, capabilityIpcService, …)` 调用处无遗漏即可。

- [ ] **Step 2: 装配 agent note provider**

定位 index.ts 中 `new AiToolRegistry(` 的构造处（当前只传 host）。在其上方构造一个 per-refresh 记忆化的 note provider，并作为第二参传入：

```ts
import { derivePluginProfile, profileToAgentText } from "@synapse/plugin-manifest"

// 复用已构造的 pluginRegistry（PluginHost 的注册表，提供 get(pluginId).manifest）。
const noteCache = new Map<string, string | undefined>()
const pluginNote = (pluginId: string): string | undefined => {
  if (noteCache.has(pluginId)) return noteCache.get(pluginId)
  const entry = pluginRegistry.get(pluginId)
  const note = entry?.manifest
    ? profileToAgentText(derivePluginProfile({ manifest: entry.manifest }))
    : undefined
  noteCache.set(pluginId, note)
  return note
}
// 工具集变化时清缓存：在插件安装/卸载/重载的既有回调里调用 noteCache.clear()
```

把 `new AiToolRegistry(compositeHost)` 改为 `new AiToolRegistry(compositeHost, pluginNote)`。

> `pluginRegistry` 的实际变量名以 index.ts 中 `PluginHost`/registry 的既有命名为准（它就是 `CapabilityIpcService` 里 `getHost()` 返回、带 `get(pluginId)` 的对象）。note 用**装前静态画像**（不传 grants），因为它是给模型的能力说明，不需授权态；授权态留给 `describe_plugin`（Step 3）。

- [ ] **Step 3: 注册 describe_plugin 源到 composite host**

定位 index.ts 中构造 `CompositeToolHost` / 组装 `ToolHostSource[]`（含 `MemoryToolSource`）的位置，追加：

```ts
import { PluginIntrospectionToolSource } from "./ai/plugin-introspection-tools"

const introspectionSource = new PluginIntrospectionToolSource((pluginId) =>
  capabilityIpcService.getCapabilityProfile(pluginId).then(
    (profile) => profile,
    () => undefined
  )
)
// 加入 sources 数组（与 memoryToolSource 并列）：
//   const sources = [introspectionSource, memoryToolSource, asFallbackSource(pluginHost, claimedBy)]
// 注意：introspection/memory 这类“前缀拥有”的源要排在 fallback 源之前（fallback 用 !claimedBy 兜底）。
```

`capabilityIpcService` 是 Task 5 装配的 `CapabilityIpcService` 实例（index.ts 中已存在）。`describe_plugin` 走它 → 带授权态画像。

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: PASS（两者均无错误）

- [ ] **Step 5: 提交**

```bash
git add src/main/index.ts
git commit -m "feat(main): wire plugin capability note provider and describe_plugin source"
```

---

## Task 14: docs marketplace 详情页 server 端画像

**Files:**

- Modify: `docs/app/marketplace/[id]/page.tsx`

- [ ] **Step 1: server 端派生并渲染**

docs 是独立 Next.js workspace。在 [`[id]/page.tsx`](../../../docs/app/marketplace/[id]/page.tsx) 中，找到已加载该插件 manifest（或 marketplace 条目含 manifest/capabilities）的位置，在 server 组件里调用：

```tsx
import { derivePluginProfile } from "@synapse/plugin-manifest"

// 在已拿到 manifest 后：
const profile = derivePluginProfile({ manifest })
```

并以静态 JSX 渲染 `profile.riskLevel` 徽章 + `summaries`/`warnings`（docs 站用自身的 i18n/文案体系；可直接用 spec §4.4 的中文/英文映射，或在 docs 内置一份等价文案表，避免依赖 renderer 的 i18next）。若 docs 的 marketplace 数据源不含完整 manifest，则本任务降级为：仅展示 `capabilities` id 列表（保持现状），并在 PR 描述里记录"docs 画像需 marketplace API 暴露 manifest"作为后续。

- [ ] **Step 2: docs 构建**

Run: `pnpm docs:build`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add docs/app/marketplace/[id]/page.tsx
git commit -m "feat(docs): render capability profile on marketplace detail page"
```

---

## Task 15: 全量验证

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS（覆盖率不低于既有阈值：70% lines/statements、60% branches/functions）

- [ ] **Step 2: lint + 类型 + 格式**

Run: `pnpm lint && pnpm typecheck && pnpm format:check`
Expected: 全 PASS（如 format 失败先 `pnpm format`）

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 4: 收尾提交（若 format 有改动）**

```bash
git add -A
git commit -m "chore: format and lint plugin capability profile work"
```

---

## 验收对照（对 Spec §10）

1. ✅ marketplace / 启用确认页展示风险摘要（Task 7/9/10/14）——用户无需读 manifest。
2. ✅ agent 工具清单 note（Task 11/13）+ `describe_plugin`（Task 12/13）。
3. ✅ 人端与 agent 端同源 `derivePluginProfile`（Task 1-3，单一真相源）。
4. ✅ `github-inbox` / `downloads-organizer` 画像快照（Task 1/2 用例）。
5. ✅ 零改动既有 capability/tier/授权运行时（仅新增派生 + 读路径）。

## Self-Review 记录

- **Spec 覆盖**：§4 模型→T1-T4；§5 人端→T7/T9/T10/T14；§6 agent→T11/T12/T13；§7 边界（未知 cap/grants 缺省/降级）→T1/T2/T9；§8 测试→各任务 TDD + T15。无遗漏。
- **类型一致性**：`PluginCapabilityProfile` / `ProfileSurfaces` / `ProfileControl` / `ProfileLine` 在 T1 定义，T5/T7/T11/T12 一致引用；`derivePluginProfile({ manifest, grantedCapabilityIds? })` 入参形状全程一致；`profileToAgentText(profile)` 签名 T3 定义、T13 使用一致。
- **Placeholder 扫描**：无 TODO/TBD；renderer 接线任务（T9/T13/T14）因 index.ts/页面体量给出"定位锚点 + 完整新增代码片段"，未要求重述既有大文件，符合"在既有大文件中做聚焦改动"原则。
