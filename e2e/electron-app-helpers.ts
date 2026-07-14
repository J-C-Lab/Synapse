import type { ElectronApplication, Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import process from "node:process"
import { _electron as electron, expect } from "@playwright/test"

// Shared Electron launch/readiness harness for the Playwright smoke suites.
//
// Both the development smoke (repo root, `app.isPackaged === false`) and the
// packaged smoke (`release/win-unpacked/Synapse.exe`, `app.isPackaged === true`)
// serve the renderer from the custom `app://app` scheme, so the readiness
// contract — no-hash main shell, `[data-testid="app-shell"]`, a real
// `getSettings()` IPC round-trip — is identical. The packaged suite layers the
// stricter S11 Checkpoint R readiness items on top (exact URL, post-readiness
// liveness window, clean diagnostic collectors).
//
// Deliberately NO production-only test IPC, env-controlled marker file, or
// arbitrary-path write hook: readiness is proven through the same URL/DOM/
// preload-bridge surface a real user exercises.

/** The production main shell always loads here (no hash). Launcher (#search)
 *  and floating-ball (#floating-ball) windows share the bundle but differ by
 *  hash — the shell is the one whose hash is empty. */
export const MAIN_SHELL_URL = "app://app/index.html"

const REPO_ROOT = path.join(__dirname, "..")
const READINESS_TIMEOUT_MS = 30_000
const DEFAULT_LIVENESS_MS = 12_000

export type LaunchMode = "dev" | "packaged"

export interface DiagnosticEvent {
  /** "main" = Electron main-process webContents event; "page" = renderer. */
  source: "main" | "page"
  type: string
  /** URL of the webContents/page at the time the event fired (with hash). */
  url: string
  detail: string
}

/** Integrity failures that mean the packaged renderer/preload is actually
 *  broken (blank screen, missing/mis-served assets, preload not injected,
 *  renderer process gone or crashed). These deterministically fail the shell
 *  readiness proof.
 *
 *  Renderer `pageerror`/`console.error` are still collected (and surfaced in
 *  the failure report), but are NOT treated as integrity failures on their
 *  own: they are routinely driven by environmental conditions a headless CI
 *  runner cannot satisfy (marketplace server or GitHub release feed
 *  unreachable → net::ERR_CONNECTION_REFUSED). A shell whose JS truly failed
 *  to mount would already fail the positive [data-testid="app-shell"] /
 *  getSettings() assertions. Sub-windows (launcher #search, floating ball) are
 *  matched by full URL including hash, so their noise never counts against the
 *  no-hash main shell. */
const INTEGRITY_TYPES = new Set([
  "did-fail-load-main",
  "preload-error",
  "render-process-gone",
  "crash",
])

export interface LaunchedApp {
  app: ElectronApplication
  userDir: string
  readStdout: () => string
  readStderr: () => string
  readDiagnostics: () => Promise<DiagnosticEvent[]>
  isClosed: () => boolean
  /** Close the app, force-clean any surviving process tree, and remove only
   *  the verified temporary user-data dir. Safe to call more than once. */
  dispose: () => Promise<void>
}

/** Resolve the packaged executable from `SYNAPSE_PACKAGED_EXE`. FAILS (never
 *  skips) when the packaged suite is invoked without it, so a missing build is
 *  a hard error rather than a silent green run. A relative value is resolved
 *  against the cwd so the package script can hand off a repo-relative path. */
export function resolvePackagedExecutable(): string {
  const raw = process.env.SYNAPSE_PACKAGED_EXE?.trim()
  if (!raw) {
    throw new Error(
      "SYNAPSE_PACKAGED_EXE is required for the packaged smoke suite. " +
        "Run `pnpm electron:build:win` and invoke via `pnpm test:e2e:packaged`."
    )
  }
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
  if (!existsSync(resolved)) {
    throw new Error(
      `SYNAPSE_PACKAGED_EXE points at a missing file: ${resolved}. ` +
        "Run `pnpm electron:build:win` first."
    )
  }
  return resolved
}

/** The unpacked `Synapse.exe` only exists on Windows — fail immediately on any
 *  other host rather than launch a non-existent/incompatible binary. */
export function assertPackagedHostSupported(): void {
  if (process.platform !== "win32") {
    throw new Error(
      `Packaged smoke tests require a Windows host (got ${process.platform}); ` +
        "they launch release/win-unpacked/Synapse.exe."
    )
  }
}

export async function launchSynapse(options: { mode: LaunchMode }): Promise<LaunchedApp> {
  const userDir = mkdtempSync(path.join(tmpdir(), "synapse-e2e-"))

  let app: ElectronApplication
  if (options.mode === "packaged") {
    assertPackagedHostSupported()
    const executablePath = resolvePackagedExecutable()
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDir}`],
    })
  } else {
    // The repo root holds package.json (main → out/main/index.js). Launched
    // unpacked, so `app.isPackaged === false`, but the renderer still comes up
    // over `app://app` because ELECTRON_RENDERER_URL is unset outside dev.
    app = await electron.launch({
      args: [REPO_ROOT, `--user-data-dir=${userDir}`],
    })
  }

  const pid = app.process().pid
  let closed = false
  app.on("close", () => {
    closed = true
  })

  // Capture stdout/stderr so a readiness/diagnostic failure can surface what
  // the process actually printed (main-process logs go to stderr).
  let stdout = ""
  let stderr = ""
  app.process().stdout?.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  app.process().stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  // Renderer-side collectors: attach to every existing and future window.
  const pageEvents: DiagnosticEvent[] = []
  const attachPage = (page: Page): void => {
    page.on("pageerror", (error) => {
      pageEvents.push({
        source: "page",
        type: "pageerror",
        url: page.url(),
        detail: error.stack ?? error.message,
      })
    })
    page.on("crash", () => {
      pageEvents.push({
        source: "page",
        type: "crash",
        url: page.url(),
        detail: "renderer process crashed",
      })
    })
    page.on("console", (message) => {
      if (message.type() !== "error") return
      pageEvents.push({
        source: "page",
        type: "console.error",
        url: page.url(),
        detail: message.text(),
      })
    })
  }
  for (const page of app.windows()) attachPage(page)
  app.on("window", attachPage)

  // Main-process collectors: attach to every existing and future webContents
  // for did-fail-load / preload-error / render-process-gone. The listeners run
  // inside the main process and push into a global the test later reads back.
  await app.evaluate((electronModule) => {
    const globalAny = globalThis as unknown as { __synapseE2EDiagnostics?: unknown[] }
    const store = (globalAny.__synapseE2EDiagnostics ??= [])
    const anyModule = electronModule as unknown as {
      app: { on: (event: string, cb: (...args: unknown[]) => void) => void }
      webContents: { getAllWebContents: () => unknown[] }
    }
    const safeUrl = (wc: { getURL?: () => string }): string => {
      try {
        return wc.getURL?.() ?? ""
      } catch {
        return ""
      }
    }
    const attach = (wc: unknown): void => {
      const target = wc as {
        __synapseE2EAttached?: boolean
        on: (event: string, cb: (...args: unknown[]) => void) => void
        getURL?: () => string
      }
      if (!target || target.__synapseE2EAttached) return
      target.__synapseE2EAttached = true
      target.on("did-fail-load", (...args: unknown[]) => {
        const [, errorCode, errorDescription, validatedURL, isMainFrame] = args
        store.push({
          source: "main",
          // Only a main-frame failure is a shell-integrity failure; a failed
          // sub-resource/subframe is recorded but stays advisory.
          type: isMainFrame ? "did-fail-load-main" : "did-fail-load-subframe",
          url: safeUrl(target),
          detail: `code=${String(errorCode)} desc=${String(errorDescription)} validatedURL=${String(validatedURL)} mainFrame=${String(isMainFrame)}`,
        })
      })
      target.on("preload-error", (...args: unknown[]) => {
        const [, preloadPath, error] = args as [
          unknown,
          string,
          { stack?: string; message?: string },
        ]
        store.push({
          source: "main",
          type: "preload-error",
          url: safeUrl(target),
          detail: `${preloadPath}: ${error?.stack ?? error?.message ?? String(error)}`,
        })
      })
      target.on("render-process-gone", (...args: unknown[]) => {
        const [, details] = args
        store.push({
          source: "main",
          type: "render-process-gone",
          url: safeUrl(target),
          detail: JSON.stringify(details),
        })
      })
    }
    for (const wc of anyModule.webContents.getAllWebContents()) attach(wc)
    anyModule.app.on("web-contents-created", (...args: unknown[]) => attach(args[1]))
  })

  const readDiagnostics = async (): Promise<DiagnosticEvent[]> => {
    const pageSide = [...pageEvents]
    if (closed) return pageSide
    let mainSide: DiagnosticEvent[] = []
    try {
      mainSide = await app.evaluate(() => {
        const globalAny = globalThis as unknown as { __synapseE2EDiagnostics?: DiagnosticEvent[] }
        return globalAny.__synapseE2EDiagnostics ?? []
      })
    } catch {
      // App already gone — main-side events are unreachable; page-side stand.
    }
    return [...mainSide, ...pageSide]
  }

  const dispose = async (): Promise<void> => {
    try {
      if (!closed) await app.close()
    } catch {
      // Ignore — a crashed/exited app has nothing left to close.
    }
    forceKillTree(pid)
    removeVerifiedTempDir(userDir)
  }

  return {
    app,
    userDir,
    readStdout: () => stdout,
    readStderr: () => stderr,
    readDiagnostics,
    isClosed: () => closed,
    dispose,
  }
}

