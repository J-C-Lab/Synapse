# Home Redesign, Nav Consolidation, Cortex Rename, and Startup Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the startup-toast identity bug and the hotkey-capture OS-interception bug, rename the "Assistant" nav item to "Cortex", consolidate the sidebar nav, and rebuild the Home page into a real status-overview dashboard (Cortex quick entry, frequent apps, plugin update/trending status).

**Architecture:** Small, focused main-process modules (`shortcut.ts` extension, new `dev-app-shortcut.ts`) get pure helpers with real unit tests, wired into `index.ts` at the existing `app.whenReady()` / IPC-registration seams. Renderer work extracts three new home-page cards (`cortex-quick-entry-card.tsx`, `frequent-apps-card.tsx`, `plugins-status-card.tsx`) as isolated components rather than growing `home-page.tsx` into a monolith, plus two small pure helpers (`format-relative-time.ts`, `plugin-version.ts`). All new interactive UI reuses existing shadcn primitives already vendored in this repo (`Tabs`, `Skeleton`, `Button`) rather than hand-rolled widgets, per the project's accessibility/primitive-reuse conventions.

**Tech Stack:** electron-vite, Electron 33, React 19, TypeScript 5 strict, Tailwind v4, shadcn/ui, i18next, Vitest.

---

## Before you start

Read [docs/superpowers/specs/2026-07-08-home-redesign-and-startup-fixes-design.md](../specs/2026-07-08-home-redesign-and-startup-fixes-design.md) first — this plan implements it. Two implementation details refine the spec (discovered while grounding this plan in the actual code) and take precedence over the spec's wording:

1. **Plugin update/trending data** comes from `searchMarketplace()` + `listPlugins()` only — **not** `listMarketplacePlugins()`. The live backend's `PluginSummary` already carries `latestVersion` and `stats.downloads`, which is exactly what "可更新" / "热门市场" need, and it's what [marketplace-page.tsx](../../../src/renderer/src/components/pages/marketplace-page.tsx) already uses for its own installed/available comparison — reusing the same source avoids mixing two different marketplace subsystems (the curated static registry vs. the live backend).
2. **"继续对话" actually resumes** the conversation (loads its message history), not just a label. This needs a small amount of plumbing through `AppShell` and a one-line change to `ChatPage` (Task 14) — detailed below.

**UI/UX bar for every new surface in this plan:** every new interactive element is a real `button`/`Tabs` (never a clickable `div`), every icon-only control has an `aria-label`, every empty state gives exactly one working next action, no new gradients/glows, no animation beyond what already exists in the codebase (the existing `animate-spin` refresh-icon pattern), and loading states use the `Skeleton` primitive (already vendored, currently unused anywhere in the app) instead of a bare spinner. Component-level detail on this is called out per task below — do not skip it because "the spec didn't say so."

---

## Task 1: Extend the Electron test mock with `globalShortcut`

`shortcut.ts` has **zero existing test coverage** because `__mocks__/electron.ts` doesn't mock `globalShortcut` at all — importing it in a test would be `undefined`. Fix the shared mock first so Task 2 can write real tests.

**Files:**
- Modify: `__mocks__/electron.ts`

- [ ] **Step 1: Add the `globalShortcut` mock**

In [__mocks__/electron.ts](../../../__mocks__/electron.ts), add after the `clipboard` export (around line 132):

```ts
export const globalShortcut = {
  register: vi.fn(() => true),
  unregister: vi.fn(),
  isRegistered: vi.fn(() => false),
}
```

And add `globalShortcut` to the `default` export object at the bottom (the object currently listing `contextBridge, ipcRenderer, ipcMain, app, ...`):

```ts
export default {
  contextBridge,
  ipcRenderer,
  ipcMain,
  app,
  BrowserWindow,
  session,
  screen,
  nativeImage,
  Notification,
  Menu,
  Tray,
  protocol,
  net,
  shell,
  dialog,
  safeStorage,
  clipboard,
  desktopCapturer,
  globalShortcut,
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add __mocks__/electron.ts
git commit -m "test: mock globalShortcut in the shared Electron test double"
```

---

## Task 2: `suspendGlobalShortcut` / `resumeGlobalShortcut`

Fixes the actual hotkey-capture bug: while the Settings window's capture input is focused, the global accelerator must not be live, or Windows intercepts the keystroke as `WM_HOTKEY` before it ever reaches the renderer.

**Files:**
- Modify: `src/main/shortcut.ts`
- Create: `src/main/shortcut.test.ts`

- [ ] **Step 1: Write the failing tests**

Create [src/main/shortcut.test.ts](../../../src/main/shortcut.test.ts):

```ts
import { globalShortcut } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  bindGlobalShortcut,
  currentBinding,
  resumeGlobalShortcut,
  suspendGlobalShortcut,
  unbindGlobalShortcut,
} from "./shortcut"

describe("suspendGlobalShortcut / resumeGlobalShortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unbindGlobalShortcut()
  })

  it("does nothing when no accelerator is bound", () => {
    suspendGlobalShortcut()
    expect(globalShortcut.unregister).not.toHaveBeenCalled()
    expect(resumeGlobalShortcut(() => {})).toBe(true)
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it("unregisters the current accelerator without forgetting it", () => {
    bindGlobalShortcut("Control+Space", () => {})
    suspendGlobalShortcut()
    expect(globalShortcut.unregister).toHaveBeenCalledWith("Control+Space")
    expect(currentBinding()).toBe("Control+Space")
  })

  it("re-registers the suspended accelerator on resume", () => {
    const handler = () => {}
    bindGlobalShortcut("Control+Space", handler)
    suspendGlobalShortcut()
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(false)

    const ok = resumeGlobalShortcut(handler)

    expect(ok).toBe(true)
    expect(globalShortcut.register).toHaveBeenCalledWith("Control+Space", handler)
  })

  it("is a no-op resume if the accelerator is already registered", () => {
    bindGlobalShortcut("Control+Space", () => {})
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(true)
    vi.mocked(globalShortcut.register).mockClear()

    expect(resumeGlobalShortcut(() => {})).toBe(true)
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it("returns false if re-registering fails", () => {
    bindGlobalShortcut("Control+Space", () => {})
    suspendGlobalShortcut()
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(false)
    vi.mocked(globalShortcut.register).mockReturnValue(false)

    expect(resumeGlobalShortcut(() => {})).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/shortcut.test.ts`
Expected: FAIL — `suspendGlobalShortcut` / `resumeGlobalShortcut` are not exported yet.

- [ ] **Step 3: Implement**

In [src/main/shortcut.ts](../../../src/main/shortcut.ts), add after `unbindGlobalShortcut`:

```ts
/**
 * Temporarily unregister the current accelerator without forgetting it.
 * Use this while a UI surface wants to capture the *next* raw keystroke
 * (e.g. the hotkey-rebind input) — otherwise Windows intercepts the
 * currently-bound combination at the OS level (WM_HOTKEY) and it never
 * reaches the focused renderer as a keydown event.
 */
export function suspendGlobalShortcut(): void {
  if (currentAccelerator) globalShortcut.unregister(currentAccelerator)
}

/** Re-registers the accelerator suspended by {@link suspendGlobalShortcut}. */
export function resumeGlobalShortcut(handler: () => void): boolean {
  if (!currentAccelerator) return true
  if (globalShortcut.isRegistered(currentAccelerator)) return true
  try {
    return globalShortcut.register(currentAccelerator, handler)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/main/shortcut.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/shortcut.ts src/main/shortcut.test.ts
git commit -m "fix(shortcut): allow suspending the global accelerator during capture"
```

---

## Task 3: Wire suspend/resume through IPC

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

- [ ] **Step 1: Main process — import and register handlers**

In [src/main/index.ts](../../../src/main/index.ts) line 116, change:

```ts
import { bindGlobalShortcut, unbindGlobalShortcut } from "./shortcut"
```

to:

```ts
import {
  bindGlobalShortcut,
  resumeGlobalShortcut,
  suspendGlobalShortcut,
  unbindGlobalShortcut,
} from "./shortcut"
```

Then in `registerIpc()`, add after the `settings:update` handler block (after the closing of that handler, before `refreshTrayMenu`/`syncFloatingBallWindow` calls — insert as new handlers alongside the other `ipcMain.handle("launcher:...")` calls, e.g. right after `ipcMain.handle("launcher:refresh", ...)` at line 283):

```ts
  ipcMain.handle("launcher:pause-hotkey", () => {
    suspendGlobalShortcut()
  })

  ipcMain.handle("launcher:resume-hotkey", () => {
    return resumeGlobalShortcut(() => toggleSearchWindow(searchWindowDeps()))
  })
```

- [ ] **Step 2: Preload — expose the two calls**

In [src/preload/index.ts](../../../src/preload/index.ts), add to the `// ---- Launcher ----` group (after `notifyLauncherReady`, around line 30):

```ts
  pauseHotkeyCapture: () => ipcRenderer.invoke("launcher:pause-hotkey"),
  resumeHotkeyCapture: () => ipcRenderer.invoke("launcher:resume-hotkey"),
```

- [ ] **Step 3: Preload types**

In [src/preload/index.d.ts](../../../src/preload/index.d.ts), add to the `Window["electronAPI"]` interface (after `notifyLauncherReady: () => void` at line 462):

```ts
      pauseHotkeyCapture: () => Promise<void>
      resumeHotkeyCapture: () => Promise<boolean>
```

- [ ] **Step 4: Renderer wrapper**

In [src/renderer/src/lib/electron.ts](../../../src/renderer/src/lib/electron.ts), add after `hideLauncher` (around line 106):

