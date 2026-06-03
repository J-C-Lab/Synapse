# Copilot Instructions

Synapse is an Electron desktop app built with electron-vite, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand, i18next, and Vitest.

## Structure

- `src/main/` Electron main process.
- `src/preload/` preload bridge and global Window typings.
- `src/renderer/` Vite React renderer.
- `docs/` separate Fumadocs workspace package.

## Commands

- `pnpm dev` starts electron-vite dev mode.
- `pnpm build` builds main, preload, and renderer into `out/`.
- `pnpm test` runs Vitest.
- `pnpm typecheck` runs both node and web TypeScript configs.
- `pnpm electron:build` packages the app with electron-builder.

## Rules

- Do not introduce Next.js into the main app. Next.js only exists in `docs/`.
- Do not use Node APIs in the renderer.
- Route renderer-to-main calls through `src/renderer/src/lib/electron.ts`.
- Keep IPC commands explicit and typed through preload.
- Treat `src/renderer/src/components/ui/` as vendored shadcn code.
