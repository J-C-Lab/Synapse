# Structured Logging + Minimal E2E Smoke — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a zero-dependency structured logger for the main process (replacing 31 `console.*` calls) and one Playwright `_electron` smoke test that launches the built app and asserts window load + renderer render + an IPC round-trip.

**Architecture:** A pure `Logger` (levels, JSON lines, secret redaction) writes through injected `LogSink`s; a file sink (rotating) + stderr sink are wired by a convention-singleton root logger configured early in `index.ts`. Never writes stdout. E2E is local/opt-in via Playwright `_electron`, not in CI.

**Tech Stack:** TypeScript (strict), Node, Vitest, ESLint (antfu flat config), `@playwright/test`.

Spec: `docs/superpowers/specs/2026-06-25-structured-logging-and-e2e-smoke-design.md`

---

## Part A — Structured logging

### Task 1: `redact.ts` — field redaction

**Files:** Create `src/main/logging/redact.ts`, Test `src/main/logging/redact.test.ts`

- [ ] Write failing tests: redacts top-level secret-named keys; recurses into nested objects and arrays; leaves non-secret keys; depth cap stops recursion; non-object input returned as-is.
- [ ] Implement `redactFields(value: unknown, depth = 0): unknown`. Secret key regex `/(api[-_]?key|token|secret|password|authorization|cookie)/i`. Max depth 4; beyond it return `"[depth-capped]"`. Arrays mapped; plain objects rebuilt with matched keys → `"[redacted]"`, others recursed.
- [ ] Run `pnpm test src/main/logging/redact.test.ts` → PASS. Commit.

```ts
const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|cookie)/i
const MAX_DEPTH = 4
export function redactFields(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[depth-capped]"
  if (Array.isArray(value)) return value.map((v) => redactFields(v, depth + 1))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactFields(v, depth + 1)
    }
    return out
  }
  return value
}
```

### Task 2: `logger.ts` — pure logger core

**Files:** Create `src/main/logging/logger.ts`, Test `src/main/logging/logger.test.ts`

- [ ] Write failing tests (inject a memory sink capturing lines): info/warn/error emit one JSON line each with `ts/level/scope/msg` + redacted fields; `minLevel` filters lower levels; `child(scope, fields)` prefixes scope and merges bound fields; `Error` field → `{ message, stack }`.
- [ ] Implement. Interfaces below. `format` builds the record, runs `redactFields`, JSON-stringifies, appends `\n`, writes to each sink. Levels ordered `debug<info<warn<error`.
- [ ] Run tests → PASS. Commit.

```ts
export type LogLevel = "debug" | "info" | "warn" | "error"
export interface LogSink { write: (line: string) => void }
export interface LoggerOptions { scope?: string; minLevel?: LogLevel; sinks: LogSink[]; bound?: Record<string, unknown>; now?: () => Date }
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
export class Logger {
  constructor(private readonly o: LoggerOptions) {}
  child(scope: string, fields?: Record<string, unknown>): Logger {
    const nextScope = this.o.scope ? `${this.o.scope}:${scope}` : scope
    return new Logger({ ...this.o, scope: nextScope, bound: { ...this.o.bound, ...fields } })
  }
  debug(m: string, f?: Record<string, unknown>) { this.log("debug", m, f) }
  info(m: string, f?: Record<string, unknown>) { this.log("info", m, f) }
  warn(m: string, f?: Record<string, unknown>) { this.log("warn", m, f) }
  error(m: string, f?: Record<string, unknown>) { this.log("error", m, f) }
  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[this.o.minLevel ?? "info"]) return
    const merged = normalizeErrors({ ...this.o.bound, ...fields })
    const record = { ts: (this.o.now?.() ?? new Date()).toISOString(), level, scope: this.o.scope, msg, ...(redactFields(merged) as object) }
    const line = `${JSON.stringify(record)}\n`
    for (const s of this.o.sinks) s.write(line)
  }
}
```

`normalizeErrors` converts any `Error` value to `{ message, stack }`.

### Task 3: `file-sink.ts` — rotating file sink + stderr sink

**Files:** Create `src/main/logging/file-sink.ts`, Test `src/main/logging/file-sink.test.ts`

- [ ] Write failing tests (temp dir, small `maxBytes`): writes lines to `<dir>/main.log`; when size exceeds `maxBytes`, rotates `main.log`→`main.1.log` and keeps at most `keep` archives (oldest dropped); creates dir if missing.
- [ ] Implement `createFileSink(dir, { maxBytes = 5_000_000, keep = 3 })`: ensure dir (`mkdirSync recursive`), on write check current size (`statSync` or tracked counter), rotate by renaming `main.(k-1).log`→`main.k.log` down to `main.log`→`main.1.log`, drop beyond `keep`, then `appendFileSync`. Export `stderrSink: LogSink` = `{ write: (l) => process.stderr.write(l) }`.
- [ ] Run tests → PASS. Commit.

### Task 4: `index.ts` — assembly + convention singleton

**Files:** Create `src/main/logging/index.ts`, Test `src/main/logging/index.test.ts`

- [ ] Write failing tests: before `configureRootLogger`, `logger.info` does not throw and writes to stderr sink only (capture via spy); after `configureRootLogger({ userDataDir, level })`, records also go to the file; `logger.child("x")` works in both phases.
- [ ] Implement: module-level `let root = new Logger({ minLevel: defaultLevel(), sinks: [stderrSink] })`. `configureRootLogger({ userDataDir, level })` sets `root = new Logger({ minLevel: level ?? defaultLevel(), sinks: [stderrSink, createFileSink(path.join(userDataDir, "logs"))] })`. Export `logger` as a thin proxy delegating to current `root` (so imports taken before configure still see the reconfigured root). `defaultLevel()` reads `SYNAPSE_LOG_LEVEL` else `info`.
- [ ] Run tests → PASS. Commit.