```ts
export async function pauseHotkeyCapture(): Promise<void> {
  await api().pauseHotkeyCapture()
}

export async function resumeHotkeyCapture(): Promise<boolean> {
  return api().resumeHotkeyCapture()
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(ipc): expose pause/resume for the global launcher hotkey"
```

---

## Task 4: Fix the capture flow in `launcher-settings.tsx`

**Files:**
- Modify: `src/renderer/src/components/launcher-settings.tsx`
- Modify: `src/renderer/src/components/launcher-settings.test.tsx`

- [ ] **Step 1: Write the failing tests**

In [src/renderer/src/components/launcher-settings.test.tsx](../../../src/renderer/src/components/launcher-settings.test.tsx), add `pauseHotkeyCapture: vi.fn().mockResolvedValue(undefined)` and `resumeHotkeyCapture: vi.fn().mockResolvedValue(true)` to the `installElectronApi` mock object (alongside `hideLauncher` in the `// ---- Launcher ----`-equivalent block), then add these new test cases at the end of the `describe("launcher settings", ...)` block, before the closing `})`:

```ts
  it("pauses the global hotkey while capturing and resumes after a successful capture", async () => {
    const api = installElectronApi({
      hotkey: "Control+Space",
      themeMode: "system",
      accent: "neutral",
      floatingBallEnabled: false,
      floatingBallFeatures: [],
      lanEnabled: false,
      trustedSourcePolicy: "official-marketplace",
      allowAgentShell: false,
      agentShellRoots: [],
    })
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    expect(api.pauseHotkeyCapture).toHaveBeenCalledTimes(1)
    expect(api.resumeHotkeyCapture).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { altKey: true, code: "Space", key: " " })
    expect(api.resumeHotkeyCapture).toHaveBeenCalledTimes(1)
  })

  it("resumes the global hotkey when capture is cancelled with Escape", async () => {
    const api = installElectronApi({
      hotkey: "Control+Space",
      themeMode: "system",
      accent: "neutral",
      floatingBallEnabled: false,
      floatingBallFeatures: [],
      lanEnabled: false,
      trustedSourcePolicy: "official-marketplace",
      allowAgentShell: false,
      agentShellRoots: [],
    })
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    fireEvent.keyDown(input, { code: "Escape", key: "Escape" })

    expect(api.resumeHotkeyCapture).toHaveBeenCalledTimes(1)
  })

  it("resumes the global hotkey when the input loses focus mid-capture", async () => {
    const api = installElectronApi({
      hotkey: "Control+Space",
      themeMode: "system",
      accent: "neutral",
      floatingBallEnabled: false,
      floatingBallFeatures: [],
      lanEnabled: false,
      trustedSourcePolicy: "official-marketplace",
      allowAgentShell: false,
      agentShellRoots: [],
    })
    const user = userEvent.setup()
    render(<LauncherSettings />)

    const input = await screen.findByLabelText("launcher.settings.hotkeyLabel")
    await user.click(screen.getByRole("button", { name: "launcher.settings.capture" }))
    fireEvent.blur(input)

    expect(api.resumeHotkeyCapture).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/renderer/src/components/launcher-settings.test.tsx`
Expected: FAIL — `pauseHotkeyCapture`/`resumeHotkeyCapture` never called (not wired yet).

- [ ] **Step 3: Implement**

In [src/renderer/src/components/launcher-settings.tsx](../../../src/renderer/src/components/launcher-settings.tsx):

Add to the import from `@/lib/electron` (line 18):

```ts
import {
  getSettings,
  isElectron,
  pauseHotkeyCapture,
  refreshApps,
  resumeHotkeyCapture,
  updateSettings,
} from "@/lib/electron"
```

Update `onHotkeyKeyDown` (currently lines 164–185) so both exit paths resume the hotkey:

```ts
  function onHotkeyKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!capturingHotkey) return

    event.preventDefault()
    event.stopPropagation()

    if (event.key === "Escape") {
      setCapturingHotkey(false)
      void resumeHotkeyCapture()
      return
    }

    if (modifierKeys.has(event.key)) {
      return
    }

    const next = acceleratorFromKeyboardEvent(event)
    if (!next) return

    setStatus(null)
    setHotkey(next)
    setCapturingHotkey(false)
    void resumeHotkeyCapture()
  }
```

Update `onCaptureHotkey` (currently lines 187–191):

```ts
  function onCaptureHotkey() {
    setCapturingHotkey(true)
    setStatus(null)
    void pauseHotkeyCapture()
    hotkeyInputRef.current?.focus()
  }
```

Update the input's `onBlur` (currently `onBlur={() => setCapturingHotkey(false)}` around line 249):

```tsx
              onBlur={() => {
                if (!capturingHotkey) return
                setCapturingHotkey(false)
                void resumeHotkeyCapture()
              }}
```

(The guard matters: `onBlur` fires on every blur, including ones unrelated to capture — only resume if a capture was actually in progress, otherwise every unrelated blur would call `resumeHotkeyCapture()` needlessly.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/renderer/src/components/launcher-settings.test.tsx`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/launcher-settings.tsx src/renderer/src/components/launcher-settings.test.tsx
git commit -m "fix(launcher-settings): suspend the global hotkey while capturing a new one"
```

---

## Task 5: Dev-mode AUMID shortcut — pure helpers

Fixes the `com.synapse.desktop` toast-title bug in `pnpm dev`. Packaged (NSIS) builds already register a correct Start Menu shortcut; only dev mode is missing one.

**Files:**
- Create: `src/main/dev-app-shortcut.ts`
- Create: `src/main/dev-app-shortcut.test.ts`

- [ ] **Step 1: Write the failing tests**

Create [src/main/dev-app-shortcut.test.ts](../../../src/main/dev-app-shortcut.test.ts):

```ts
import { describe, expect, it } from "vitest"
import { buildShortcutScript, devShortcutPath } from "./dev-app-shortcut"

describe("devShortcutPath", () => {
  it("places the shortcut in the current user's Start Menu Programs folder", () => {
    const result = devShortcutPath("C:\\Users\\jackie\\AppData\\Roaming")
    expect(result).toBe(
      "C:\\Users\\jackie\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Synapse (Dev).lnk"
    )
  })
})

describe("buildShortcutScript", () => {
  const opts = {
    shortcutPath: "C:\\Start Menu\\Synapse (Dev).lnk",
    targetExe: "C:\\node_modules\\electron\\dist\\electron.exe",
    appDir: "D:\\Programs\\A My Code\\Synapse",
    iconPath: "D:\\Programs\\A My Code\\Synapse\\resources\\icon.ico",
    aumid: "com.synapse.desktop",
  }

  it("embeds every path and the AUMID in the generated script", () => {
    const script = buildShortcutScript(opts)
    expect(script).toContain(opts.shortcutPath)
    expect(script).toContain(opts.targetExe)
    expect(script).toContain(opts.appDir)
    expect(script).toContain(opts.iconPath)
    expect(script).toContain(opts.aumid)
  })

  it("creates the shortcut via WScript.Shell before stamping the AUMID", () => {
    const script = buildShortcutScript(opts)
    const createIndex = script.indexOf("WScript.Shell")
    const aumidIndex = script.indexOf(opts.aumid)
    expect(createIndex).toBeGreaterThan(-1)
    expect(aumidIndex).toBeGreaterThan(createIndex)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/main/dev-app-shortcut.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the pure helpers + orchestration**

Create [src/main/dev-app-shortcut.ts](../../../src/main/dev-app-shortcut.ts):

```ts
import { existsSync } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { app } from "electron"
import { logger } from "./logging"

const SHORTCUT_NAME = "Synapse (Dev).lnk"
const AUMID = "com.synapse.desktop"

/** Start Menu path for the dev-only shortcut, given `%APPDATA%`. */
export function devShortcutPath(appDataDir: string): string {
  return path.join(appDataDir, "Microsoft", "Windows", "Start Menu", "Programs", SHORTCUT_NAME)
}

interface ShortcutScriptOptions {
  shortcutPath: string
  targetExe: string
  appDir: string
  iconPath: string
  aumid: string
}

/**
 * PowerShell script that (1) creates a `.lnk` via the standard WScript.Shell
 * automation object, then (2) stamps `System.AppUserModel.ID` on it via
 * IPropertyStore COM interop — WScript.Shell has no AUMID property, so this
 * second step is the well-established way to set it from PowerShell without
 * a native module. Windows resolves a toast notification's displayed name
 * and icon from the Start Menu shortcut registered for the running
 * process's AUMID; without a matching shortcut, it falls back to showing
 * the raw AUMID string, which is the bug this fixes in `pnpm dev`.
 */
export function buildShortcutScript(opts: ShortcutScriptOptions): string {
  return `
$ErrorActionPreference = "Stop"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("${opts.shortcutPath}")
$Shortcut.TargetPath = "${opts.targetExe}"
$Shortcut.WorkingDirectory = "${opts.appDir}"
$Shortcut.IconLocation = "${opts.iconPath}"
$Shortcut.Save()

Add-Type @"
using System;
using System.Runtime.InteropServices;

public struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT {
    public ushort vt;
    public ushort wReserved1, wReserved2, wReserved3;
    public IntPtr p;
    public int p2;
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    int Commit();
}

[ComImport, Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3")]
public class CShellLink { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellLinkW {
    int GetPath([Out] char[] pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
    int GetIDList(out IntPtr ppidl);
    int SetIDList(IntPtr pidl);
    int GetDescription([Out] char[] pszName, int cchMaxName);
    int SetDescription(string pszName);
    int GetWorkingDirectory([Out] char[] pszDir, int cchMaxPath);
    int SetWorkingDirectory(string pszDir);
    int GetArguments([Out] char[] pszArgs, int cchMaxPath);
    int SetArguments(string pszArgs);
    int GetHotkey(out short wHotkey);
    int SetHotkey(short wHotkey);
    int GetShowCmd(out int iShowCmd);
    int SetShowCmd(int iShowCmd);
    int GetIconLocation([Out] char[] pszIconPath, int cchIconPath, out int iIcon);
    int SetIconLocation(string pszIconPath, int iIcon);
    int SetRelativePath(string pszPathRel, uint dwReserved);
    int Resolve(IntPtr hwnd, uint fFlags);
    int SetPath(string pszFile);
}

public static class AumidStamper {
    public static void Stamp(string shortcutPath, string aumid) {
        var link = (IShellLinkW)new CShellLink();
        var persistFile = (System.Runtime.InteropServices.ComTypes.IPersistFile)link;
        persistFile.Load(shortcutPath, 0);

        var store = (IPropertyStore)link;
        var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        var value = new PROPVARIANT { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(aumid) };
        store.SetValue(ref key, ref value);
        store.Commit();
        persistFile.Save(shortcutPath, true);
        Marshal.FreeCoTaskMem(value.p);
    }
}
"@ -ReferencedAssemblies System.Runtime.InteropServices

[AumidStamper]::Stamp("${opts.shortcutPath}", "${opts.aumid}")
`.trim()
}

/**
 * Dev-only convenience: without an installed Start Menu shortcut, Windows
 * shows the raw AUMID instead of "Synapse" + the app icon on the startup
 * toast. Creates one once per machine; safe to call on every launch since
 * it's a no-op after the first successful run. Never throws — a failure
 * here must not block app startup.
 */
export async function ensureDevAppUserModelShortcut(): Promise<void> {
  if (app.isPackaged || process.platform !== "win32") return

  const appData = process.env.APPDATA
  if (!appData) return
  const shortcutPath = devShortcutPath(appData)
  if (existsSync(shortcutPath)) return

  const script = buildShortcutScript({
    shortcutPath,
    targetExe: process.execPath,
    appDir: app.getAppPath(),
    iconPath: path.join(app.getAppPath(), "resources", "icon.ico"),
    aumid: AUMID,
  })

  const { execFile } = await import("node:child_process")
  await new Promise<void>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      (err) => {
        if (err) {
          logger
            .child("synapse")
            .warn("failed to create dev Start Menu shortcut for toast identity", { err })
        }
        resolve()
      }
    )
  })
}
```

- [ ] **Step 4: Run to verify the pure-function tests pass**

Run: `pnpm vitest run src/main/dev-app-shortcut.test.ts`
Expected: PASS (3 tests). `ensureDevAppUserModelShortcut` is intentionally untested here — it spawns a real process, same testability tier as other orchestration entrypoints in `index.ts`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/dev-app-shortcut.ts src/main/dev-app-shortcut.test.ts
git commit -m "feat(dev): create a Start Menu shortcut so dev-mode toasts show Synapse's identity"
```

