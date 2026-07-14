# Testing

The test stack is Vitest, jsdom, and Testing Library.

## Commands

```bash
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm eval                    # eval suite (vitest.eval.config.ts)
pnpm test:e2e                # development project (no packaged build required)
pnpm test:e2e:packaged       # packaged-smoke only — run after pnpm electron:build:win
```

## Checkpoint R local gate

Run this before opening a release PR or tagging. All commands must pass on **Electron 33.x** +
**electron-builder 25.x** + **electron-updater 6.8.9**:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm eval
pnpm electron:build:win
pnpm test:e2e:packaged
git diff --check
```

`electron:build:win` produces the Windows x64 NSIS/MSI installers under `release/` and an unpacked
tree at `release/win-unpacked/Synapse.exe` that `test:e2e:packaged` exercises. This is the same
packaged readiness proof CI runs in `build-electron.yml`.

Publication profile details, dry-run dispatch, and the tag-release checklist live in
[CI_CD.md](CI_CD.md).

## Layout

Tests live next to the code they cover:

- `src/main/**/*.test.ts`
- `src/preload/**/*.test.ts`
- `src/renderer/src/**/*.test.ts`
- `src/renderer/src/**/*.test.tsx`

`__mocks__/electron.ts` is used to stub Electron in unit tests.

## Notes

- Use `vitest.setup.ts` for shared setup.
- Keep renderer tests focused on UI behavior.
- Keep main-process tests small and pure where possible.

## AI Assistant Smoke Test

The built-in assistant (provider adapters, tool calls, approval gate, memory, MCP) is covered by
unit tests, but a few paths can only be verified end to end with a real API key and the running app.
Run this checklist before a release, or after touching the AI layer. It is BYOK — keys are stored
encrypted on the device and never leave the main process, so use a throwaway/limited key.

Start the app with `pnpm dev`. Open **Assistant** from the sidebar.

### Prerequisites

- [ ] Have an **Anthropic** API key (and optionally an **OpenAI** key for provider switching and
      semantic memory).
- [ ] Install at least one plugin that contributes a tool so the agent has something to call. The
      `create-synapse-plugin` template ships a read-only `greet` tool — scaffold it, then import the
      packaged plugin from the Plugins page.

### 1. Key entry and a tool-calling turn (Anthropic)

- [ ] On the empty chat state (or the gear → **AI settings** dialog) paste the Anthropic key and
      save. The status should flip to "key configured"; the key must never appear in any IPC payload
      or the renderer.
- [ ] Ask: "Use the greet tool to greet Ada." Confirm the streamed reply, a **tool card** that goes
      `running → success`, and that `greet` (read-only) auto-runs **without** an approval dialog.
- [ ] Confirm the per-turn **usage line** (input / output / cached tokens) appears after the turn.

### 2. Approval gate (non-read-only tool)

- [ ] Ask: "Save to memory that my deploy script is scripts/deploy.sh." `memory_save` is not
      read-only, so an **approval dialog** must appear. Choose **Allow once** and confirm it runs.
- [ ] Repeat and choose **Always allow**; the tool should be listed under **Always-allowed tools** in
      AI settings, and a later call must run without asking. Restart the app and confirm the
      always-allow decision **persists**. Revoke it from AI settings and confirm asking resumes.

### 3. Conversation history

- [ ] Send a couple of messages, start a **New conversation**, then reselect the earlier one from the
      sidebar and confirm it rehydrates (messages + tool-card states).
- [ ] Delete a conversation from the sidebar and confirm it disappears.

### 4. Markdown + syntax highlighting

- [ ] Ask for "a TypeScript example and a bash example in fenced code blocks." Confirm code blocks
      render with **shiki** highlighting (colored tokens, not plain text), lists/links render, and
      links open in the OS browser.
- [ ] Toggle the app between light and dark mode and confirm the code theme swaps accordingly.
- [ ] Sanity: the build emits no `.wasm` for shiki (it uses the JS RegExp engine for CSP) —
      `pnpm build` then confirm `out/renderer/assets` has an `engine-javascript-*.js` and no
      `*.wasm`.

### 5. Token budget

- [ ] In AI settings set a small **token budget per turn** (e.g. 200). Ask a question that triggers a
      tool loop and confirm the turn stops early; the usage line shows `used/limit`.
- [ ] Clear the budget (empty or 0) and confirm turns run unbounded again.

### 6. Provider / model switch (OpenAI)

- [ ] In AI settings add an OpenAI key, switch the active provider to OpenAI, pick a model, and rerun
      step 1. Each provider keeps its own key; switching must not clear the other.

### 7. Long-term memory recall

- [ ] After step 2's save, ask something that should recall it ("where does my deploy script live?")
      and confirm `memory_search` returns the stored fact.
- [ ] Ask to "ingest this document into memory" with a few paragraphs of text; confirm
      `memory_ingest` reports a chunk count, then a later search recalls a passage from it.
- [ ] Note: semantic ranking needs an **OpenAI key** (embeddings). With only an Anthropic key, recall
      falls back to lexical term-overlap — still functional, just not semantic.

### 8. External MCP server (inbound)

- [ ] Open **MCP servers** from the chat header. Add a stdio server (e.g. a filesystem MCP via
      `npx`), enable it, and confirm it reaches **connected** with a tool count. Ask the agent to use
      one of its tools.
- [ ] Add an HTTP MCP server with an `Authorization` header. Confirm it connects.
- [ ] Confirm secrets are encrypted at rest: with the app closed, open
      `userData/ai/mcp-servers.json` and verify `env` values and `headers` are **ciphertext**, not
      plaintext. (`userData` is the Electron app-data dir for Synapse.)

### 9. Outbound MCP server (expose Synapse tools)

- [ ] Configure an external client (Claude Desktop / Claude Code) to launch `Synapse --mcp-stdio`.
- [ ] Confirm `tools/list` shows only **read-only** plugin tools (destructive/unannotated tools are
      hidden) and that calling a read-only tool (e.g. `greet`) succeeds.

## Windows Packaging Smoke Test (M3)

`pnpm dev` runs the renderer from the Vite dev server; the packaged app serves it through the custom
`app://` protocol and runs under the strict production CSP. Those paths differ enough that a few
things can only be verified from an installed build (a packaged-IPC trust regression has bitten us
before). Run this on a **clean Windows machine** (or a fresh VM) before a Windows release.

