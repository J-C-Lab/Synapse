<p align="center">
  <img src="resources/logo.svg" alt="Synapse Logo" width="120" />
</p>
<h1 align="center">Synapse</h1>

<p align="center">
  An extensible desktop platform that turns an AI agent into a productivity workhorse —
  with installable plugins as its hands, MCP as the wiring, and a plugin marketplace as the ecosystem.
</p>

<p align="center">
  <a href="#getting-started">Getting Started</a> ·
  <a href="#monorepo-layout">Layout</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="./README_zh.md">中文</a>
</p>

---

## What is Synapse?

Synapse is an Electron desktop app built around a simple mental model:

- **The AI is the brain / designer.**
- **Installable skills are knowledge the brain can learn.**
- **Synapse plugins are the brain's hands** — capabilities the agent (and the user) can invoke.
- **The marketplace is the society** where those hands are produced, distributed, and peer-reviewed.

In practice that means a single desktop shell that hosts a built-in AI agent, a sandboxed
plugin runtime that exposes plugin actions as **MCP tools**, encrypted **LAN device-to-device**
transfer, and a full **plugin marketplace** (backend + web portal) for publishing, browsing,
rating, and moderating plugins.

## Highlights

### 🧠 AI foundation

- Built-in **agent runtime** with streaming chat, tool-calling, and per-turn token budgeting
- **Multi-provider BYOK** — Claude by default, plus OpenAI and OpenAI-compatible vendors (智谱/GLM, 硅基流动/SiliconFlow, 阿里百炼/Qwen) via a provider abstraction; keys are yours, encrypted at rest
- **Bidirectional MCP** — plugin tools are exposed as [Model Context Protocol](https://modelcontextprotocol.io) tools, and Synapse can also act as an MCP **client** consuming external servers
- **Long-term memory** — documents ingested into chunked, searchable memory (RAG) with encrypted MCP server secrets

### 🧩 Plugin system

- **Manifest + SDK** — a declarative `synapse.json` plus a typed `{ commands, views, tools }` contract for authors
- **Scaffold & CLI** — `create-synapse-plugin` to start, `synapse-plugin` to build a project into an installable `.syn` package
- **Sandboxed host** — capability/permission model, isolated execution, and a tool bridge into the agent
- **Local install** — open or drop a `.syn` file (registered file association) to install

### 🛒 Plugin marketplace

- Self-managed backend (**Fastify + Drizzle + Postgres/Neon + Cloudflare R2**) — the authoritative source of truth
- **Accounts** via GitHub device-authorization flow; opaque, revocable sessions hashed at rest
- **Publish** (private or public), **browse**, **download** (short-lived signed URLs), **rate & review**, **ranking**
- **Governance & moderation** — visibility toggles, version yanking, abuse reports, automated risk scanning, an admin review queue, and takedown/restore
- **Web portal** — public, SEO-friendly browsing built on the docs site

### 🖥️ Desktop shell

- Global-shortcut **command launcher** and a **floating ball** quick-access surface
- Theme switching (light/dark/system) with persisted appearance settings
- **English & 简体中文** i18n
- **Auto-update** with an in-app banner (manual download/restart flow)

### 🔐 LAN device sync

- Nearby-device discovery over Bonjour, **pinned-HTTPS encrypted file transfer** with a verifiable security code

## Monorepo layout

A pnpm workspace. The desktop app lives at the repo root; shared libraries, the marketplace
backend, and the docs/portal live under `packages/` and `docs/`.

```text
synapse/
├─ src/                              # Electron desktop app
│  ├─ main/                          # Main process
│  │  ├─ ai/                         # Agent runtime, providers, MCP client, memory
│  │  ├─ mcp/                        # Synapse-as-MCP-server
│  │  ├─ plugins/                    # Plugin host, sandbox, permissions, tool bridge
│  │  ├─ marketplace/                # Desktop account sign-in + encrypted token store
│  │  ├─ lan/                        # Bonjour discovery + pinned-HTTPS transfer
│  │  ├─ launcher/  settings/  updates/  protocol/  ipc/
│  ├─ preload/                       # contextBridge API + renderer-visible types
│  └─ renderer/                      # React SPA (home, chat, launcher, plugins, marketplace, LAN, settings)
│
├─ packages/
│  ├─ plugin-manifest/               # synapse.json schema, validation, engine compatibility
│  ├─ plugin-sdk/                    # Declarative command + view + tool contract for authors
│  ├─ plugin-cli/                    # Build a plugin project into a .syn package; login/publish
│  ├─ create-synapse-plugin/         # Project scaffold
│  ├─ marketplace-types/             # Shared zod schemas + inferred types (server/CLI/app/portal)
│  └─ marketplace-server/            # Fastify + Drizzle marketplace backend
│
├─ docs/                             # Fumadocs site + the public marketplace web portal
└─ resources/                        # Icons and electron-builder assets
```

## Architecture

**Process model.** electron-vite produces three independent bundles in `out/` — `main`,
`preload`, and `renderer`. The renderer is a Vite-built React SPA loaded by the main process;
there is no web fallback, so it always assumes Electron and uses IPC for OS-level work.

**Typed IPC.** Every cross-process call follows a four-touchpoint pattern: a pure handler →
main-process registration → `preload` `contextBridge` exposure → a typed renderer wrapper.
Senders are validated and payloads are checked at the boundary.

**Security baseline.** A custom, `standard`+`secure` `app://` protocol serves the renderer, and a
strict CSP is applied to every response. Secrets (AI provider keys, the marketplace session
token, MCP server env/headers) are encrypted at rest with the OS keychain via Electron
`safeStorage` and never reach the renderer.

**Marketplace contract.** `@synapse/marketplace-types` is the single source of truth — zod
schemas with `z.infer` types shared by the backend, the CLI, the desktop app, and the web
portal. The backend is fully dependency-injected (db, object storage, identity provider, clock),
so it runs against in-process Postgres (PGlite/WASM) in tests with no real credentials.

## Tech stack

| Area            | Tools                                                                              |
| --------------- | ---------------------------------------------------------------------------------- |
| Desktop         | Electron 33 · electron-vite · electron-builder · electron-updater                  |
| UI              | React 19 · TypeScript 5 (strict) · Tailwind CSS v4 · shadcn/ui · Zustand · i18next |
| AI              | `@anthropic-ai/sdk` · `openai` · `@modelcontextprotocol/sdk`                       |
| Backend         | Fastify 5 · Drizzle ORM · Postgres (Neon) · Cloudflare R2 (S3) · zod               |
| Web portal/docs | Next.js · Fumadocs                                                                 |
| Tooling         | pnpm workspaces · Vitest · Testing Library · ESLint · Prettier · Husky             |

## Getting Started

**Requirements:** Node.js 22.13+ and pnpm 11.x.

```bash
pnpm install            # install all workspace deps
pnpm dev                # start the desktop app (Vite HMR + main/preload hot-restart)
```

### Run the marketplace backend (optional)

Only needed if you want the live publish/browse/rating flows locally. Tests run without any
credentials (in-process Postgres via PGlite).

```bash
cp packages/marketplace-server/.env.example packages/marketplace-server/.env
# fill DATABASE_URL + GITHUB_CLIENT_ID/SECRET (R2 vars optional → falls back to in-memory storage)
pnpm -F @synapse/marketplace-server dev
```

### Browse the marketplace web portal

```bash
pnpm docs:dev           # serves the docs site + /marketplace portal (port 3001)
```

Point the portal at a backend with `MARKETPLACE_URL` (defaults to `http://localhost:8787`).

### LAN transfer simulation

To exercise device-to-device transfer on a single machine, launch two isolated instances in
separate terminals:

```bash
pnpm dev:lan:a          # appears as "Synapse Sim A"
pnpm dev:lan:b          # appears as "Synapse Sim B"
```

Each uses a separate dev-only profile (identity, certificate, trusted devices, settings,
transfers). Enable nearby-device discovery in both windows, connect them, and compare the
security codes.

## Build a plugin

```bash
pnpm dlx create-synapse-plugin my-plugin   # scaffold
cd my-plugin
pnpm synapse-plugin build                  # → my-plugin-<version>.syn
pnpm synapse-plugin login                  # device-flow sign-in to the marketplace
pnpm synapse-plugin publish                # publish (private by default)
```

Install a `.syn` locally by opening it from the desktop app's Plugins page.

## Scripts

```bash
# Desktop app
pnpm dev                # Electron dev mode
pnpm build              # Build workspace packages, then main/preload/renderer → out/
pnpm preview            # Preview the production build
pnpm electron:build     # Package the current platform (electron-builder)
pnpm electron:build:win # Windows: NSIS + MSI  (also :mac / :linux)

# Quality
pnpm lint               # ESLint            (pnpm lint:fix to autofix)
pnpm format:check       # Prettier          (pnpm format to write)
pnpm typecheck          # Typecheck packages + node (main/preload) + web (renderer)
pnpm test               # Vitest            (pnpm test:watch / pnpm test:coverage)

# Marketplace backend & docs
pnpm -F @synapse/marketplace-server dev
pnpm docs:dev           # docs site + web portal (port 3001)
```

## Validation

Run the full local check before committing — this mirrors CI:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

> CI (GitHub Actions) runs the same quality gates, the test suite with coverage, and unsigned
> Electron builds for Windows, macOS (x64 + arm64), and Linux on every PR to `main`.

## Assets

The system-tray icons (`resources/tray.png`, `tray@2x.png`, `tray@3x.png`) are generated from
[resources/logo.svg](resources/logo.svg) using the bundled Electron as a headless Chromium —
re-run the rasterizer whenever the logo changes:

```bash
pnpm exec electron scripts/build-tray-icons.cjs
```

## Documentation

- [Contributing Guide](./CONTRIBUTING.md)
- [Testing Guide](./TESTING.md)
- [CI/CD Guide](./CI_CD.md)
- Design docs: [`design/`](./design) — AI foundation, AI enhancements, and the marketplace & users plan

## License

MIT