---

## Task 6: Wire the dev shortcut into startup + manual verification

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Import and call it in `app.whenReady()`**

In [src/main/index.ts](../../../src/main/index.ts), add the import near the other local imports (alphabetically, before `defaultNotificationIcon`/`showStartupNotification` at line 100):

```ts
import { ensureDevAppUserModelShortcut } from "./dev-app-shortcut"
```

In the `app.whenReady()` block, right after the existing AUMID call (lines 1119–1126):

```ts
      if (process.platform === "win32") {
        app.setAppUserModelId("com.synapse.desktop")
        void ensureDevAppUserModelShortcut()
      }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification (required — this code path has no automated test)**

Run: `pnpm dev` on Windows. On first launch, check `%APPDATA%\Microsoft\Windows\Start Menu\Programs\` for `Synapse (Dev).lnk`. Quit the app fully and relaunch — the startup toast notification should now show "Synapse" with the app icon instead of `com.synapse.desktop`. If it still shows the raw AUMID, Windows Action Center can cache toast identity per-AUMID between the shortcut's creation and the next toast — restart Windows Explorer (`taskkill /f /im explorer.exe && start explorer.exe`) or reboot once, then relaunch and re-check.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(dev): wire the dev Start Menu shortcut into app startup"
```

---

## Task 7: Rename "Assistant" → Cortex

**Files:**
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`
- Modify: `src/renderer/src/i18n/messages/en.json`
- Modify: `src/renderer/src/components/app-shell.tsx`

- [ ] **Step 1: i18n — rename the nav key in both locale files**

In [zh-CN.json](../../../src/renderer/src/i18n/messages/zh-CN.json) line 16, change:

```json
    "assistant": "智能助手",
```

to:

```json
    "cortex": "Cortex",
```

In [en.json](../../../src/renderer/src/i18n/messages/en.json) line 16, change:

```json
    "assistant": "Assistant",
```

to:

```json
    "cortex": "Cortex",
```

(Note: `chat.title`, `chat.onboarding.headline`, etc. — the copy *inside* the Cortex chat page itself — are untouched; this task only renames the nav-facing identity. Leaving the in-page copy as "智能助手"/"Assistant" is an intentional, separate follow-up, not a bug — the nav label is what the user asked to change.)

- [ ] **Step 2: Rename the `NavId` and update `app-shell.tsx`**

In [src/renderer/src/components/app-shell.tsx](../../../src/renderer/src/components/app-shell.tsx):

Change the `Bot` import (line 2) to `Brain`:

```ts
import {
  Brain,
  CircleDot,
  House,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  Store,
  Wifi,
} from "lucide-react"
```

Change the `NavId` union and `NAV_IDS` (lines 58–77):

```ts
export type NavId =
  | "home"
  | "cortex"
  | "settings"
  | "app-launcher"
  | "floating-ball"
  | "plugins"
  | "marketplace"
  | "lan-transfer"

