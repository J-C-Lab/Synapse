# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DesKit** — desktop productivity toolbox. Stack: **electron-vite** + **Electron 33** + **React 19** + **TypeScript 5 (strict)** + **Tailwind CSS v4** + **shadcn/ui** + **Zustand** + **i18next**.

The renderer is a single-page Vite-built React app loaded by the Electron main process. There is no web fallback — the renderer assumes Electron and uses IPC for OS-level work.

## Development Commands

```bash
# Main app — electron-vite drives main + preload + renderer in one process
pnpm dev               # Start electron-vite dev (Vite HMR for renderer, hot-restart for main/preload)
pnpm build             # Production build → out/main, out/preload, out/renderer
pnpm preview           # Run the production build locally
pnpm lint              # Run ESLint (flat config)
pnpm lint:fix          # Auto-fix ESLint issues
pnpm format            # Format with Prettier
pnpm format:check      # Check formatting without writing
pnpm typecheck         # Typecheck node (main/preload) AND web (renderer) — uses tsc (stable)
pnpm typecheck:native  # Same two configs, run through tsgo (@typescript/native-preview, Go-based, ~10× faster). Sanity check — divergence vs tsc is a signal.

# Testing
pnpm test              # Run Vitest once
pnpm test:watch        # Run Vitest in watch mode
pnpm test:coverage     # Run Vitest with coverage report

# Packaging (electron-builder)
pnpm electron:build          # Current platform
pnpm electron:build:win      # Windows: NSIS + MSI
pnpm electron:build:mac      # macOS: DMG + ZIP (x64 + arm64)
pnpm electron:build:linux    # Linux: AppImage + deb

# Docs site (pnpm workspace — port 3001) — separate Fumadocs project
pnpm docs:dev
pnpm docs:build
pnpm docs:start

# Add shadcn/ui components
pnpm dlx shadcn@latest add <component-name>
```

## Architecture

### Process model

electron-vite produces three independent bundles at `out/`:

| Bundle   | Output                             | Entry                                                   | Runtime                                                   |
| -------- | ---------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Main     | `out/main/index.js`                | `src/main/index.ts`                                     | Node + Electron main process                              |
| Preload  | `out/preload/index.js`             | `src/preload/index.ts`                                  | Sandboxed (no Node APIs except contextBridge/ipcRenderer) |
| Renderer | `out/renderer/index.html` + assets | `src/renderer/index.html` → `src/renderer/src/main.tsx` | Chromium (DOM only, no Node)                              |

In dev, the renderer is served at `process.env.ELECTRON_RENDERER_URL` (Vite dev server) and the main process loads that URL with HMR. In production, the main process serves the built renderer through a **custom `app://` protocol** (registered in [src/main/index.ts](src/main/index.ts)) instead of `file://`, so absolute asset paths like `/assets/index-abc.js` resolve correctly.

### Directory layout

```
src/
├─ main/                  # Electron main process (Node)
│  ├─ index.ts            # Window, CSP, protocol, IPC registration, single-instance lock
│  ├─ ipc/<name>.ts       # Pure IPC handlers (unit-testable)
│  └─ protocol/           # Custom app:// scheme + path-traversal-safe resolver
├─ preload/
│  ├─ index.ts            # contextBridge.exposeInMainWorld('electronAPI', { ... })
│  └─ index.d.ts          # Global Window typings — shared with renderer
└─ renderer/
   ├─ index.html          # Vite entry
   └─ src/
      ├─ main.tsx         # ReactDOM.createRoot
      ├─ App.tsx
      ├─ globals.css      # Tailwind v4 + oklch theme tokens + class-based dark mode
      ├─ env.d.ts         # /// references to vite/client + preload typings
      ├─ components/      # App components
      │  └─ ui/           # 57 vendored shadcn/ui primitives (treated as third-party)
      ├─ hooks/
      ├─ lib/
      │  ├─ utils.ts      # cn() = clsx + tailwind-merge
      │  └─ electron.ts   # SOLE caller of window.electronAPI from the renderer
      └─ i18n/            # i18next setup + messages JSON per locale

resources/                # App icons (icon.ico / icon.icns / icon.png) — buildResources
docs/                     # Fumadocs site (separate workspace)
DesKit/                   # Project research/design docs (PRD, architecture, ADRs)
__mocks__/electron.ts     # Vitest mock of Electron module
electron.vite.config.ts   # Main/preload/renderer config in one file
vitest.config.ts          # Vitest config (mirrors path aliases)
tsconfig.json             # Solution-style root, references node + web
tsconfig.node.json        # main + preload (ES2022 / ESNext / Node)
tsconfig.web.json         # renderer (DOM + react-jsx + Vite client)
```

### Electron security baseline (preserved from the original scaffold — do not regress)

Implemented in [src/main/index.ts](src/main/index.ts):

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false` + `webviewTag: false`
- Custom `app://` scheme registered as `standard` + `secure` (CORS/cookies/CSP behave like https)
- Per-environment **Content-Security-Policy** injected via `session.webRequest.onHeadersReceived` (prod is strict `self`-only)
- `setWindowOpenHandler` + `will-navigate` + `will-attach-webview` hooks reject privilege escalation and external navigation; `http(s)` links open in the OS browser via `shell.openExternal`
- `app.requestSingleInstanceLock()` — second launch focuses the existing window
- Path-traversal-safe static resolver ([src/main/protocol/resolve-static-path.ts](src/main/protocol/resolve-static-path.ts))

### IPC pattern

Three-layer separation makes IPC unit-testable and the main↔renderer contract type-safe:

1. **Pure business function** in `src/main/ipc/<name>.ts` — no Electron imports, fully testable.
2. **Main-process binding** in `src/main/index.ts` — `ipcMain.handle('<name>', ...)` validates args and calls the pure function.
3. **Preload surface** in [src/preload/index.ts](src/preload/index.ts) — `contextBridge.exposeInMainWorld('electronAPI', { ... })` exposes a typed object; types live in [src/preload/index.d.ts](src/preload/index.d.ts).
4. **Renderer wrapper** in [src/renderer/src/lib/electron.ts](src/renderer/src/lib/electron.ts) — the **only** module that touches `window.electronAPI`. Business code imports named functions from here.

### Styling system

- **Tailwind v4** via `@tailwindcss/vite` plugin (no PostCSS config).
- CSS variables in oklch color space; `--font-sans`/`--font-mono` use a system font stack (no Geist / `next/font`).
- Dark mode: class-based (`.dark` on a parent element).
- Custom variant `@custom-variant dark (&:is(.dark *))`.

### Path aliases

| Alias        | Resolves to          | Scope            |
| ------------ | -------------------- | ---------------- |
| `@/*`        | `src/renderer/src/*` | renderer + tests |
| `@main/*`    | `src/main/*`         | main process     |
| `@preload/*` | `src/preload/*`      | preload          |

Configured consistently in `tsconfig.web.json`, `tsconfig.node.json`, `electron.vite.config.ts`, and `vitest.config.ts`.

### Installed shadcn/ui components

All components pre-installed under [src/renderer/src/components/ui/](src/renderer/src/components/ui/) — import directly, do not run `shadcn add` for these:

`accordion` · `alert` · `alert-dialog` · `aspect-ratio` · `avatar` · `badge` · `breadcrumb` · `button` · `button-group` · `calendar` · `card` · `carousel` · `chart` · `checkbox` · `collapsible` · `combobox` · `command` · `context-menu` · `dialog` · `direction` · `drawer` · `dropdown-menu` · `empty` · `field` · `form` · `hover-card` · `input` · `input-group` · `input-otp` · `item` · `kbd` · `label` · `menubar` · `native-select` · `navigation-menu` · `pagination` · `popover` · `progress` · `radio-group` · `resizable` · `scroll-area` · `select` · `separator` · `sheet` · `sidebar` · `skeleton` · `slider` · `sonner` · `spinner` · `switch` · `table` · `tabs` · `textarea` · `toggle` · `toggle-group` · `tooltip`

`TooltipProvider` wraps the app in [src/renderer/src/App.tsx](src/renderer/src/App.tsx).

### Testing

- **Vitest** with `environment: jsdom`, `setupFiles: vitest.setup.ts` (loads `@testing-library/jest-dom`).
- The `electron` module is aliased to [**mocks**/electron.ts](__mocks__/electron.ts) inside Vitest, so main-process modules import without spawning Electron.
- Coverage thresholds: 70% lines/statements, 60% branches/functions. shadcn primitives and the orchestration entrypoints (`src/main/index.ts`, `src/preload/index.ts`) are excluded — they're tested via their seams.

### Lint & format

- **ESLint** uses [`@antfu/eslint-config`](https://github.com/antfu/eslint-config) (flat config) for code quality only — TS, React, import sorting, unused imports, hooks rules, Vitest plugin. See [eslint.config.mjs](eslint.config.mjs).
- **Stylistic rules in antfu are disabled** (`stylistic: false`). Formatting is delegated to **Prettier** so we don't have two tools fighting over the same files. `eslint-config-prettier` is the last layer in the chain to silence any conflicting rule that leaks through.
- Vendored shadcn primitives at [src/renderer/src/components/ui/](src/renderer/src/components/ui/) are ignored — they are treated as third-party.

## Code patterns

```tsx
// Conditional Tailwind classes — always use cn()
import { cn } from "@/lib/utils"
cn("base-classes", condition && "conditional", className)

// Calling the main process from the renderer — go through lib/electron.ts
import { isElectron, searchApps } from "@/lib/electron"
if (isElectron()) {
  searchApps("vscode").then((results) => console.log(results))
}

// i18n
import { useTranslation } from "react-i18next"
const { t } = useTranslation()
return <h1>{t("app.title")}</h1>
```

## Critical notes

- **Always use pnpm** — `pnpm install` from the repo root installs every workspace.
- **electron-vite drives all three bundles**: do not introduce a separate `next.config.ts` / `webpack` / standalone `vite.config.ts` for the renderer; modify [electron.vite.config.ts](electron.vite.config.ts).
- **Production renderer is served via `app://`**, not `file://`. If you add new asset directories, make sure they are emitted under `out/renderer/` so the protocol handler can find them.
- **Adding an IPC channel = 4 touchpoints**: pure handler in `src/main/ipc/<name>.ts`, registration in `src/main/index.ts`, preload exposure in `src/preload/index.ts`, renderer wrapper in `src/renderer/src/lib/electron.ts`. Add a test for the pure handler.
- **Renderer cannot read `process.env` directly** — use `import.meta.env.VITE_*`. Main process uses `process.env` normally.
- **No Rust / native toolchain required**: pure Node + pnpm. Electron downloads its own Chromium through pnpm build approvals in `pnpm-workspace.yaml`.
- **Docs is a separate workspace** at [docs/](docs/) with full Next.js server mode and Fumadocs — keep it isolated from the main app's tooling.
- shadcn/ui configured with "new-york" style; `rsc: false` in [components.json](components.json) (no React Server Components in Vite).
