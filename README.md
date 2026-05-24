<p align="center">
  <img src="resources/logo.svg" alt="DesKit Logo" width="120" />
</p>
<h1 align="center">DesKit</h1>

DesKit is an extensible desktop productivity toolbox built with Electron, React, and electron-vite.

It provides a secure desktop shell for command launching, lightweight utilities, floating interactions, and plugin-driven workflows.

## Features

- Electron desktop app with isolated main, preload, and renderer processes
- Typed IPC boundary through `contextBridge`
- Custom `app://` protocol and strict CSP baseline
- React renderer with Tailwind CSS and shadcn/ui
- English and Chinese i18n foundation
- Vitest-based unit and component testing
- Cross-platform packaging with electron-builder
- Fumadocs documentation workspace

## Roadmap

- Global shortcut command launcher
- Floating desktop assistant
- Theme switching and persisted appearance settings
- Plugin manifest, registry, permission model, and SDK
- Built-in tools for timestamp conversion, clipboard history, and screenshots
- Optional docs site for product and engineering documentation

## Tech Stack

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

## Project Structure

```text
src/
├─ main/                  # Electron main process, CSP, app:// protocol, IPC
├─ preload/               # contextBridge API and renderer-visible types
└─ renderer/              # React renderer app
   ├─ index.html
   └─ src/
      ├─ App.tsx
      ├─ components/
      ├─ hooks/
      ├─ i18n/
      └─ lib/

docs/                     # Fumadocs documentation site
resources/                # electron-builder icons and resources
```

## Getting Started

Requirements:

- Node.js 22.13+
- pnpm 11.x

Install dependencies:

```bash
pnpm install
```

Start the desktop app in development mode:

```bash
pnpm dev
```

## Scripts

```bash
pnpm dev                # Start Electron dev mode
pnpm build              # Build main/preload/renderer into out/
pnpm preview            # Preview the production build
pnpm lint               # Run ESLint
pnpm lint:fix           # Fix ESLint issues
pnpm format             # Format files with Prettier
pnpm format:check       # Check Prettier formatting
pnpm typecheck          # Run TypeScript checks
pnpm typecheck:native   # Run tsgo native-preview checks
pnpm test               # Run Vitest
pnpm test:watch         # Run Vitest in watch mode
pnpm test:coverage      # Run Vitest with coverage
pnpm electron:build     # Package the current platform
pnpm docs:dev           # Start the docs site on port 3001
```

## Validation

Run the full local check before committing:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Assets

The system-tray icon (`resources/tray.png`, `tray@2x.png`, `tray@3x.png`) is generated from [resources/logo.svg](resources/logo.svg). Re-run the rasterizer whenever the logo changes — it uses the bundled Electron as a headless Chromium, no extra dependencies:

```bash
pnpm exec electron scripts/build-tray-icons.cjs
```

## Documentation

- [Contributing Guide](./CONTRIBUTING.md)
- [Testing Guide](./TESTING.md)
- [CI/CD Guide](./CI_CD.md)

## License

MIT