const NAV_IDS = new Set<NavId>([
  "home",
  "cortex",
  "settings",
  "app-launcher",
  "floating-ball",
  "plugins",
  "marketplace",
  "lan-transfer",
])
```

(The `"app-launcher"` / `"floating-ball"` entries are removed in Task 8 — leave them for this task so the diff stays focused on the rename.)

Change the sidebar menu item (lines 144–153):

```tsx
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "cortex"}
                    onClick={() => setNav("cortex")}
                    tooltip={t("nav.cortex")}
                  >
                    <Brain />
                    <span>{t("nav.cortex")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
```

Change the render switch (line 269):

```tsx
              {nav === "cortex" && <ChatPage />}
```

Change the `main`/inner-`div` conditional classes (lines 246 and 254) from `nav === "assistant"` to `nav === "cortex"`.

Change `navKey` (lines 285–303):

```ts
function navKey(id: NavId): string {
  switch (id) {
    case "home":
      return "home"
    case "cortex":
      return "cortex"
    case "settings":
      return "settings"
    case "app-launcher":
      return "appLauncher"
    case "floating-ball":
      return "floatingBall"
    case "plugins":
      return "plugins"
    case "marketplace":
      return "marketplace"
    case "lan-transfer":
      return "lanTransfer"
  }
}
```

- [ ] **Step 3: Grep for any other reference to the old `"assistant"` NavId**

Run: `grep -rn '"assistant"' src/renderer/src --include=*.tsx --include=*.ts`
Expected: no remaining hits outside `chat.title`/`chat.*` i18n keys (which are untouched prose, not the NavId). If any `.test.tsx` file asserts on `nav === "assistant"` or navigates via hash `#/assistant`, update it to `"cortex"` / `#/cortex`.

- [ ] **Step 4: Typecheck and run the shell's existing tests**

Run: `pnpm typecheck && pnpm vitest run src/renderer/src/components/app-shell.test.tsx`
(If no such test file exists yet, skip the vitest run for this step — Task 8 adds nav tests.)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/i18n/messages/zh-CN.json src/renderer/src/i18n/messages/en.json src/renderer/src/components/app-shell.tsx
git commit -m "rename(nav): Assistant -> Cortex, continuing the Synapse neuron metaphor"
```

---

## Task 8: Remove the "App Launcher" / "Floating Ball" nav tabs

**Files:**
- Modify: `src/renderer/src/components/app-shell.tsx`
- Delete: `src/renderer/src/components/pages/app-launcher-page.tsx`
- Delete: `src/renderer/src/components/pages/floating-ball-page.tsx`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`
- Modify: `src/renderer/src/i18n/messages/en.json`
- Create: `src/renderer/src/components/app-shell.test.tsx`

- [ ] **Step 1: Write a failing nav test**

Create [src/renderer/src/components/app-shell.test.tsx](../../../src/renderer/src/components/app-shell.test.tsx):

```tsx
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "./app-shell"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => false,
}))

afterEach(() => {
  cleanup()
  window.location.hash = ""
})

describe("AppShell nav", () => {
  it("no longer offers App Launcher or Floating Ball as top-level tabs", () => {
    render(<AppShell />)
    expect(screen.queryByText("nav.appLauncher")).not.toBeInTheDocument()
    expect(screen.queryByText("nav.floatingBall")).not.toBeInTheDocument()
  })

  it("shows the renamed Cortex tab", () => {
    render(<AppShell />)
    expect(screen.getByText("nav.cortex")).toBeInTheDocument()
  })

  it("ignores a stale #/app-launcher hash and falls back to home", () => {
    window.location.hash = "#/app-launcher"
    render(<AppShell />)
    expect(screen.getByText("nav.home")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/renderer/src/components/app-shell.test.tsx`
Expected: FAIL — `nav.appLauncher` / `nav.floatingBall` still render today.

- [ ] **Step 3: Remove the nav entries and lazy imports**

In [src/renderer/src/components/app-shell.tsx](../../../src/renderer/src/components/app-shell.tsx):

Remove the two lazy imports (currently lines 42–47):

```ts
const AppLauncherPage = lazy(() =>
  import("@/components/pages/app-launcher-page").then((m) => ({ default: m.AppLauncherPage }))
)
const FloatingBallPage = lazy(() =>
  import("@/components/pages/floating-ball-page").then((m) => ({ default: m.FloatingBallPage }))
)
```

Update `NavId` / `NAV_IDS` from Task 7 to drop the two entries:

```ts
export type NavId =
  | "home"
  | "cortex"
  | "settings"
  | "plugins"
  | "marketplace"
  | "lan-transfer"

const NAV_IDS = new Set<NavId>([
  "home",
  "cortex",
  "settings",
  "plugins",
  "marketplace",
  "lan-transfer",
])
```

Remove the entire "功能" (`nav.features`) `SidebarGroup` block that contained the App Launcher and Floating Ball menu items (currently lines 178–224) — but **keep** the Plugins and Marketplace menu buttons, just move them up into the main nav group above (right after the Settings menu item in the first `SidebarGroup`, before its closing tags):

```tsx
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "plugins"}
                    onClick={() => setNav("plugins")}
                    tooltip={t("nav.plugins")}
                  >
                    <Puzzle />
                    <span>{t("nav.plugins")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={nav === "marketplace"}
                    onClick={() => setNav("marketplace")}
                    tooltip={t("nav.marketplace")}
                  >
                    <Store />
                    <span>{t("nav.marketplace")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
```

After this change, `CircleDot` and `Search` are no longer used anywhere in this file — remove them from the `lucide-react` import (they were only used by the two deleted menu items).

Update the render switch (drop the two lines):

```tsx
              {nav === "home" && <HomePage onNavigate={handleHomeNavigate} />}
              {nav === "cortex" && <ChatPage />}
              {nav === "settings" && <SettingsPage />}
              {nav === "plugins" && <PluginsPage />}
              {nav === "marketplace" && <MarketplacePage />}
              {nav === "lan-transfer" && <LanTransferPage />}
```

(`onNavigate={handleHomeNavigate}` replaces the previous `onNavigate={setNav}` — implemented in Task 14. For this task, temporarily keep it as `onNavigate={setNav}` if Task 14 hasn't run yet; Task 14 will change it.)

Update `navKey` to drop the two cases:

```ts
function navKey(id: NavId): string {
  switch (id) {
    case "home":
      return "home"
    case "cortex":
      return "cortex"
    case "settings":
      return "settings"
    case "plugins":
      return "plugins"
    case "marketplace":
      return "marketplace"
    case "lan-transfer":
      return "lanTransfer"
  }
}
```

Update the `main`/inner-`div` conditional (previously checking `nav === "plugins" || nav === "marketplace" || nav === "lan-transfer"` for the `max-w-5xl` class) — no change needed there, those three IDs still exist.

**Do not touch** the unrelated bare-hash `"floating-ball"` routing in [App.tsx](../../../src/renderer/src/App.tsx) (`RendererRoute`) and [floating-ball-window.ts](../../../src/main/floating-ball-window.ts) (`FLOATING_BALL_HASH`) — that's the separate floating-ball overlay `BrowserWindow`'s own route discriminator (`#floating-ball`, no slash), unrelated to this `NavId` (`#/floating-ball`, with a slash).

- [ ] **Step 4: Delete the two page files**

```bash
git rm src/renderer/src/components/pages/app-launcher-page.tsx src/renderer/src/components/pages/floating-ball-page.tsx
```

- [ ] **Step 5: Trim i18n**

In both [zh-CN.json](../../../src/renderer/src/i18n/messages/zh-CN.json) and [en.json](../../../src/renderer/src/i18n/messages/en.json):

Remove the `"appLauncher"` and `"floatingBall"` lines from the `"nav"` block (lines 19–20).

Remove the entire top-level `"appLauncher": { "feature": { ... } }` object (lines 207–215 in zh-CN, same lines in en — only used by the deleted page).

Within the `"floatingBall"` object, remove only the `"feature": { ... }` sub-object (lines 221–227) — **keep** `"title"`, `"features"`, and `"settings"`, which `FloatingBallSettings` (in Settings) and the floating-ball overlay window still use.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/renderer/src/components/app-shell.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors (lint will flag the now-unused `CircleDot`/`Search` imports if Step 3 missed removing them).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(nav): drop App Launcher / Floating Ball tabs (they only linked to Settings)"
```

---

## Task 9: `appUsage` field on `UserSettings`

Foundation for the Frequent Apps card — no usage data exists today.

**Files:**
- Modify: `src/main/settings/settings.ts`
- Modify: `src/main/settings/settings.test.ts`

- [ ] **Step 1: Write the failing tests**

In [src/main/settings/settings.test.ts](../../../src/main/settings/settings.test.ts), add before the closing `})` of the `describe("normalizeSettings", ...)` block:

```ts
  it("defaults appUsage to an empty object", () => {
    expect(normalizeSettings({})).toEqual({ ...defaultSettings, appUsage: {} })
  })

  it("keeps well-formed appUsage entries", () => {
    const s = normalizeSettings({
      appUsage: { vscode: { lastLaunchedAt: 100, launchCount: 3 } },
    })
    expect(s.appUsage).toEqual({ vscode: { lastLaunchedAt: 100, launchCount: 3 } })
  })

  it("drops malformed appUsage entries", () => {
    const s = normalizeSettings({
      appUsage: {
        good: { lastLaunchedAt: 1, launchCount: 1 },
        missingCount: { lastLaunchedAt: 1 },
        notAnObject: "nope",
      },
    })
    expect(s.appUsage).toEqual({ good: { lastLaunchedAt: 1, launchCount: 1 } })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/main/settings/settings.test.ts`
Expected: FAIL — `appUsage` doesn't exist on `UserSettings` yet.

- [ ] **Step 3: Implement**

In [src/main/settings/settings.ts](../../../src/main/settings/settings.ts):

Add to the `UserSettings` interface (after `agentShellRoots: string[]`, line 40):

```ts
  /** Per-app launch history keyed by `AppEntry.id`, used to surface "frequently used" apps on Home. */
  appUsage: Record<string, AppUsageEntry>
```

Add the new type above the interface (near the other type aliases, e.g. after `TrustedSourcePolicy`):

```ts
export interface AppUsageEntry {
  lastLaunchedAt: number
  launchCount: number
}
```

Add to `defaultSettings` (after `agentShellRoots: []`, line 52):

```ts
  appUsage: {},
```

Add to `normalizeSettings`, inside the `if (raw && typeof raw === "object")` block, after the `agentShellRoots` handling (after line 95):

```ts
    if (r.appUsage && typeof r.appUsage === "object" && !Array.isArray(r.appUsage)) {
      next.appUsage = normalizeAppUsage(r.appUsage as Record<string, unknown>)
    }
```

Add the helper function next to `normalizeFloatingBallFeatures`:

```ts
function normalizeAppUsage(raw: Record<string, unknown>): Record<string, AppUsageEntry> {
  const next: Record<string, AppUsageEntry> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue
    const v = value as Record<string, unknown>
    if (typeof v.lastLaunchedAt === "number" && typeof v.launchCount === "number") {
      next[id] = { lastLaunchedAt: v.lastLaunchedAt, launchCount: v.launchCount }
    }
  }
  return next
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/main/settings/settings.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/settings/settings.ts src/main/settings/settings.test.ts
git commit -m "feat(settings): track per-app launch usage for the Home frequent-apps card"
```

---

## Task 10: `LauncherService` usage tracking + `getFrequentApps`

**Files:**
- Modify: `src/main/launcher/types.ts`
- Modify: `src/main/ipc/launcher-service.ts`
- Create: `src/main/ipc/launcher-service.test.ts`

- [ ] **Step 1: Add the shared `FrequentAppEntry` type**

In [src/main/launcher/types.ts](../../../src/main/launcher/types.ts), add after `SearchResult`:

```ts
export interface FrequentAppEntry {
  entry: AppEntry
  lastLaunchedAt: number
}
```

- [ ] **Step 2: Write the failing tests**

Create [src/main/ipc/launcher-service.test.ts](../../../src/main/ipc/launcher-service.test.ts):

```ts
import type { AppEntry } from "../launcher/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listMock = vi.fn<[], readonly AppEntry[]>()
const refreshMock = vi.fn(async () => listMock())

vi.mock("../launcher/app-cache", () => ({
  AppCache: vi.fn().mockImplementation(() => ({
    list: listMock,
    refresh: refreshMock,
  })),
}))

const launchAppMock = vi.fn(async () => true)
vi.mock("../launcher/launch-app", () => ({
  launchApp: launchAppMock,
}))

const { LauncherService } = await import("./launcher-service")

function makeEntry(id: string, name = id): AppEntry {
  return { id, kind: "win32", name, nameLower: name.toLowerCase(), target: `C:\\${name}.exe` }
}

describe("LauncherService usage tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listMock.mockReturnValue([makeEntry("vscode", "VS Code"), makeEntry("chrome", "Chrome")])
    launchAppMock.mockResolvedValue(true)
  })

  it("records a launch's timestamp and count", async () => {
    const service = new LauncherService()
    vi.spyOn(Date, "now").mockReturnValue(1_000)

    await service.launchById("vscode")

    expect(await service.getFrequentApps()).toEqual([
      { entry: makeEntry("vscode", "VS Code"), lastLaunchedAt: 1_000 },
    ])
  })

  it("does not record usage when the launch fails", async () => {
    launchAppMock.mockResolvedValueOnce(false)
    const service = new LauncherService()

    await service.launchById("vscode")

    expect(await service.getFrequentApps()).toEqual([])
  })

  it("sorts by most recently launched first", async () => {
    const service = new LauncherService()
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)

    await service.launchById("vscode")
    await service.launchById("chrome")

    const frequent = await service.getFrequentApps()
    expect(frequent.map((row) => row.entry.id)).toEqual(["chrome", "vscode"])
  })

  it("drops apps no longer present in the cache (e.g. uninstalled)", async () => {
    const service = new LauncherService()
    await service.launchById("vscode")
    listMock.mockReturnValue([makeEntry("chrome", "Chrome")])

    expect(await service.getFrequentApps()).toEqual([])
  })

  it("respects the limit parameter", async () => {
    const service = new LauncherService()
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)
    await service.launchById("vscode")
    await service.launchById("chrome")

    expect(await service.getFrequentApps(1)).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run src/main/ipc/launcher-service.test.ts`
Expected: FAIL — `getFrequentApps` doesn't exist yet.

- [ ] **Step 4: Implement**

In [src/main/ipc/launcher-service.ts](../../../src/main/ipc/launcher-service.ts):

```ts
import type { AppEntry, FrequentAppEntry, SearchResult } from "../launcher/types"
import type { UserSettings } from "../settings/settings"
import { app } from "electron"
import { AppCache } from "../launcher/app-cache"
import { launchApp } from "../launcher/launch-app"
import { searchApps } from "../launcher/search"
import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
  settingsFilePath,
} from "../settings/settings"

