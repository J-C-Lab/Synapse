import type { ElectronApplication, Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
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

/** Main-process / renderer integrity failures: broken assets, preload, or
 *  renderer process gone. Sub-windows (launcher #search, floating ball) are
 *  matched by full URL including hash, so their noise never counts against the
 *  no-hash main shell. */
const INTEGRITY_TYPES = new Set([
  "did-fail-load-main",
  "preload-error",
  "render-process-gone",
  "crash",
])

/** console.error on the main shell is fatal by default; keep the allowlist empty
 *  unless a proven CI-noise pattern needs a narrowly scoped exemption. */
const MAIN_SHELL_CONSOLE_ERROR_ALLOWLIST: ReadonlyArray<{
  pattern: string
  prefix?: boolean
  reason: string
}> = []

/** pageerror on the main shell is always fatal. Only proven CI-noise patterns that
 *  currently surface as uncaught rejections (not console.error) may be exempt. */
const MAIN_SHELL_PAGEERROR_ALLOWLIST: ReadonlyArray<{
  pattern: string
  prefix?: boolean
  reason: string
}> = []

function matchesAllowlist(
  detail: string,
  allowlist: ReadonlyArray<{ pattern: string; prefix?: boolean }>
): boolean {
  for (const entry of allowlist) {
    if (entry.prefix ? detail.startsWith(entry.pattern) : detail === entry.pattern) {
      return true
    }
  }
  return false
}

/** True when a diagnostic on the main shell must fail the packaged smoke proof. */
function isFatalShellEvent(event: DiagnosticEvent): boolean {
  if (INTEGRITY_TYPES.has(event.type)) return true
  if (event.type === "pageerror")
    return !matchesAllowlist(event.detail, MAIN_SHELL_PAGEERROR_ALLOWLIST)
  if (event.type === "console.error") {
    return !matchesAllowlist(event.detail, MAIN_SHELL_CONSOLE_ERROR_ALLOWLIST)
  }
  return false
}

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

/** Resolve an executable path from an environment variable that must already
 *  be an absolute, existing path. Used by the profile-compat suite, which
 *  needs two SPECIFIC Electron builds (a retained 33 baseline + the 43
 *  candidate) rather than the single conventionally-located packaged build
 *  `resolvePackagedExecutable` resolves. FAILS (never skips, never silently
 *  resolves a relative path against cwd) when the variable is missing,
 *  relative, or points at nothing. */
export function resolveExplicitExecutable(envVar: string): string {
  const raw = process.env[envVar]?.trim()
  if (!raw) {
    throw new Error(
      `${envVar} is required for the profile-compat suite: set it to an absolute, ` +
        "existing Synapse.exe path."
    )
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(`${envVar} must be an absolute path (got "${raw}").`)
  }
  if (!existsSync(raw)) {
    throw new Error(`${envVar} points at a missing file: ${raw}`)
  }
  return raw
}

/** SHA-256 of a file, for secret-free PR evidence (executable identity) —
 *  never used on profile contents, which may carry the encrypted sentinel
 *  credential. */
export function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** True when `target` resolves under (or equals) `root`. `target` need not
 *  exist yet: a copy/mkdir destination is checked textually against the
 *  root's realpath so callers can verify a path BEFORE creating it. */
export function isVerifiedUnderRoot(root: string, target: string): boolean {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return false
  }
  let candidate: string
  try {
    candidate = realpathSync(target)
  } catch {
    candidate = path.resolve(target)
  }
  if (candidate === realRoot) return true
  const relative = path.relative(realRoot, candidate)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** Recursively copy a directory, refusing to touch anything outside the
 *  test-owned `root`. Mirrors `removeVerifiedTempDir`'s safety check but for
 *  an arbitrary caller-owned root (the profile-compat suite mkdtemp's its own
 *  root rather than trusting the bare OS tmp root) and for both the source
 *  and destination of a copy. */
export function copyVerifiedDir(root: string, src: string, dest: string): void {
  if (!isVerifiedUnderRoot(root, src)) {
    throw new Error(`Refusing to copy from a path outside the verified root: ${src}`)
  }
  if (!isVerifiedUnderRoot(root, dest)) {
    throw new Error(`Refusing to copy to a path outside the verified root: ${dest}`)
  }
  cpSync(src, dest, { recursive: true })
}

/** Remove a directory, refusing to touch anything outside the test-owned
 *  `root`. Safe to call on a path that does not exist. */
export function removeVerifiedDirUnder(root: string, target: string): void {
  if (!isVerifiedUnderRoot(root, target)) {
    throw new Error(`Refusing to remove a path outside the verified root: ${target}`)
  }
  // maxRetries/retryDelay: on Windows a just-killed process's file handles
  // (e.g. a LevelDB log under Local Storage) can take a moment to release
  // after taskkill returns, which otherwise surfaces as a flaky EBUSY here.
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
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
  const launchPromise =
    options.mode === "packaged"
      ? launchPackagedAt(userDir)
      : // The repo root holds package.json (main → out/main/index.js). Launched
        // unpacked, so `app.isPackaged === false`, but the renderer still comes
        // up over `app://app` because ELECTRON_RENDERER_URL is unset outside dev.
        electron.launch({ args: [REPO_ROOT, `--user-data-dir=${userDir}`] })
  return instrumentLaunch(launchPromise, userDir, { ownsUserDir: true })
}

/** Launch the unpacked dev-mode app (repo root) against a CALLER-PROVIDED,
 *  already-existing user-data directory. Unlike `launchSynapse`, the caller
 *  owns the directory's entire lifecycle (creation, seeding, deletion) — this
 *  is what a durable-recovery proof needs: seed a checkpoint on disk BEFORE
 *  the app's very first launch, so the running app itself discovers and
 *  lists it as recoverable, rather than a test-only shortcut proving nothing
 *  about the real startup scan. */
export async function launchSynapseDevAtUserDir(userDir: string): Promise<LaunchedApp> {
  if (!existsSync(userDir)) {
    throw new Error(`launchSynapseDevAtUserDir: user-data directory not found: ${userDir}`)
  }
  const launchPromise = electron.launch({ args: [REPO_ROOT, `--user-data-dir=${userDir}`] })
  return instrumentLaunch(launchPromise, userDir, { ownsUserDir: false })
}

function launchPackagedAt(userDir: string): Promise<ElectronApplication> {
  assertPackagedHostSupported()
  const executablePath = resolvePackagedExecutable()
  return electron.launch({ executablePath, args: [`--user-data-dir=${userDir}`] })
}

/** Launch a SPECIFIC Electron build against a SPECIFIC, already-existing,
 *  test-controlled profile directory. Unlike `launchSynapse`, the caller owns
 *  the profile directory's entire lifecycle (creation, cloning, deletion) —
 *  this function neither creates nor removes it, and `dispose()` only closes
 *  the app/kills its process tree. That's what the profile-compat harness
 *  needs: the SAME profile directory reopened across multiple launches (the
 *  Electron-33 original, then independent Electron-43 forward/rollback
 *  clones, then Electron-33 again on the rollback clone). */
export async function launchSynapseAtProfile(options: {
  executablePath: string
  userDir: string
}): Promise<LaunchedApp> {
  if (!existsSync(options.executablePath)) {
    throw new Error(`launchSynapseAtProfile: executable not found: ${options.executablePath}`)
  }
  if (!existsSync(options.userDir)) {
    throw new Error(`launchSynapseAtProfile: profile directory not found: ${options.userDir}`)
  }
  const launchPromise = electron.launch({
    executablePath: options.executablePath,
    args: [`--user-data-dir=${options.userDir}`],
  })
  return instrumentLaunch(launchPromise, options.userDir, { ownsUserDir: false })
}

/** Retry a flaky async step a few times with a short delay. Used for the
 *  diagnostic-listener attach below, which can transiently race the app's
 *  very first internal navigation. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 250): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastErr
}

/** Runs INSIDE the Electron main process via `app.evaluate`. Attaches
 *  did-fail-load / preload-error / render-process-gone listeners to every
 *  existing and future webContents, pushing into a global the test later
 *  reads back via `readDiagnostics`. Idempotent per-webContents (guarded by
 *  `__synapseE2EAttached`), so a retried call after a destroyed-context error
 *  is always safe to re-run. */
function attachDiagnosticListeners(electronModule: typeof import("electron")): void {
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
      const [, preloadPath, error] = args as [unknown, string, { stack?: string; message?: string }]
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
}

async function instrumentLaunch(
  launchPromise: Promise<ElectronApplication>,
  userDir: string,
  options: { ownsUserDir: boolean }
): Promise<LaunchedApp> {
  let app: ElectronApplication
  try {
    app = await launchPromise
  } catch (err) {
    if (options.ownsUserDir) removeVerifiedTempDir(userDir)
    throw err
  }

  const pid = app.process().pid
  let closed = false
  let stdout = ""
  let stderr = ""
  const pageEvents: DiagnosticEvent[] = []

  // Everything below attaches listeners / runs a main-process evaluate — if
  // ANY of it throws, the Electron process is already running and must still
  // be force-killed (and, if we own it, the temp profile removed). Otherwise
  // a half-instrumented launch leaks a running process that keeps its own
  // profile files open, which then surfaces as a confusing EBUSY on the
  // caller's cleanup instead of the real failure.
  try {
    app.on("close", () => {
      closed = true
    })

    // Capture stdout/stderr so a readiness/diagnostic failure can surface what
    // the process actually printed (main-process logs go to stderr).
    app.process().stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    app.process().stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    // Renderer-side collectors: attach to every existing and future window.
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
    //
    // Retried: this can race the app's very first internal navigation right
    // after launch (observed against the Electron-33 baseline), which
    // transiently destroys the execution context evaluate() was about to run
    // in. That's harmless — the retry runs the exact same idempotent attach
    // logic against whatever context exists a moment later.
    await withRetry(() => app.evaluate(attachDiagnosticListeners))
  } catch (err) {
    forceKillTree(pid)
    if (options.ownsUserDir) removeVerifiedTempDir(userDir)
    throw err
  }

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
    if (options.ownsUserDir) removeVerifiedTempDir(userDir)
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

/** Fail if the main shell suffered any fatal diagnostic: integrity failures
 *  (did-fail-load main frame, preload-error, render-process-gone, crash),
 *  pageerror, or console.error (except narrowly allowlisted CI noise).
 *  Matching is by full URL INCLUDING hash, so sub-windows that share the
 *  bundle (launcher #search, floating ball #floating-ball) never count against
 *  the no-hash main shell. */
export async function assertNoShellDiagnostics(launched: LaunchedApp, shell: Page): Promise<void> {
  const shellHref = fullHref(shell.url())
  const diagnostics = await launched.readDiagnostics()
  const onShell = diagnostics.filter((event) => fullHref(event.url) === shellHref)
  const fatal = onShell.filter(isFatalShellEvent)
  if (fatal.length > 0) {
    throw new Error(
      `Main shell (${shellHref}) suffered ${fatal.length} fatal diagnostic(s).\n${formatFailure(
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
  // maxRetries/retryDelay: on Windows a just-killed process's file handles
  // (e.g. a LevelDB log under Local Storage) can take a moment to release
  // after taskkill returns, which otherwise surfaces as a flaky EBUSY here.
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