### Build the installers

```bash
pnpm electron:build:win
```

- [ ] Build succeeds and `release/` contains:
  - NSIS installer: `Synapse Setup X.Y.Z.exe`
  - MSI: `Synapse X.Y.Z.msi`
  - Updater feed: `latest.yml` and `Synapse Setup X.Y.Z.exe.blockmap`
  - Unpacked tree: `release/win-unpacked/Synapse.exe` (local smoke input — not a GitHub Release asset)
- [ ] `pnpm test:e2e:packaged` passes (renderer readiness, IPC round-trip, MCP stdio handshake)

### Install and first launch (NSIS)

- [ ] Run the NSIS installer; the "choose install location" step appears (per `nsis.oneClick: false`
      / `allowToChangeInstallationDirectory: true`).
- [ ] The app launches and the window **renders** (no blank/white screen). A blank window means the
      `app://` renderer or preload path failed — check DevTools console for CSP or asset 404s.
- [ ] Open DevTools (or the app's UI) and confirm core IPC works in packaged mode: an app-launcher
      search returns results, and changing a setting (e.g. theme/accent) persists across a restart.
      (Packaged builds load the renderer from `app://app`, whose origin must be trusted for IPC.)

### Shell integration

- [ ] **Tray**: the tray icon appears; left-click / the tray menu open the launcher and the menu
      actions work.
- [ ] **Global hotkey**: the configured shortcut opens the search window from anywhere; rebinding it
      in settings takes effect.
- [ ] **Single instance**: launching the app again focuses the existing window instead of opening a
      second one.
- [ ] **External links**: a markdown/assistant link opens in the OS browser, not inside the app.

### `.syn` file association

- [ ] In Windows Explorer, double-click a `.syn` plugin package. The running app imports it (or, if
      closed, launches and then imports it). Verify the plugin appears on the Plugins page.
- [ ] Confirm the association shows Synapse's icon in Explorer (set via `fileAssociations` /
      `resources/icon.ico`).

### MSI and uninstall

- [ ] The MSI (`Synapse X.Y.Z.msi`) installs and launches the same way.
- [ ] Uninstall via Settings → Apps removes the app and its Start Menu shortcut cleanly.

> Auto-update is verified separately — see the upgrade smoke in the release checklist in
> [CI_CD.md](CI_CD.md). It needs a published GitHub Release, so it cannot be checked from a local
> build alone.

## LAN Transfer Simulation

Use two isolated development instances to manually test LAN transfers on one computer. Start each
instance in a separate terminal:

```bash
pnpm dev:lan:a
pnpm dev:lan:b
```

The windows are labeled `Synapse Sim A` and `Synapse Sim B`. Their development-only profiles are
stored separately under the app `userData/dev-lan-simulator/` directory, so each instance has its
own device identity, certificate, trusted devices, settings, and transfer records.

Manual smoke test:

1. Enable nearby device discovery in both windows.
2. Connect one simulated device to the other.
3. Confirm that both windows display the same six-digit security code.
4. Confirm the connection in both windows.
5. Send a file and accept the save operation in the receiving window.
6. Send a larger file, interrupt one instance during transfer, restart it with the same command,
   and resume the transfer.