/**
 * Glue layer between IPC and the launcher domain. Owned by main/index.ts
 * so we have a single mutable cache + settings object per process.
 */
export class LauncherService {
  readonly cache = new AppCache()
  private settings: UserSettings = { ...defaultSettings }
  private settingsPath: string | null = null

  async init(): Promise<UserSettings> {
    this.settingsPath = settingsFilePath(app.getPath("userData"))
    this.settings = await loadSettings(this.settingsPath)
    return this.settings
  }

  getSettings(): UserSettings {
    return this.settings
  }

  async updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    const next = normalizeSettings({ ...this.settings, ...patch })
    this.settings = next
    if (this.settingsPath) await saveSettings(this.settingsPath, next)
    return next
  }

  async search(query: string): Promise<SearchResult[]> {
    if (this.cache.list().length === 0) {
      await this.cache.refresh()
    }
    return searchApps(this.cache.list(), query, { limit: 30 })
  }

  async launchById(id: string): Promise<boolean> {
    const entry = this.cache.list().find((app) => app.id === id)
    if (!entry) return false
    const ok = await launchApp(entry)
    if (ok) await this.recordLaunch(id)
    return ok
  }

  refreshApps(): Promise<readonly AppEntry[]> {
    return this.cache.refresh()
  }

  async getFrequentApps(limit = 8): Promise<FrequentAppEntry[]> {
    if (this.cache.list().length === 0) {
      await this.cache.refresh()
    }
    const byId = new Map(this.cache.list().map((entry) => [entry.id, entry]))
    return Object.entries(this.settings.appUsage)
      .map(([id, usage]) => {
        const entry = byId.get(id)
        return entry ? { entry, lastLaunchedAt: usage.lastLaunchedAt } : null
      })
      .filter((row): row is FrequentAppEntry => row !== null)
      .sort((a, b) => b.lastLaunchedAt - a.lastLaunchedAt)
      .slice(0, limit)
  }

  private async recordLaunch(id: string): Promise<void> {
    const previous = this.settings.appUsage[id]
    const next: UserSettings = {
      ...this.settings,
      appUsage: {
        ...this.settings.appUsage,
        [id]: { lastLaunchedAt: Date.now(), launchCount: (previous?.launchCount ?? 0) + 1 },
      },
    }
    this.settings = next
    if (this.settingsPath) await saveSettings(this.settingsPath, next)
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/main/ipc/launcher-service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/launcher/types.ts src/main/ipc/launcher-service.ts src/main/ipc/launcher-service.test.ts
git commit -m "feat(launcher): record app-launch usage and expose getFrequentApps"
```

---

## Task 11: `launcher:frequent` IPC

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/lib/electron.ts`

- [ ] **Step 1: Main handler**

In [src/main/index.ts](../../../src/main/index.ts), add after `ipcMain.handle("launcher:refresh", ...)` (line 283):

```ts
  ipcMain.handle("launcher:frequent", (_event, limit: unknown) => {
    return launcher.getFrequentApps(typeof limit === "number" ? limit : undefined)
  })
```

- [ ] **Step 2: Preload**

In [src/preload/index.ts](../../../src/preload/index.ts), add after `refreshApps` (line 25):

```ts
  getFrequentApps: (limit?: number) => ipcRenderer.invoke("launcher:frequent", limit),
```

- [ ] **Step 3: Preload types**

In [src/preload/index.d.ts](../../../src/preload/index.d.ts):

Add after `interface LauncherSearchResult { ... }` (line 25):

```ts
  interface LauncherFrequentAppEntry {
    entry: LauncherAppEntry
    lastLaunchedAt: number
  }
```

Add to the `Window["electronAPI"]` interface, after `refreshApps: () => Promise<LauncherAppEntry[]>` (line 458):

```ts
      getFrequentApps: (limit?: number) => Promise<LauncherFrequentAppEntry[]>
```

- [ ] **Step 4: Renderer wrapper**

In [src/renderer/src/lib/electron.ts](../../../src/renderer/src/lib/electron.ts):

Add the type alias after `export type SearchResult = LauncherSearchResult` (line 29):

```ts
export type FrequentAppEntry = LauncherFrequentAppEntry
```

Add the function after `refreshApps` (line 102):

```ts
export async function getFrequentApps(limit?: number): Promise<FrequentAppEntry[]> {
  return api().getFrequentApps(limit)
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/lib/electron.ts
git commit -m "feat(ipc): expose getFrequentApps to the renderer"
```

---

## Task 12: `formatRelativeTime` helper

**Files:**
- Create: `src/renderer/src/lib/format-relative-time.ts`
- Create: `src/renderer/src/lib/format-relative-time.test.ts`

- [ ] **Step 1: Write the failing tests**

Create [src/renderer/src/lib/format-relative-time.test.ts](../../../src/renderer/src/lib/format-relative-time.test.ts):

```ts
import { describe, expect, it } from "vitest"
import { formatRelativeTime } from "./format-relative-time"

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-08T12:00:00Z").getTime()

  it("formats minutes ago", () => {
    expect(formatRelativeTime(now - 5 * 60 * 1000, "en", now)).toBe("5 minutes ago")
  })

  it("formats hours ago", () => {
    expect(formatRelativeTime(now - 2 * 60 * 60 * 1000, "en", now)).toBe("2 hours ago")
  })

  it("formats days ago", () => {
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000, "en", now)).toBe("3 days ago")
  })

  it("falls back to a 'this minute' bucket for anything under a minute", () => {
    expect(formatRelativeTime(now - 10 * 1000, "en", now)).toBe("this minute")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/renderer/src/lib/format-relative-time.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create [src/renderer/src/lib/format-relative-time.ts](../../../src/renderer/src/lib/format-relative-time.ts):

```ts
const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
]

