# Structured Logging + Minimal E2E Smoke — Design

> Date: 2026-06-25 · Status: approved, pending implementation plan
> Addresses the audit's largest structural gap: zero integration/E2E coverage and
> bare `console.*` logging across the main process.

## Goal

Two independent, minimal deliverables in one round (logging first, it is the
foundation):

1. **Structured logging** — a small zero-dependency logger for the main process,
   replacing the 31 scattered `console.*` calls with levelled, JSON-line,
   secret-redacted output written to a rotating file + stderr (never stdout).
2. **Minimal E2E smoke** — one Playwright `_electron` test that launches the
   built app and asserts the window loads, the renderer renders, and one IPC
   round-trip works. Local / opt-in; **not** in the CI gate.

## Non-goals (YAGNI this round)

- Renderer logging channel / the renderer's 7 `console.*` calls.
- Remote log shipping / telemetry (separate audit P1).
- E2E coverage of AI chat (needs a real key), sign-in, marketplace, LAN, etc.
- Promoting E2E into CI (revisit once it is proven stable on Windows).

---

## Part A — Structured logging

### Module boundaries (all under `src/main/logging/`)

| File | Responsibility | Tested by |
| --- | --- | --- |
| `logger.ts` | Pure core. `Logger` with `debug/info/warn/error(msg, fields?)` and `child(scope, fields?)`. Formats each record to a single JSON line `{ts, level, scope, msg, ...fields}`. Filters by `minLevel`. Delegates output to injected `LogSink[]`. | unit (inject memory sink) |
| `redact.ts` | Pure. Recursively redacts field values whose key matches `/(api[-_]?key|token|secret|password|authorization|cookie)/i` → `"[redacted]"`, with a depth cap to avoid cycles/stack blowups. | unit |
| `file-sink.ts` | Side-effecting `LogSink`. Appends to `userData/logs/main.log`; size-based rotation (default 5 MB, keep 3: `main.1.log`…`main.3.log`). Plus `stderrSink` writing to `process.stderr`. | unit (temp dir) |
| `index.ts` | Assembly. `configureRootLogger({ userDataDir, level })` and a convention-singleton `logger` accessor. Modules do `import { logger } from "@main/logging"` then `logger.child("lan").info(...)`. | via seams |

### Record format

One JSON object per line, e.g.:

```json
{"ts":"2026-06-25T01:23:45.678Z","level":"warn","scope":"lan","msg":"failed to start discovery","err":"EADDRINUSE"}
```

`Error` field values are normalized to `{ message, stack? }` (or just the message
at lower verbosity) so they serialize cleanly.

### Invariants

- **Never writes stdout** — only stderr + file. Preserves the MCP-stdio
  cleanliness invariant established in `src/main/mcp/stdio-entry.ts`.
- Default level `info`; `SYNAPSE_LOG_LEVEL` (or dev) can raise to `debug`.
- The logger is a **convention singleton** (logging is legitimately ambient).
  This avoids threading a logger through ~14 modules' constructors — zero
  structural churn. Before `configureRootLogger` runs, records go to stderr only
  (no file path known yet).

### Migration

Replace the 31 `console.*` calls in `src/main/**` (non-test) with
`logger.child(<scope>).<level>(msg, { fields })`, reusing existing prefixes as
scopes (`synapse`, `lan`, `plugin-host`, `plugin-registry`, …). Affected files:
`index.ts`, `ai/agent-service.ts`, `ipc/{ai,lan,memory,plugins,updates}.ts`,
`lan/{bonjour-discovery-adapter,lan-secure-server,lan-service}.ts`,
`plugins/{plugin-bridge,plugin-host,plugin-registry,plugin-sandbox}.ts`.

Note: the plugin sandbox (`plugin-sandbox.ts`) forwards a plugin's own
`console.log/warn/error` to the host. That forwarding also routes through the
logger now — `logger.child(\`plugin:${pluginId}\`).info/warn/error(...)` — so it
stays on stderr/file, keeps plugin output namespaced, and leaves no raw
`console.*` anywhere in `src/main` (satisfying the lint guard below).

### Lint guard

Add ESLint `no-console` scoped to `src/main/**`, with the `src/main/logging/**`
module (and `mcp/stdio-entry.ts`, which writes `process.stderr` directly)
exempt. Locks in "main never uses raw console" so the invariant cannot regress.

`configureRootLogger` is wired early in `src/main/index.ts` right after
`app.getPath("userData")` is available.

---

## Part B — Minimal E2E smoke (Playwright `_electron`)

### Setup

- Add dev dep `@playwright/test`.
- `playwright.config.ts` at repo root scoped to `e2e/`.
- `e2e/smoke.spec.ts`.
- Script `test:e2e` → builds first, then `playwright test`
  (`pnpm build && playwright test`).
- **Not** added to any CI workflow this round.

### Test

Launch the built app via `_electron.launch({ args: ["."], env: { … } })` against
`out/main/index.js`, using a **temp userData dir** (env override) so the run
touches no real profile.

Assertions — each exercises whole-machine integration the unit suite cannot:

1. **App launches** → obtain the main window via `electronApp.firstWindow()`.
2. **Renderer rendered** → add `data-testid="app-shell"` to the App shell root
   `div` (the single renderer change) and assert it is visible — avoids i18n
   text fragility.
3. **One real IPC round-trip** →
   `window.evaluate(() => window.electronAPI.getSettings())` returns an object
   containing `hotkey` and `themeMode`.

### Known risk (handled in implementation)

The main window is created with `show: false` (tray app). `firstWindow()` should
attach to the hidden window's `webContents`; if it does not, force a show via
`electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())`
before asserting. The single-instance lock is skipped when unpackaged, so launch
is clean.

---

## Testing & verification

- `logger`, `redact`, `file-sink` get pure unit tests in the existing Vitest
  suite.
- E2E verified locally via `pnpm test:e2e`.
- Regression gate unchanged: full `pnpm test` + `pnpm lint` + `pnpm typecheck`
  stay green; the new ESLint `no-console` rule must pass after migration.

## Out-of-scope follow-ups (noted, not done)

- Renderer logging + its 7 `console.*` calls.
- Remote crash/error reporting (audit P1).
- E2E into CI as a non-blocking then blocking job, once stable.