/** Find the no-hash main shell, (packaged only) require the exact URL, reveal
 *  every window, wait for the shell DOM, and complete one real getSettings()
 *  IPC round-trip. Returns the shell page and the settings it reported. */
export async function awaitShellReadiness(
  launched: LaunchedApp,
  options: { mode: LaunchMode }
): Promise<{ shell: Page; settings: Record<string, unknown> }> {
  const { app } = launched

  let shell: Page | undefined
  await expect
    .poll(
      () => {
        shell = app.windows().find((win) => {
          try {
            return new URL(win.url()).hash === ""
          } catch {
            return false
          }
        })
        return Boolean(shell)
      },
      { timeout: READINESS_TIMEOUT_MS }
    )
    .toBe(true)

  const shellPage = shell as Page

  // Packaged readiness requires the exact production shell origin+path (an
  // empty hash is allowed); a wrong URL means the app:// protocol handler or
  // the packaged renderer bundle regressed.
  if (options.mode === "packaged") {
    const parsed = new URL(shellPage.url())
    expect(parsed.hash).toBe("")
    expect(normalizeUrl(shellPage.url())).toBe(MAIN_SHELL_URL)
  }

  // The main window starts hidden (tray app); reveal every window so the page
  // is attached and laid out before asserting.
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.show()
  })

  await shellPage.waitForSelector('[data-testid="app-shell"]', { timeout: READINESS_TIMEOUT_MS })

  const settings = await shellPage.evaluate(() =>
    (
      window as unknown as {
        electronAPI: { getSettings: () => Promise<Record<string, unknown>> }
      }
    ).electronAPI.getSettings()
  )

  return { shell: shellPage, settings }
}