/** Locale-aware "2 hours ago" / "5 分钟前" style formatting for a timestamp. */
export function formatRelativeTime(timestamp: number, locale: string, now = Date.now()): string {
  const diffMs = timestamp - now
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  for (const { unit, ms } of UNITS) {
    if (Math.abs(diffMs) >= ms) {
      return formatter.format(Math.round(diffMs / ms), unit)
    }
  }
  return formatter.format(0, "minute")
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/renderer/src/lib/format-relative-time.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/format-relative-time.ts src/renderer/src/lib/format-relative-time.test.ts
git commit -m "feat(lib): add locale-aware relative-time formatting for the Home frequent-apps card"
```

---

## Task 13: `plugin-version` compare helper

**Files:**
- Create: `src/renderer/src/lib/plugin-version.ts`
- Create: `src/renderer/src/lib/plugin-version.test.ts`

- [ ] **Step 1: Write the failing tests**

Create [src/renderer/src/lib/plugin-version.test.ts](../../../src/renderer/src/lib/plugin-version.test.ts):

```ts
import { describe, expect, it } from "vitest"
import { hasUpdate } from "./plugin-version"

describe("hasUpdate", () => {
  it("is true when the latest version is newer", () => {
    expect(hasUpdate("1.2.0", "1.3.0")).toBe(true)
    expect(hasUpdate("1.2.0", "2.0.0")).toBe(true)
    expect(hasUpdate("1.2.9", "1.2.10")).toBe(true)
  })

  it("is false when versions are equal or the installed one is newer", () => {
    expect(hasUpdate("1.2.0", "1.2.0")).toBe(false)
    expect(hasUpdate("1.3.0", "1.2.0")).toBe(false)
  })

  it("handles version strings with different segment counts", () => {
    expect(hasUpdate("1.2", "1.2.1")).toBe(true)
    expect(hasUpdate("1.2.0", "1.2")).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/renderer/src/lib/plugin-version.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create [src/renderer/src/lib/plugin-version.ts](../../../src/renderer/src/lib/plugin-version.ts):

```ts
/** Compares two dotted-numeric version strings. Positive if `a` is newer than `b`. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number)
  const partsB = b.split(".").map(Number)
  const length = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** True if `latestVersion` is strictly newer than `installedVersion`. */
export function hasUpdate(installedVersion: string, latestVersion: string): boolean {
  return compareVersions(latestVersion, installedVersion) > 0
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/renderer/src/lib/plugin-version.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/plugin-version.ts src/renderer/src/lib/plugin-version.test.ts
git commit -m "feat(lib): add plugin version comparison for the Home plugins card"
```

---

## Task 14: Cortex-resume plumbing (`AppShell` + `ChatPage`)

Without this, a "继续对话" button would be a lie — `ChatPage` always starts a fresh draft conversation on mount today. This task makes the copy honest.

**Files:**
- Modify: `src/renderer/src/components/pages/chat-page.tsx`
- Modify: `src/renderer/src/components/app-shell.tsx`

- [ ] **Step 1: `ChatPage` accepts an optional resume target**

In [src/renderer/src/components/pages/chat-page.tsx](../../../src/renderer/src/components/pages/chat-page.tsx):

Change the function signature (line 76):

```tsx
export function ChatPage({ initialConversationId }: { initialConversationId?: string } = {}) {
```

After the existing `selectConversation` function definition (after line 214), add a one-shot mount effect:

```tsx
  useEffect(() => {
    if (initialConversationId) void selectConversation(initialConversationId)
    // Intentionally runs once on mount only: `initialConversationId` is a
    // one-shot instruction from Home's "continue conversation" card, not a
    // prop that should re-trigger a reload if it were to change later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
```

- [ ] **Step 2: `AppShell` — one-shot resume-id handoff**

In [src/renderer/src/components/app-shell.tsx](../../../src/renderer/src/components/app-shell.tsx):

Add `useState` to the existing React import if not already present, and add inside `AppShell()` (near the `useNav()` call):

```tsx
  const [pendingCortexConversationId, setPendingCortexConversationId] = useState<
    string | undefined
  >(undefined)

  function handleHomeNavigate(id: NavId, conversationId?: string): void {
    if (id === "cortex") {
      setPendingCortexConversationId(conversationId)
    }
    setNav(id)
  }

  useEffect(() => {
    if (nav !== "cortex" || pendingCortexConversationId === undefined) return
    // Consumed by ChatPage's mount-time initializer above — clear it so a
    // later plain sidebar click into Cortex starts a fresh conversation
    // instead of silently re-resuming this one.
    setPendingCortexConversationId(undefined)
  }, [nav, pendingCortexConversationId])
```

Update the render switch:

```tsx
              {nav === "home" && <HomePage onNavigate={handleHomeNavigate} />}
              {nav === "cortex" && <ChatPage initialConversationId={pendingCortexConversationId} />}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: errors until Task 18 updates `HomePage`'s `onNavigate` prop type to accept the second argument — that's fine, Task 18 is a few tasks away (Tasks 15–17 build the individual cards first). If you're executing tasks strictly in order this step's typecheck will show one expected error in `home-page.tsx`; confirm it's exactly that (a prop-type mismatch on `onNavigate`) and proceed.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/pages/chat-page.tsx src/renderer/src/components/app-shell.tsx
git commit -m "feat(cortex): actually resume the selected conversation from Home"
```

---

## Task 15: Home page cards — Frequent Apps

**Files:**
- Create: `src/renderer/src/components/home/frequent-apps-card.tsx`
- Create: `src/renderer/src/components/home/frequent-apps-card.test.tsx`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`
- Modify: `src/renderer/src/i18n/messages/en.json`

- [ ] **Step 1: i18n**

Replace the `"home"` block in both [zh-CN.json](../../../src/renderer/src/i18n/messages/zh-CN.json) and [en.json](../../../src/renderer/src/i18n/messages/en.json) (currently `quickActions`/`quickActionsHint`/`rescan`/`openSettings`, lines 164–169) — this task only adds the `frequentApps` sub-key; Tasks 16–17 add the rest of the block. In zh-CN.json:

```json
  "home": {
    "frequentApps": {
      "title": "常用应用",
      "subtitle": "最近启动过的应用，一键再次打开。",
      "rescan": "重新扫描",
      "empty": "还没有使用记录。",
      "emptyAction": "重新扫描应用列表"
    }
  },
```

In en.json:

```json
  "home": {
    "frequentApps": {
      "title": "Frequent Apps",
      "subtitle": "Apps you've launched recently — open them again in one click.",
      "rescan": "Rescan",
      "empty": "No usage recorded yet.",
      "emptyAction": "Rescan the app list"
    }
  },
```

- [ ] **Step 2: Write the failing tests**

Create [src/renderer/src/components/home/frequent-apps-card.test.tsx](../../../src/renderer/src/components/home/frequent-apps-card.test.tsx):

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FrequentAppsCard } from "./frequent-apps-card"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))

const getFrequentAppsMock = vi.fn()
const refreshAppsMock = vi.fn()
const launchAppMock = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getFrequentApps: (...args: unknown[]) => getFrequentAppsMock(...args),
  refreshApps: (...args: unknown[]) => refreshAppsMock(...args),
  launchApp: (...args: unknown[]) => launchAppMock(...args),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("FrequentAppsCard", () => {
  it("renders each frequent app as a clickable button with its name", async () => {
    getFrequentAppsMock.mockResolvedValue([
      {
        entry: { id: "vscode", kind: "win32", name: "VS Code", nameLower: "vs code", target: "x" },
        lastLaunchedAt: Date.now() - 60_000,
      },
    ])

    render(<FrequentAppsCard />)

    expect(await screen.findByRole("button", { name: /VS Code/ })).toBeInTheDocument()
  })

  it("launches an app when its tile is clicked", async () => {
    getFrequentAppsMock.mockResolvedValue([
      {
        entry: { id: "vscode", kind: "win32", name: "VS Code", nameLower: "vs code", target: "x" },
        lastLaunchedAt: Date.now(),
      },
    ])
    launchAppMock.mockResolvedValue(true)
    const user = userEvent.setup()

    render(<FrequentAppsCard />)
    await user.click(await screen.findByRole("button", { name: /VS Code/ }))

    expect(launchAppMock).toHaveBeenCalledWith("vscode")
  })

  it("shows an empty state with a working rescan action when there's no usage yet", async () => {
    getFrequentAppsMock.mockResolvedValue([])
    refreshAppsMock.mockResolvedValue([])
    const user = userEvent.setup()

    render(<FrequentAppsCard />)
    expect(await screen.findByText("home.frequentApps.empty")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "home.frequentApps.emptyAction" }))
    await waitFor(() => expect(refreshAppsMock).toHaveBeenCalledTimes(1))
  })

  it("rescans and refetches when the header rescan button is clicked", async () => {
    getFrequentAppsMock.mockResolvedValue([])
    refreshAppsMock.mockResolvedValue([])
    const user = userEvent.setup()

    render(<FrequentAppsCard />)
    await screen.findByText("home.frequentApps.empty")
    await user.click(screen.getByRole("button", { name: "home.frequentApps.rescan" }))

    await waitFor(() => expect(refreshAppsMock).toHaveBeenCalledTimes(1))
    expect(getFrequentAppsMock).toHaveBeenCalledTimes(2) // initial load + post-rescan refetch
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run src/renderer/src/components/home/frequent-apps-card.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement**

Create [src/renderer/src/components/home/frequent-apps-card.tsx](../../../src/renderer/src/components/home/frequent-apps-card.tsx). Note: `LauncherAppKind` below is used **without an import** — it's declared via `declare global` in [preload/index.d.ts](../../../src/preload/index.d.ts) and ambiently available renderer-wide (the same reason `electron.ts` itself never imports `LauncherAppEntry` before aliasing it); `@/lib/electron` doesn't separately export it, so adding an import for it would fail to compile.

```tsx
import type { FrequentAppEntry } from "@/lib/electron"
import { AppWindow, Globe, LayoutGrid, RefreshCw, Star } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatRelativeTime } from "@/lib/format-relative-time"
import { getFrequentApps, isElectron, launchApp, refreshApps } from "@/lib/electron"
import { cn } from "@/lib/utils"

function KindIcon({ kind, className }: { kind: LauncherAppKind; className?: string }) {
  if (kind === "url") return <Globe className={className} aria-hidden />
  if (kind === "uwp") return <LayoutGrid className={className} aria-hidden />
  return <AppWindow className={className} aria-hidden />
}

export function FrequentAppsCard() {
  const { t, i18n } = useTranslation()
  const [apps, setApps] = useState<FrequentAppEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!isElectron()) {
      setLoading(false)
      return
    }
    void getFrequentApps().then((rows) => {
      setApps(rows)
      setLoading(false)
    })
  }, [])

  async function onRescan() {
    setRefreshing(true)
    try {
      await refreshApps()
      setApps(await getFrequentApps())
    } finally {
      setRefreshing(false)
    }
  }

  async function onLaunch(id: string) {
    const ok = await launchApp(id)
    if (ok) setApps(await getFrequentApps())
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Star className="size-4 text-primary" aria-hidden />
            {t("home.frequentApps.title")}
          </CardTitle>
          <CardDescription>{t("home.frequentApps.subtitle")}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void onRescan()} disabled={refreshing}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
          {t("home.frequentApps.rescan")}
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              // eslint-disable-next-line react/no-array-index-key -- fixed-count loading placeholders, never reordered
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : apps.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">{t("home.frequentApps.empty")}</p>
            <Button variant="outline" size="sm" onClick={() => void onRescan()} disabled={refreshing}>
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
              {t("home.frequentApps.emptyAction")}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {apps.map(({ entry, lastLaunchedAt }) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => void onLaunch(entry.id)}
                className="flex flex-col items-center gap-1 rounded-lg border border-transparent p-2 text-center hover:bg-accent focus-visible:border-ring focus-visible:outline-none"
              >
                <KindIcon kind={entry.kind} className="size-5 text-muted-foreground" />
                <span className="w-full truncate text-xs font-medium">{entry.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {formatRelativeTime(lastLaunchedAt, i18n.language)}
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/renderer/src/components/home/frequent-apps-card.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/home/frequent-apps-card.tsx src/renderer/src/components/home/frequent-apps-card.test.tsx src/renderer/src/i18n/messages/zh-CN.json src/renderer/src/i18n/messages/en.json
git commit -m "feat(home): add the Frequent Apps card"
```

---

## Task 16: Home page cards — Plugins (updates / trending)

**Files:**
- Create: `src/renderer/src/components/home/plugins-status-card.tsx`
- Create: `src/renderer/src/components/home/plugins-status-card.test.tsx`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`
- Modify: `src/renderer/src/i18n/messages/en.json`

- [ ] **Step 1: i18n**

Add to the `"home"` block in [zh-CN.json](../../../src/renderer/src/i18n/messages/zh-CN.json) (as a sibling of `frequentApps`):

```json
    "plugins": {
      "title": "插件",
      "updatesTab": "可更新",
      "trendingTab": "市场热门",
      "updatesEmpty": "已安装插件都是最新版本。",
      "trendingEmpty": "暂时没有可展示的市场插件。",
      "updateLine": "v{{from}} → v{{to}}",
      "downloadsLine": "{{count}} 次下载"
    }
```

Add to the `"home"` block in [en.json](../../../src/renderer/src/i18n/messages/en.json):

```json
    "plugins": {
      "title": "Plugins",
      "updatesTab": "Updates",
      "trendingTab": "Trending",
      "updatesEmpty": "All installed plugins are up to date.",
      "trendingEmpty": "No marketplace plugins to show right now.",
      "updateLine": "v{{from}} → v{{to}}",
      "downloadsLine": "{{count}} downloads"
    }
```

- [ ] **Step 2: Write the failing tests**

Create [src/renderer/src/components/home/plugins-status-card.test.tsx](../../../src/renderer/src/components/home/plugins-status-card.test.tsx):

```tsx
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PluginsStatusCard } from "./plugins-status-card"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: "en" },
  }),
}))

const listPluginsMock = vi.fn()
const searchMarketplaceMock = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listPlugins: (...args: unknown[]) => listPluginsMock(...args),
  searchMarketplace: (...args: unknown[]) => searchMarketplaceMock(...args),
}))

function installedPlugin(id: string, version: string) {
  return {
    pluginId: id,
    rootDir: "/x",
    source: { kind: "user" },
    status: "active",
    manifest: { id, version, displayName: id, description: "", name: id },
  }
}

function marketplacePlugin(id: string, latestVersion: string, downloads: number) {
  return {
    id,
    displayName: id,
    description: "",
    latestVersion,
    stats: { downloads, ratingAvg: 0, ratingCount: 0 },
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("PluginsStatusCard", () => {
  it("defaults to the Updates tab and lists outdated installed plugins", async () => {
    listPluginsMock.mockResolvedValue([installedPlugin("translator", "1.0.0")])
    searchMarketplaceMock.mockResolvedValue({
      items: [marketplacePlugin("translator", "1.1.0", 10)],
      page: 1,
      perPage: 20,
      total: 1,
    })

    render(<PluginsStatusCard />)

    expect(await screen.findByText(/updateLine/)).toBeInTheDocument()
  })

  it("falls back to the Trending tab by default when nothing is outdated", async () => {
    listPluginsMock.mockResolvedValue([installedPlugin("translator", "1.1.0")])
    searchMarketplaceMock.mockResolvedValue({
      items: [marketplacePlugin("translator", "1.1.0", 10), marketplacePlugin("clip", "2.0.0", 99)],
      page: 1,
      perPage: 20,
      total: 2,
    })

    render(<PluginsStatusCard />)

    expect(await screen.findByText(/downloadsLine/)).toBeInTheDocument()
  })

  it("lets the user switch to the Trending tab manually", async () => {
    listPluginsMock.mockResolvedValue([installedPlugin("translator", "1.0.0")])
    searchMarketplaceMock.mockResolvedValue({
      items: [marketplacePlugin("translator", "1.1.0", 10)],
      page: 1,
      perPage: 20,
      total: 1,
    })
    const user = userEvent.setup()

    render(<PluginsStatusCard />)
    await screen.findByText(/updateLine/)
    await user.click(screen.getByRole("tab", { name: "home.plugins.trendingTab" }))

    expect(await screen.findByText(/downloadsLine/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run src/renderer/src/components/home/plugins-status-card.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement**

Create [src/renderer/src/components/home/plugins-status-card.tsx](../../../src/renderer/src/components/home/plugins-status-card.tsx):

```tsx
import type { MarketplaceSummary, PluginRegistryEntry } from "@/lib/electron"
import { Puzzle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { localize } from "@/components/plugins/view-utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isElectron, listPlugins, searchMarketplace } from "@/lib/electron"
import { hasUpdate } from "@/lib/plugin-version"

interface UpdateRow {
  id: string
  name: string
  from: string
  to: string
}

interface TrendingRow {
  id: string
  name: string
  downloads: number
}

const TRENDING_LIMIT = 5

export function PluginsStatusCard() {
  const { t, i18n } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [updates, setUpdates] = useState<UpdateRow[]>([])
  const [trending, setTrending] = useState<TrendingRow[]>([])
  const [tab, setTab] = useState<"updates" | "trending">("updates")
  const autoSelected = useRef(false)

  useEffect(() => {
    if (!isElectron()) {
      setLoading(false)
      return
    }
    void Promise.all([listPlugins(), searchMarketplace()]).then(([installed, search]) => {
      setUpdates(computeUpdates(installed, search.items, i18n.language))
      setTrending(computeTrending(search.items, i18n.language))
      setLoading(false)
    })
  }, [i18n.language])

  useEffect(() => {
    if (autoSelected.current || loading) return
    autoSelected.current = true
    setTab(updates.length > 0 ? "updates" : "trending")
  }, [loading, updates])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Puzzle className="size-4 text-primary" aria-hidden />
          {t("home.plugins.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(value as "updates" | "trending")}>
            <TabsList>
              <TabsTrigger value="updates">{t("home.plugins.updatesTab")}</TabsTrigger>
              <TabsTrigger value="trending">{t("home.plugins.trendingTab")}</TabsTrigger>
            </TabsList>
            <TabsContent value="updates" className="mt-3 flex flex-col gap-2">
              {updates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("home.plugins.updatesEmpty")}</p>
              ) : (
                updates.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between rounded-md bg-accent/50 px-2 py-1.5 text-sm"
                  >
                    <span className="truncate font-medium">{row.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("home.plugins.updateLine", { from: row.from, to: row.to })}
                    </span>
                  </div>
                ))
              )}
            </TabsContent>
            <TabsContent value="trending" className="mt-3 flex flex-col gap-2">
              {trending.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("home.plugins.trendingEmpty")}</p>
              ) : (
                trending.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between rounded-md bg-accent/50 px-2 py-1.5 text-sm"
                  >
                    <span className="truncate font-medium">{row.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t("home.plugins.downloadsLine", { count: row.downloads })}
                    </span>
                  </div>
                ))
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  )
}