Proxy approach: export an object whose methods call `root.<m>` at call time, and `child(scope)` returns `root.child(scope)` (acceptable: children are created at use sites each call, cheap).

### Task 5: Wire + migrate the 31 `console.*` calls

**Files:** Modify `src/main/index.ts` (+ alias `@main/logging`), and migrate: `ai/agent-service.ts`, `ipc/{ai,lan,memory,plugins,updates}.ts`, `lan/{bonjour-discovery-adapter,lan-secure-server,lan-service}.ts`, `plugins/{plugin-bridge,plugin-host,plugin-registry,plugin-sandbox}.ts`.

- [ ] Call `configureRootLogger({ userDataDir: app.getPath("userData") })` in `index.ts` right after userData is resolved (after the lanSimulation block). The module-top `console.warn` for lanSimulation → `logger.child("synapse").warn(...)`.
- [ ] Replace each `console.warn/error(...)` with `logger.child(<scope>).<warn|error>(msg, { err })`, scope from the existing bracket prefix (`synapse`, `lan`, `plugin-host`, `plugin-registry`, `plugin-bridge`). The error object goes in fields, not string-concatenated.
- [ ] In `plugin-sandbox.ts` lines ~423-425, route the plugin's forwarded console through `logger.child(\`plugin:${pluginId}\`).info/warn/error(args.join(" "))` instead of `console.*`.
- [ ] Run `pnpm test`, `pnpm lint`, `pnpm exec tsc -p tsconfig.node.json --noEmit` → all green. Commit.

Note: `@main/logging` resolves via existing `@main/*` alias (tsconfig.node + electron.vite + vitest already map `@main` → `src/main`). Use relative imports inside `src/main` to match the file's neighbors.

### Task 6: ESLint `no-console` guard for `src/main`

**Files:** Modify `eslint.config.mjs`

- [ ] Add a flat-config block: `files: ["src/main/**/*.ts"]`, `ignores: ["src/main/logging/**", "src/main/mcp/stdio-entry.ts"]`, `rules: { "no-console": "error" }`. (stdio-entry uses `process.stderr.write`, not console, but list it for clarity/future-proofing — verify it has no `console.*`.)
- [ ] Run `pnpm lint` → green (proves migration left no raw console). Commit.

---

## Part B — Minimal E2E smoke

### Task 7: Playwright wiring

**Files:** Modify `package.json` (devDep + script), Create `playwright.config.ts`

- [ ] `pnpm add -D @playwright/test`.
- [ ] Add script `"test:e2e": "pnpm build && playwright test"`.
- [ ] Create `playwright.config.ts`: `testDir: "e2e"`, `timeout: 60_000`, single worker, no retries, `reporter: "list"`.
- [ ] Verify `pnpm exec playwright --version` works. Commit (config + package.json; lockfile included).

### Task 8: stable test hook in the renderer

**Files:** Modify `src/renderer/src/App.tsx`

- [ ] Add `data-testid="app-shell"` to the shell container `div` (the `<div className="h-screen bg-background font-sans text-foreground">` wrapping `<AppShell />`).
- [ ] Run `pnpm test` (renderer tests unaffected) + `pnpm exec tsc -p tsconfig.web.json --noEmit` → green. Commit.

### Task 9: the smoke test

**Files:** Create `e2e/smoke.spec.ts`

- [ ] Implement: `_electron.launch({ args: [path.join(__dirname, "..")], env: { ...process.env, SYNAPSE_USER_DATA_DIR? n/a — use a temp dir via a dedicated env or --user-data-dir } })`. Use Electron's `--user-data-dir=<temp>` arg to isolate. Get `electronApp.firstWindow()`. If no window/visible, `electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())`.
- [ ] Assertions: `await window.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })`; `const settings = await window.evaluate(() => (window as any).electronAPI.getSettings()); expect(settings).toHaveProperty("hotkey"); expect(settings).toHaveProperty("themeMode")`.
- [ ] `afterAll` close the app + remove temp dir.
- [ ] Run `pnpm test:e2e` locally → PASS. Commit.

```ts
import { _electron as electron, expect, test } from "@playwright/test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

test("app launches, renders the shell, and IPC round-trips", async () => {
  const userDir = mkdtempSync(path.join(tmpdir(), "synapse-e2e-"))
  const app = await electron.launch({
    args: [path.join(__dirname, ".."), `--user-data-dir=${userDir}`],
  })
  try {
    const window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    await window.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
    const settings = await window.evaluate(() => (window as unknown as { electronAPI: { getSettings: () => Promise<unknown> } }).electronAPI.getSettings())
    expect(settings).toHaveProperty("hotkey")
    expect(settings).toHaveProperty("themeMode")
  } finally {
    await app.close()
    rmSync(userDir, { recursive: true, force: true })
  }
})
```

---

## Self-review notes
- Spec coverage: logger (T2), redaction (T1), file rotation (T3), assembly/singleton (T4), migration + no-stdout (T5), lint guard (T6), Playwright + script (T7), testid (T8), 3 assertions (T9). All spec sections covered.
- No-stdout invariant: only `stderrSink` + file sink; verified by T6 lint + manual read.
- E2E `--user-data-dir` is an Electron arg the app already respects via `app.getPath("userData")`; no app change needed.
