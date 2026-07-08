# Home redesign, nav consolidation, Agent rename, and startup bug fixes

Status: approved by user, ready for planning
Branch: `fix/startup-toast-hotkey-capture-and-home-redesign`

## Overview

Four related changes, bundled because they touch the same shell/home surface:

1. Fix the startup toast showing the raw AUMID `com.synapse.desktop` instead of "Synapse" + logo, in **both** packaged and `pnpm dev` builds.
2. Fix the launcher hotkey capture UI, which silently fails to record a new binding when the user presses the currently-active global accelerator while capturing.
3. Rename the "智能助手" (Assistant) nav item to **Cortex**, continuing the Synapse (突触) neuron metaphor.
4. Consolidate the sidebar nav (drop "应用启动器" / "桌面悬浮球", which are just link-outs to Settings) and rebuild the Home page into a real status-overview dashboard.

**Explicitly out of scope**: AI-generated "今日推荐" (today's recommendations). The home page reserves a placeholder card for it; the actual Cortex-driven recommendation engine (generation cadence, caching, cost control, failure fallback) is a separate follow-up spec.

## 1. Startup toast identity fix

**Root cause**: Windows resolves a toast's displayed app name/icon from the Start Menu shortcut registered for the process's AppUserModelID (AUMID), not from the `Notification` title/body. [src/main/index.ts:1125](../../../src/main/index.ts#L1125) sets the AUMID via `app.setAppUserModelId("com.synapse.desktop")`, but that only affects the *running process's* identity — Windows still needs a `.lnk` with a matching `System.AppUserModel.ID` property to know the AUMID maps to display name "Synapse" + the app icon.

- **Packaged (NSIS)**: electron-builder creates this Start Menu shortcut at install time with the right AUMID, name, and icon. No code change needed — verify [package.json](../../../package.json) `nsis` config still produces it (manual smoke check during implementation, not a code change).
- **Dev (`pnpm dev`)**: no shortcut exists, so Windows falls back to showing the raw AUMID string. Fix: on first `app.whenReady()` in dev mode on Windows, create/refresh a Start Menu shortcut dedicated to dev builds.

### Design

New module `src/main/dev-app-shortcut.ts`:

```ts
export function devShortcutPath(): string // %APPDATA%\Microsoft\Windows\Start Menu\Programs\Synapse (Dev).lnk
export function buildShortcutScript(opts: { shortcutPath: string, targetExe: string, appDir: string, iconPath: string, aumid: string }): string // returns the PowerShell script text
export async function ensureDevAppUserModelShortcut(): Promise<void> // orchestrates: skip if already exists, else run the PowerShell script via child_process.execFile
```

- `devShortcutPath` / `buildShortcutScript` are pure and unit-tested directly (string/path assembly, no I/O).
- `ensureDevAppUserModelShortcut` is the untestable seam (spawns `powershell.exe`) — excluded from coverage like other orchestration entrypoints, consistent with existing convention for `src/main/index.ts`.
- The PowerShell script: creates the `.lnk` via `WScript.Shell` (target = `process.execPath`, working dir = `app.getAppPath()`, icon = `resources/icon.ico`), then stamps `System.AppUserModel.ID` on it via the standard `IPropertyStore` COM interop snippet (inline C# via `Add-Type`, the well-established technique for setting shortcut AUMIDs from PowerShell — no new npm dependency).
- Guard: only runs when `!app.isPackaged && process.platform === "win32"`. Skips regeneration if the shortcut file already exists (cheap `fs.existsSync` check) — this is dev-only convenience, not something that needs to self-heal every launch.
- Called once in `app.whenReady()` in [src/main/index.ts](../../../src/main/index.ts), before `showStartupNotification`.
- Failure handling: wrap in try/catch, log a warning via the existing `logger`, and continue startup — this must never block app launch.

## 2. Hotkey capture bug fix

**Root cause**: [src/main/index.ts:1030](../../../src/main/index.ts#L1030) keeps the global accelerator registered (via `globalShortcut.register`) for the entire time the Settings window is open. Windows intercepts a registered global hotkey at the OS level (`WM_HOTKEY`), which never reaches the focused renderer as a normal keydown DOM event. So when a user opens the hotkey-capture input and presses the **currently bound** combination (the most natural first thing to try), Electron's `toggleSearchWindow` fires instead — the launcher window pops over Settings — and the capture input never sees the keystroke. It looks broken.

The renderer-side capture logic in [launcher-settings.tsx](../../../src/renderer/src/components/launcher-settings.tsx) itself is correct and already covered by its test suite — no change needed there beyond the two new calls below.

### Design

Extend [src/main/shortcut.ts](../../../src/main/shortcut.ts) with two pure functions:

```ts
export function suspendGlobalShortcut(): void   // globalShortcut.unregister(currentAccelerator) without clearing currentAccelerator
export function resumeGlobalShortcut(handler: () => void): boolean // re-registers currentAccelerator if one is set; no-op returning true if none
```

New IPC (4-touchpoint pattern per CLAUDE.md):

1. Pure logic: the two functions above (already testable via the existing `shortcut.ts` module — add a `shortcut.test.ts` if one doesn't exist).
2. Main binding in `src/main/index.ts`: `ipcMain.handle("launcher:pause-hotkey", ...)` / `ipcMain.handle("launcher:resume-hotkey", ...)`, wired to `suspendGlobalShortcut()` / `resumeGlobalShortcut(() => toggleSearchWindow(searchWindowDeps()))`.
3. Preload: `pauseHotkeyCapture` / `resumeHotkeyCapture` on `electronAPI`.
4. Renderer wrapper: same names exported from [lib/electron.ts](../../../src/renderer/src/lib/electron.ts).

In `launcher-settings.tsx`:
- `onCaptureHotkey()` calls `pauseHotkeyCapture()` before focusing the input.
- Capture end (successful capture in `onHotkeyKeyDown`, Escape-cancel, and `onBlur`) calls `resumeHotkeyCapture()`. All three paths already funnel through `setCapturingHotkey(false)` — add the IPC call alongside each.
- If the user never saves (just cancels), the original accelerator is restored exactly as before (unaffected — `currentAccelerator` was never cleared, only unregistered).

## 3. Rename "Assistant" → Cortex

- Display string: `Cortex`, unlocalized in both `en.json` and `zh-CN.json` (kept as a proper noun, matching how "Synapse" itself isn't translated).
- Rename the internal `NavId` value `"assistant"` → `"cortex"` for clarity (the display name and the internal id no longer need to disagree). Ripples through:
  - [app-shell.tsx](../../../src/renderer/src/components/app-shell.tsx): `NavId` union, `NAV_IDS`, hash routing (`#/cortex`), `navKey` mapping, sidebar menu item.
  - i18n key: rename `nav.assistant` → `nav.cortex` in both locale files.
  - Any test fixtures / other references to the `"assistant"` NavId (grep before implementation to catch all call sites).
- Icon: swap `Bot` for `Brain` (lucide-react) — better evokes "Cortex" than a generic bot glyph.
- `ChatPage` component name, file path, and internal conversation logic are unchanged — only the nav-facing identity changes.

## 4. Nav consolidation + Home page redesign

### Nav consolidation

Remove `"app-launcher"` and `"floating-ball"` from `NavId`, `NAV_IDS`, the sidebar's "功能" group, the lazy imports, and the render switch in `app-shell.tsx`. Delete [app-launcher-page.tsx](../../../src/renderer/src/components/pages/app-launcher-page.tsx) and [floating-ball-page.tsx](../../../src/renderer/src/components/pages/floating-ball-page.tsx) along with any tests for them — both are pure link-outs to Settings today, superseded by the Home page's new frequent-apps card (for launcher) and by Settings' existing `LauncherSettings` / `FloatingBallSettings` (for configuration). Before deleting, grep for any other in-app deep link that navigates to `"app-launcher"` or `"floating-ball"` (e.g. onboarding hints, tray menu) and repoint those to `"settings"` or `"home"`.

Resulting top-level nav: 主页(Home) · Cortex · 局域网传输(LAN Transfer) · 插件(Plugins) · 应用市场(Marketplace) · 设置(Settings) — 6 items, down from 8.

**Do not touch** the unrelated `"floating-ball"` string in [App.tsx](../../../src/renderer/src/App.tsx) (`RendererRoute`, bare hash `#floating-ball`) and [floating-ball-window.ts](../../../src/main/floating-ball-window.ts) (`FLOATING_BALL_HASH`) — that's the separate overlay `BrowserWindow`'s own routing discriminator, namespaced apart from the main shell's `#/floating-ball` NavId route by the missing `/`. Only the `app-shell.tsx` `NavId` and its `#/floating-ball` hash route are in scope for removal.

### Home page

Replace [home-page.tsx](../../../src/renderer/src/components/pages/home-page.tsx)'s single "quick actions" card with, top to bottom:

1. **Header** — unchanged (logo + `app.title` + `app.subtitle`).
2. **"今日推荐" placeholder card** — static content only (e.g. "Cortex 正在学习你的使用习惯，很快会带来个性化建议"), visually marked as upcoming. No data, no logic. Reserved slot for the follow-up Cortex-recommendations spec.
3. **Cortex quick-entry card** (full width) — shows a one-line teaser of the most recently updated conversation (via `listAiConversations()`, sorted by `updatedAt` desc) with a "继续对话" CTA, or "开始新对话" if none exist. Clicking navigates to `onNavigate("cortex")`; `ChatPage` already owns which conversation is active on mount, so this card only needs to route there, not pass conversation state.
4. **Two cards side by side**:
   - **常用应用 (Frequent Apps)** — App-Store-style grid: icon + name + relative "last used" time (e.g. "2 小时前"). Small "↻ 重新扫描" affordance in the card header (calls existing `refreshApps()`). Clicking an app calls existing `launchApp(id)`.
   - **插件 (Plugins)** — segmented toggle: "可更新" / "热门市场". Defaults to "可更新" if at least one installed plugin has a newer marketplace version, else defaults to "热门市场".
5. **Quick Actions card is removed entirely.** Rescanning is only reachable via the small button on the Frequent Apps card and via Settings' `LauncherSettings` (which already has a rescan button) — no separate top-level action needed.

Two-column row collapses to stacked single column below a reasonable width (matches existing responsive card behavior elsewhere in the app — no new breakpoint system needed).

#### Frequent Apps — new usage tracking

No usage data exists today. Add it to the existing settings persistence rather than a new store:

- Extend `UserSettings` ([src/main/settings/settings.ts](../../../src/main/settings/settings.ts)) with `appUsage: Record<string, { lastLaunchedAt: number; launchCount: number }>`, keyed by `AppEntry.id`. Update `normalizeSettings`/`defaultSettings` accordingly (empty object default; drop entries with malformed shapes on load, same defensive style as `agentShellRoots`).
- `LauncherService.launchById` ([src/main/ipc/launcher-service.ts](../../../src/main/ipc/launcher-service.ts)) records the launch on success: bump `launchCount`, set `lastLaunchedAt = Date.now()`, persist via `saveSettings` directly — **not** through the public `settings:update` channel, so this doesn't fire a `settings:changed` broadcast on every app launch (that event is for user-initiated settings edits, not usage telemetry).
- New method `LauncherService.getFrequentApps(limit = 8)`: reads `settings.appUsage`, resolves each id against `this.cache.list()` (drops ids for apps no longer present, e.g. uninstalled), sorts by `lastLaunchedAt` desc, returns the top `limit` as `{ entry: AppEntry; lastLaunchedAt: number }[]`.
- New IPC: `launcher:frequent` → preload `getFrequentApps(limit?)` → renderer wrapper of the same name.
- Relative-time formatting ("2 小时前") is a new small pure helper in the renderer — no existing formatter in the codebase to reuse. Use `Intl.RelativeTimeFormat` (already locale-aware, no new dependency) rather than hand-rolling one.

#### Plugins card data

No new IPC needed — both lists are derived client-side from existing calls:

- **可更新**: cross-reference `listPlugins()` (installed; `manifest.id` + `manifest.version`) against `listMarketplacePlugins()` (`id` + `version`). An entry qualifies if the marketplace version is greater. Since there's no semver dependency in the repo, use a small local dotted-numeric comparator (good enough for the `x.y.z` versions plugins actually use) rather than adding a new package.
- **热门市场**: `searchMarketplace()` (backend-search results, which include `stats.downloads` / `stats.ratingAvg`), sorted by `stats.downloads` desc, top N (~5).

## Testing

- `dev-app-shortcut.ts`: unit tests for `devShortcutPath` and `buildShortcutScript` (pure, no filesystem/process spawning).
- `shortcut.ts`: unit tests for `suspendGlobalShortcut` / `resumeGlobalShortcut` alongside existing `bindGlobalShortcut` coverage.
- `launcher-settings.tsx`: extend existing test suite to assert `pauseHotkeyCapture`/`resumeHotkeyCapture` are called at the right points (mock `electronAPI`).
- `launcher-service.ts` (or wherever usage tracking lands): unit test `launchById` usage-recording and `getFrequentApps` sorting/pruning of stale ids.
- `home-page.tsx`: update/replace existing tests for the new card structure; new tests for frequent-apps rendering, plugin-card toggle + default-tab logic, and the Cortex quick-entry teaser/empty state.
- `app-shell.tsx`: update nav tests for the trimmed `NavId` set and the `cortex` rename.
- Delete tests for `app-launcher-page.tsx` / `floating-ball-page.tsx` along with the pages.

## Follow-up (separate spec, not in this scope)

"Cortex 今日推荐" — AI-generated personalized daily suggestions. Needs its own design pass: generation cadence (per-open vs. daily refresh), caching, cost/latency handling, offline/failure fallback. This spec only reserves the placeholder card's slot in the layout.