function computeUpdates(
  installed: PluginRegistryEntry[],
  marketplace: MarketplaceSummary[],
  locale: string
): UpdateRow[] {
  const byId = new Map(marketplace.map((entry) => [entry.id, entry]))
  const rows: UpdateRow[] = []
  for (const plugin of installed) {
    if (!plugin.manifest) continue
    const match = byId.get(plugin.manifest.id)
    if (match?.latestVersion && hasUpdate(plugin.manifest.version, match.latestVersion)) {
      rows.push({
        id: plugin.manifest.id,
        name: localize(plugin.manifest.displayName, locale),
        from: plugin.manifest.version,
        to: match.latestVersion,
      })
    }
  }
  return rows
}

function computeTrending(marketplace: MarketplaceSummary[], locale: string): TrendingRow[] {
  return [...marketplace]
    .sort((a, b) => b.stats.downloads - a.stats.downloads)
    .slice(0, TRENDING_LIMIT)
    .map((entry) => ({
      id: entry.id,
      name: localize(entry.displayName, locale),
      downloads: entry.stats.downloads,
    }))
}
```

Known limitation (leave as a code comment above `computeUpdates`, and worth calling out — not a bug to fix here): `searchMarketplace()` with no query returns the backend's default result page (today, up to 20 items), so an installed plugin published on the marketplace but outside that first page won't be detected as having an update. Add this as a one-line comment above `computeUpdates`:

```ts
// Limitation: searchMarketplace() with no query only returns the backend's
// default result page, so an installed plugin outside that page won't be
// checked for updates. Acceptable for a v1 status card; a dedicated
// "check these specific plugin ids" endpoint would remove this gap.
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/renderer/src/components/home/plugins-status-card.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/home/plugins-status-card.tsx src/renderer/src/components/home/plugins-status-card.test.tsx src/renderer/src/i18n/messages/zh-CN.json src/renderer/src/i18n/messages/en.json
git commit -m "feat(home): add the Plugins status card (updates / trending)"
```

---

## Task 17: Home page cards — Cortex quick entry

**Files:**
- Create: `src/renderer/src/components/home/cortex-quick-entry-card.tsx`
- Create: `src/renderer/src/components/home/cortex-quick-entry-card.test.tsx`
- Modify: `src/renderer/src/i18n/messages/zh-CN.json`
- Modify: `src/renderer/src/i18n/messages/en.json`

- [ ] **Step 1: i18n**

Add to the `"home"` block in [zh-CN.json](../../../src/renderer/src/i18n/messages/zh-CN.json):

```json
    "cortex": {
      "title": "Cortex",
      "continue": "继续对话",
      "start": "开始新对话",
      "emptyHint": "还没有对话记录，开始第一次对话吧。"
    },
    "recommendations": {
      "title": "今日推荐",
      "placeholder": "Cortex 正在学习你的使用习惯，很快会带来个性化建议。"
    }