/** Assert the process is still alive after the post-readiness observation
 *  window (~12s). This runs AFTER readiness, never instead of it — a shell that
 *  renders then dies must still fail. */
export async function assertProcessAliveAfterReadiness(
  launched: LaunchedApp,
  ms: number = DEFAULT_LIVENESS_MS
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  if (launched.isClosed()) {
    const diagnostics = await launched.readDiagnostics()
    throw new Error(
      `App exited within the ${ms}ms post-readiness window.\n${formatFailure(
        diagnostics,
        launched
      )}`
    )
  }
  expect(launched.app.process().exitCode).toBeNull()
}

/** Fail if the main shell suffered a renderer/preload INTEGRITY failure
 *  (did-fail-load main frame, preload-error, render-process-gone, crash).
 *  Matching is by full URL INCLUDING hash, so sub-windows that share the
 *  bundle (launcher #search, floating ball #floating-ball) never count against
 *  the no-hash main shell. Advisory renderer errors on the shell are surfaced
 *  in the failure message for context but are not, by themselves, fatal (see
 *  INTEGRITY_TYPES). */
export async function assertNoShellDiagnostics(launched: LaunchedApp, shell: Page): Promise<void> {
  const shellHref = fullHref(shell.url())
  const diagnostics = await launched.readDiagnostics()
  const onShell = diagnostics.filter((event) => fullHref(event.url) === shellHref)
  const fatal = onShell.filter((event) => INTEGRITY_TYPES.has(event.type))
  if (fatal.length > 0) {
    throw new Error(
      `Main shell (${shellHref}) suffered ${fatal.length} integrity failure(s).\n${formatFailure(
        onShell,
        launched
      )}`
    )
  }
}

/** Normalize a URL to scheme://host/path, dropping hash and query. Custom
 *  schemes like `app://` have an opaque origin (URL.origin === "null" in
 *  Node), so reconstruct from protocol+host+pathname rather than .origin. */
function normalizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return raw
  }
}

/** Like normalizeUrl but keeps the hash, so the no-hash main shell is
 *  distinguished from hash-routed sub-windows. */
function fullHref(raw: string): string {
  try {
    const parsed = new URL(raw)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.hash}`
  } catch {
    return raw
  }
}

function formatFailure(diagnostics: DiagnosticEvent[], launched: LaunchedApp): string {
  const events = diagnostics
    .map((event) => `  [${event.source}:${event.type}] ${event.url} :: ${event.detail}`)
    .join("\n")
  return (
    `Events:\n${events || "  (none)"}\n` +
    `--- stdout ---\n${launched.readStdout()}\n` +
    `--- stderr ---\n${launched.readStderr()}`
  )
}

/** On Windows the packaged app fans out into GPU/utility/MCP children; kill the
 *  whole tree by pid so a failed `app.close()` cannot leave orphans. Best
 *  effort — a process that already exited makes taskkill/kill error, ignored. */
function forceKillTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // No process group — fall through to the direct kill.
      }
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Already gone / not killable — nothing to clean up.
  }
}

/** Remove ONLY the verified temporary profile: refuse to delete anything that
 *  does not resolve to a path under the OS temp root. */
function removeVerifiedTempDir(userDir: string): void {
  const tempRoot = realpathSync(tmpdir())
  let target: string
  try {
    target = realpathSync(userDir)
  } catch {
    return
  }
  const relative = path.relative(tempRoot, target)
  const isUnderTemp = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  if (!isUnderTemp) return
  rmSync(target, { recursive: true, force: true })
}
