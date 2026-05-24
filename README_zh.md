<p align="center">
  <img src="resources/logo.svg" alt="DesKit Logo" width="120" />
</p>
<h1 align="center">DesKit</h1>

DesKit 是一个基于 Electron、React 和 electron-vite 构建的可扩展桌面端提效工具箱。

它提供安全的桌面应用底座，用于承载命令启动、轻量工具、桌面悬浮交互和插件化工作流。

## 特性

- main / preload / renderer 分离的 Electron 桌面应用结构
- 基于 `contextBridge` 的类型化 IPC 边界
- 自定义 `app://` 协议和严格 CSP 基线
- React 渲染端、Tailwind CSS 和 shadcn/ui
- 中英文国际化基础
- 基于 Vitest 的单元测试和组件测试
- electron-builder 跨平台打包配置
- Fumadocs 文档工作区

## 路线图

- 全局快捷键命令启动器
- 桌面悬浮助手
- 换肤与外观设置持久化
- 插件 manifest、registry、权限模型和 SDK
- 时间戳转换、剪贴板历史、截图等内置工具
- 可选的产品与工程文档站

## 技术栈

- Electron
- electron-vite
- Vite
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Zustand
- i18next
- Vitest
- Testing Library
- electron-builder
- Fumadocs

## 项目结构

```text
src/
├─ main/                  # Electron 主进程、CSP、app:// 协议、IPC
├─ preload/               # contextBridge API 和渲染端可见类型
└─ renderer/              # React 渲染端应用
   ├─ index.html
   └─ src/
      ├─ App.tsx
      ├─ components/
      ├─ hooks/
      ├─ i18n/
      └─ lib/

docs/                     # Fumadocs 文档站
resources/                # electron-builder 图标和资源
```

## 快速开始

环境要求：

- Node.js 22.13+
- pnpm 11.x

安装依赖：

```bash
pnpm install
```

启动桌面端开发模式：

```bash
pnpm dev
```

## 常用命令

```bash
pnpm dev                # 启动 Electron 开发模式
pnpm build              # 构建 main/preload/renderer 到 out/
pnpm preview            # 预览生产构建
pnpm lint               # 运行 ESLint
pnpm lint:fix           # 修复 ESLint 问题
pnpm format             # 使用 Prettier 格式化
pnpm format:check       # 检查 Prettier 格式
pnpm typecheck          # TypeScript 检查
pnpm typecheck:native   # tsgo native-preview 检查
pnpm test               # 运行 Vitest
pnpm test:watch         # 以 watch 模式运行 Vitest
pnpm test:coverage      # 运行测试覆盖率
pnpm electron:build     # 打包当前平台
pnpm docs:dev           # 启动文档站（3001）
```

## 本地验证

提交前建议运行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 文档

- [贡献指南](./CONTRIBUTING.md)
- [测试说明](./TESTING.md)
- [CI/CD 说明](./CI_CD.md)

## 许可证

MIT