```

Add to the `"home"` block in [en.json](../../../src/renderer/src/i18n/messages/en.json):

```json
    "cortex": {
      "title": "Cortex",
      "continue": "Continue conversation",
      "start": "Start a new conversation",
      "emptyHint": "No conversations yet — start your first one."
    },
    "recommendations": {
      "title": "Today's Picks",
      "placeholder": "Cortex is learning how you work — personalized suggestions are coming soon."
    }
```

- [ ] **Step 2: Write the failing tests**

Create [src/renderer/src/components/home/cortex-quick-entry-card.test.tsx](../../../src/renderer/src/components/home/cortex-quick-entry-card.test.tsx):

```tsx
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CortexQuickEntryCard } from "./cortex-quick-entry-card"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const listAiConversationsMock = vi.fn()

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  listAiConversations: (...args: unknown[]) => listAiConversationsMock(...args),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("CortexQuickEntryCard", () => {
  it("offers to start a new conversation when there's no history", async () => {
    listAiConversationsMock.mockResolvedValue([])
    const onOpenCortex = vi.fn()

    render(<CortexQuickEntryCard onOpenCortex={onOpenCortex} />)
    const button = await screen.findByRole("button", { name: "home.cortex.start" })
    await userEvent.setup().click(button)

    expect(onOpenCortex).toHaveBeenCalledWith(undefined)
  })

  it("offers to resume the most recently updated conversation", async () => {
    listAiConversationsMock.mockResolvedValue([
      { id: "old", title: "Old chat", workspaceId: "default", updatedAt: 1 },
      { id: "recent", title: "Refactor plan", workspaceId: "default", updatedAt: 100 },
    ])
    const onOpenCortex = vi.fn()

    render(<CortexQuickEntryCard onOpenCortex={onOpenCortex} />)
    expect(await screen.findByText("Refactor plan")).toBeInTheDocument()

    const button = screen.getByRole("button", { name: "home.cortex.continue" })
    await userEvent.setup().click(button)

    expect(onOpenCortex).toHaveBeenCalledWith("recent")
  })

  it("falls back to the untitled label when the recent conversation has no title", async () => {
    listAiConversationsMock.mockResolvedValue([
      { id: "recent", workspaceId: "default", updatedAt: 100 },
    ])

    render(<CortexQuickEntryCard onOpenCortex={vi.fn()} />)

    expect(await screen.findByText("chat.untitled")).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run src/renderer/src/components/home/cortex-quick-entry-card.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement**

Create [src/renderer/src/components/home/cortex-quick-entry-card.tsx](../../../src/renderer/src/components/home/cortex-quick-entry-card.tsx):

```tsx
import type { AiConversationSummary } from "@/lib/electron"
import { Brain } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { isElectron, listAiConversations } from "@/lib/electron"

export function CortexQuickEntryCard({
  onOpenCortex,
}: {
  onOpenCortex: (conversationId?: string) => void
}) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [recent, setRecent] = useState<AiConversationSummary | null>(null)

  useEffect(() => {
    if (!isElectron()) {
      setLoading(false)
      return
    }
    void listAiConversations().then((conversations) => {
      const latest = conversations.reduce<AiConversationSummary | null>((best, current) => {
        if (!best || current.updatedAt > best.updatedAt) return current
        return best
      }, null)
      setRecent(latest)
      setLoading(false)
    })
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Brain className="size-4 text-primary" aria-hidden />
          {t("home.cortex.title")}
        </CardTitle>
        {!loading && <CardDescription>{recent ? recent.title ?? t("chat.untitled") : t("home.cortex.emptyHint")}</CardDescription>}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-40" />
        ) : (
          <Button onClick={() => onOpenCortex(recent?.id)}>
            {recent ? t("home.cortex.continue") : t("home.cortex.start")}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/renderer/src/components/home/cortex-quick-entry-card.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/home/cortex-quick-entry-card.tsx src/renderer/src/components/home/cortex-quick-entry-card.test.tsx src/renderer/src/i18n/messages/zh-CN.json src/renderer/src/i18n/messages/en.json
git commit -m "feat(home): add the Cortex quick-entry card"
```

---

## Task 18: Assemble the final Home page

**Files:**
- Modify: `src/renderer/src/components/pages/home-page.tsx`
- Create: `src/renderer/src/components/pages/home-page.test.tsx`
- Modify: `src/renderer/src/components/app-shell.tsx`

- [ ] **Step 1: Write the failing test**

Create [src/renderer/src/components/pages/home-page.test.tsx](../../../src/renderer/src/components/pages/home-page.test.tsx):

```tsx
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./home-page"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}))

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ resolvedScheme: "light" }),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => false,
}))

afterEach(cleanup)

describe("HomePage", () => {
  it("no longer renders the removed Quick Actions card", () => {
    render(<HomePage onNavigate={vi.fn()} />)
    expect(screen.queryByText("home.quickActions")).not.toBeInTheDocument()
  })

  it("renders the today's-picks placeholder card", () => {
    render(<HomePage onNavigate={vi.fn()} />)
    expect(screen.getByText("home.recommendations.title")).toBeInTheDocument()
    expect(screen.getByText("home.recommendations.placeholder")).toBeInTheDocument()
  })

  it("renders the Cortex, frequent-apps, and plugins cards", () => {
    render(<HomePage onNavigate={vi.fn()} />)
    expect(screen.getByText("home.cortex.title")).toBeInTheDocument()
    expect(screen.getByText("home.frequentApps.title")).toBeInTheDocument()
    expect(screen.getByText("home.plugins.title")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/renderer/src/components/pages/home-page.test.tsx`
Expected: FAIL — old Quick Actions card still renders, new cards don't exist yet.

- [ ] **Step 3: Implement**

Replace the full contents of [src/renderer/src/components/pages/home-page.tsx](../../../src/renderer/src/components/pages/home-page.tsx):

```tsx
import type { NavId } from "../app-shell"
import { Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import logoDarkUrl from "@/assets/logo-dark.png"
import logoUrl from "@/assets/logo.png"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CortexQuickEntryCard } from "@/components/home/cortex-quick-entry-card"
import { FrequentAppsCard } from "@/components/home/frequent-apps-card"
import { PluginsStatusCard } from "@/components/home/plugins-status-card"
import { useTheme } from "@/hooks/use-theme"

export function HomePage({
  onNavigate,
}: {
  onNavigate: (id: NavId, conversationId?: string) => void
}) {
  const { t } = useTranslation()
  const { resolvedScheme } = useTheme()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-4">
        <img
          src={resolvedScheme === "dark" ? logoDarkUrl : logoUrl}
          alt=""
          className="size-12 shrink-0"
          aria-hidden
        />
        <div className="flex flex-col gap-1">
          <h1 className="text-balance text-2xl font-semibold tracking-tight">{t("app.title")}</h1>
          <p className="text-pretty text-sm text-muted-foreground">{t("app.subtitle")}</p>
        </div>
      </header>

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" aria-hidden />
            {t("home.recommendations.title")}
          </CardTitle>
          <CardDescription>{t("home.recommendations.placeholder")}</CardDescription>
        </CardHeader>
      </Card>

      <CortexQuickEntryCard onOpenCortex={(id) => onNavigate("cortex", id)} />

      <div className="grid gap-4 md:grid-cols-2">
        <FrequentAppsCard />
        <PluginsStatusCard />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Wire the new `onNavigate` signature into `AppShell`**

In [src/renderer/src/components/app-shell.tsx](../../../src/renderer/src/components/app-shell.tsx), confirm (from Task 14) the render switch passes `onNavigate={handleHomeNavigate}`:

```tsx
              {nav === "home" && <HomePage onNavigate={handleHomeNavigate} />}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run src/renderer/src/components/pages/home-page.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/pages/home-page.tsx src/renderer/src/components/pages/home-page.test.tsx src/renderer/src/components/app-shell.tsx
git commit -m "feat(home): assemble the redesigned Home dashboard"
```

---

## Task 19: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all tests pass, including every new file from Tasks 1–18.

- [ ] **Step 2: Typecheck (both configs) and lint**

Run: `pnpm typecheck && pnpm typecheck:native && pnpm lint`
Expected: no errors. (`typecheck:native` is a fast sanity check per CLAUDE.md — a divergence from `typecheck` is itself a signal worth investigating, not necessarily a blocker.)

- [ ] **Step 3: Format check**

Run: `pnpm format:check`
Expected: clean. If not, run `pnpm format` and re-stage.

- [ ] **Step 4: Manual smoke test in the running app**

Run: `pnpm dev`, then in the app:
- Confirm the sidebar shows exactly: 主页, Cortex, 局域网传输, 插件, 应用市场, 设置 (no "应用启动器"/"桌面悬浮球").
- Open Home: confirm the 今日推荐 placeholder, Cortex card, 常用应用 card, and 插件 card all render without console errors.
- Launch an app from the launcher (Ctrl+Space), then return to Home — confirm it now appears in 常用应用 with "刚刚"/a few-seconds-ago style timestamp.
- Click 常用应用's rescan button — confirm it doesn't error.
- Click the Cortex card's button, send a message, go back to Home, confirm the card now shows that conversation's title and "继续对话" resumes it with history intact (not a blank chat).
- Go to Settings → confirm the hotkey capture button works: click 捕获, press a **new** key combination (not the current one) — it should populate the input. Then try capturing while the *current* bound combination is pressed — before this fix it would silently fail; after, it should be caught cleanly (though re-entering the same value is a degenerate case, the input should still reflect the captured keys, not silently do nothing).
- Confirm the startup toast (relaunch the whole app fully) shows "Synapse" + the app icon, not `com.synapse.desktop`.

- [ ] **Step 5: Report results**

If everything above passes, the branch is ready for review. If any manual check fails, treat it as a new bug — do not mark this plan complete until the manual smoke test passes, per this repo's UI/UX verification bar.
