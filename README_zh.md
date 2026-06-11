<p align="center">
  <img src="resources/logo.png" alt="Synapse Logo" width="120" />
</p>
<h1 align="center">Synapse</h1>

<p align="center">
  一个可扩展的桌面端平台：把 AI 智能体变成生产力主力——
  以可安装的插件作为它的「手」，以 MCP 作为连线，以插件市场作为生态。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#仓库结构">仓库结构</a> ·
  <a href="#架构">架构</a> ·
  <a href="./README.md">English</a>
</p>

---

## Synapse 是什么？

Synapse 是一个 Electron 桌面应用，围绕一个朴素的心智模型构建：

- **AI = 大脑 / 设计师。**
- **可安装的 skill = 大脑能学习的知识。**
- **Synapse 插件 = 大脑的「手」**——智能体（以及用户）可直接调用的能力。
- **市场 = 让这些「手」被生产、流通、互评的「社会」。**

落到实处，就是一个桌面底座：内置 AI 智能体、把插件能力暴露为 **MCP 工具**的沙箱化插件运行时、
加密的**局域网设备间**传输，以及一套完整的**插件市场**（后端 + Web 门户）用于发布、浏览、评分与治理。

## 核心能力

### 🧠 AI 基座

- 内置**智能体运行时**：流式对话、工具调用、单轮 token 预算
- **多厂商 BYOK**：默认 Claude，通过 provider 抽象层支持 OpenAI 及 OpenAI 兼容厂商（智谱/GLM、硅基流动、阿里百炼/Qwen）；密钥归你所有，落盘加密
- **双向 MCP**：插件工具自动暴露为 [Model Context Protocol](https://modelcontextprotocol.io) 工具；Synapse 也能作为 MCP **客户端**接入外部 server
- **长期记忆**：文档被切块、可检索地纳入记忆（RAG），MCP server 密钥加密存储

### 🧩 插件体系

- **清单 + SDK**：声明式 `synapse.json` + 面向作者的类型化 `{ commands, views, tools }` 契约
- **脚手架 & CLI**：`create-synapse-plugin` 起步，`synapse-plugin` 把项目打包成可安装的 `.syn`
- **沙箱宿主**：能力 / 权限模型、隔离执行、通向智能体的工具桥
- **本地安装**：打开或拖入 `.syn` 文件（已注册文件关联）即可安装

### 🛒 插件市场

- 自管后端（**Fastify + Drizzle + Postgres/Neon + Cloudflare R2**）——权威数据源
- **账户**：GitHub 设备授权流登录；不透明、可吊销的会话，落盘仅存哈希
- **发布**（私人或公开）、**浏览**、**下载**（短时签名 URL）、**评分与评论**、**排行**
- **治理与审核**：可见性切换、版本撤回（yank）、滥用举报、自动风险扫描、管理员审核队列、下架 / 恢复
- **Web 门户**：基于文档站的公开、可被搜索引擎索引的浏览页

### 🖥️ 桌面底座

- 全局快捷键**命令启动器**与**悬浮球**快捷入口
- 主题切换（浅色 / 深色 / 跟随系统）+ 持久化外观设置
- **中英文**国际化
- **自动更新**：应用内横幅（手动下载 / 重启流程）

### 🔐 局域网设备同步

- 基于 Bonjour 的附近设备发现，**证书固定的 HTTPS 加密文件传输**，配可校验的安全码

## 仓库结构

一个 pnpm workspace。桌面应用位于仓库根目录；共享库、市场后端、文档 / 门户位于 `packages/` 与 `docs/`。

```text
synapse/
├─ src/                              # Electron 桌面应用
│  ├─ main/                          # 主进程
│  │  ├─ ai/                         # 智能体运行时、provider、MCP 客户端、记忆
│  │  ├─ mcp/                        # Synapse 作为 MCP server
│  │  ├─ plugins/                    # 插件宿主、沙箱、权限、工具桥
│  │  ├─ marketplace/                # 桌面端账户登录 + 加密 token 存储
│  │  ├─ lan/                        # Bonjour 发现 + 固定 HTTPS 传输
│  │  ├─ launcher/  settings/  updates/  protocol/  ipc/
│  ├─ preload/                       # contextBridge API + 渲染端可见类型
│  └─ renderer/                      # React SPA（主页、对话、启动器、插件、市场、局域网、设置）
│
├─ packages/
│  ├─ plugin-manifest/               # synapse.json schema、校验、引擎兼容
│  ├─ plugin-sdk/                    # 面向作者的命令 + 视图 + 工具契约
│  ├─ plugin-cli/                    # 把插件项目打包成 .syn；登录 / 发布
│  ├─ create-synapse-plugin/         # 项目脚手架
│  ├─ marketplace-types/             # 共享 zod schema + 推断类型（服务端/CLI/桌面/门户）
│  └─ marketplace-server/            # Fastify + Drizzle 市场后端
│
├─ docs/                             # Fumadocs 站点 + 公开市场 Web 门户
└─ resources/                        # 图标与 electron-builder 资源
```

## 架构

**进程模型。** electron-vite 在 `out/` 产出三份独立 bundle——`main`、`preload`、`renderer`。
渲染端是主进程加载的 Vite React SPA；没有 Web 回退，因此始终假定运行在 Electron 中，
通过 IPC 完成 OS 级工作。

**类型化 IPC。** 每个跨进程调用都遵循四段式：纯处理函数 → 主进程注册 →
`preload` 的 `contextBridge` 暴露 → 渲染端类型化封装。发送方会被校验，载荷在边界处检查。

**安全基线。** 自定义的 `standard`+`secure` `app://` 协议承载渲染端，并对每个响应施加严格 CSP。
密钥（AI provider key、市场会话 token、MCP server 的 env / headers）经 Electron `safeStorage`
用系统钥匙串加密落盘，且永不进入渲染端。

**市场契约。** `@synapse/marketplace-types` 是单一数据源——带 `z.infer` 类型的 zod schema，
由后端、CLI、桌面应用与 Web 门户共享。后端完全依赖注入（db、对象存储、身份 provider、时钟），
因此测试可跑在进程内 Postgres（PGlite/WASM）上，无需任何真实凭据。

## 技术栈

| 领域        | 工具                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| 桌面        | Electron 33 · electron-vite · electron-builder · electron-updater                 |
| UI          | React 19 · TypeScript 5(strict) · Tailwind CSS v4 · shadcn/ui · Zustand · i18next |
| AI          | `@anthropic-ai/sdk` · `openai` · `@modelcontextprotocol/sdk`                      |
| 后端        | Fastify 5 · Drizzle ORM · Postgres(Neon) · Cloudflare R2(S3) · zod                |
| 门户 / 文档 | Next.js · Fumadocs                                                                |
| 工具链      | pnpm workspaces · Vitest · Testing Library · ESLint · Prettier · Husky            |

## 快速开始

**环境要求：** Node.js 22.13+ 与 pnpm 11.x。

```bash
pnpm install            # 安装所有 workspace 依赖
pnpm dev                # 启动桌面应用（渲染端 Vite HMR + main/preload 热重启）
```

### 运行市场后端（可选）

仅当你想在本地跑通真实的发布 / 浏览 / 评分流程时才需要。测试无需任何凭据（进程内 PGlite）。

```bash
cp packages/marketplace-server/.env.example packages/marketplace-server/.env
# 填入 DATABASE_URL + GITHUB_CLIENT_ID/SECRET（R2 变量可选 → 缺省回退到内存存储）
pnpm -F @synapse/marketplace-server dev
```

### 浏览市场 Web 门户

```bash
pnpm docs:dev           # 提供文档站 + /marketplace 门户（端口 3001）
```

用 `MARKETPLACE_URL` 指向后端（默认 `http://localhost:8787`）。

### 局域网传输模拟

在单机上验证设备间传输：在两个终端分别启动两个隔离实例。

```bash
pnpm dev:lan:a          # 显示为 “Synapse Sim A”
pnpm dev:lan:b          # 显示为 “Synapse Sim B”
```

每个实例使用独立的开发专用 profile（身份、证书、受信设备、设置、传输）。在两个窗口都开启附近设备发现，
连接后比对安全码即可。

## 开发一个插件

```bash
pnpm dlx create-synapse-plugin my-plugin   # 脚手架
cd my-plugin
pnpm synapse-plugin build                  # → my-plugin-<version>.syn
pnpm synapse-plugin login                  # 设备流登录市场
pnpm synapse-plugin publish                # 发布（默认私人）
```

本地安装：在桌面应用的「插件」页打开一个 `.syn` 文件即可。

## 脚本

```bash
# 桌面应用
pnpm dev                # Electron 开发模式
pnpm build              # 先构建 workspace 包，再构建 main/preload/renderer → out/
pnpm preview            # 预览生产构建
pnpm electron:build     # 打包当前平台（electron-builder）
pnpm electron:build:win # Windows：NSIS + MSI（另有 :mac / :linux）

# 质量
pnpm lint               # ESLint            （pnpm lint:fix 自动修复）
pnpm format:check       # Prettier          （pnpm format 写入）
pnpm typecheck          # 类型检查 packages + node(main/preload) + web(renderer)
pnpm test               # Vitest            （pnpm test:watch / pnpm test:coverage）

# 市场后端 & 文档
pnpm -F @synapse/marketplace-server dev
pnpm docs:dev           # 文档站 + Web 门户（端口 3001）
```

## 提交前校验

提交前在本地跑完整检查——与 CI 一致：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

> CI（GitHub Actions）在每个指向 `main` 的 PR 上运行同样的质量门、带覆盖率的测试套件，
> 以及 Windows、macOS（x64 + arm64）、Linux 的未签名 Electron 构建。

## 资源

所有产品图标——应用图标（`icon.png`、`icon.ico`、`icon.icns`）、系统托盘图标
（`tray.png`、`tray@2x.png`、`tray@3x.png`）与通知图标——都由主 logo
[`resources/logo.png`](resources/logo.png) 生成。更换该文件后重跑生成器即可：

```bash
pnpm icons
```

## 文档

- [贡献指南](./CONTRIBUTING.md)
- [测试指南](./TESTING.md)
- [CI/CD 指南](./CI_CD.md)
- 设计文档：[`design/`](./design)——AI 基座、AI 增强、市场与用户方案

## 许可证

MIT
