// Auto-update orchestration, decoupled from electron-updater so the state
// machine is unit-testable. The real autoUpdater is injected as AutoUpdaterPort
// in index.ts; tests inject a fake. The flow is manual by default: we check,
// surface "available" to the renderer, and only download / install when the
// user asks — never silently restarting the app under them.

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error"

export interface UpdateState {
  status: UpdateStatus
  /** The version currently running. */
  currentVersion: string
  /** The available/downloaded version, when known. */
  version?: string
  /** Download progress 0–100, while downloading. */
  percent?: number
  /** Last error message, when status is "error". */
  error?: string
}

/** The slice of electron-updater's autoUpdater this service drives. */
export interface AutoUpdaterPort {
  autoDownload: boolean
  on: (event: string, handler: (...args: unknown[]) => void) => void
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: () => void
}

/**
 * Whether to run the startup update check on this platform. macOS auto-update
 * needs a Developer ID signature (Squirrel.Mac rejects unsigned packages), and
 * we ship macOS unsigned — so we never offer updates there rather than surface a
 * banner for an update that cannot install. Dev (unpackaged) never checks.
 */
export function shouldAutoCheckOnStartup(platform: NodeJS.Platform, isPackaged: boolean): boolean {
  if (!isPackaged) return false
  return platform !== "darwin"
}

export interface UpdateServiceOptions {
  updater: AutoUpdaterPort
  currentVersion: string
  onChange?: (state: UpdateState) => void
  /** Manual flow: `check` does not auto-download. Defaults to true. */
  manualDownload?: boolean
}

export class UpdateService {
  private state: UpdateState

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = { status: "idle", currentVersion: options.currentVersion }
    options.updater.autoDownload = options.manualDownload === false
    this.subscribe()
  }

  getState(): UpdateState {
    return this.state
  }

  async check(): Promise<void> {
    this.set({ status: "checking" })
    try {
      await this.options.updater.checkForUpdates()
    } catch (err) {
      this.set({ status: "error", error: message(err) })
    }
  }

  async download(): Promise<void> {
    try {
      await this.options.updater.downloadUpdate()
    } catch (err) {
      this.set({ status: "error", error: message(err) })
    }
  }

  install(): void {
    this.options.updater.quitAndInstall()
  }

  private subscribe(): void {
    const u = this.options.updater
    u.on("checking-for-update", () => this.set({ status: "checking" }))
    u.on("update-available", (info) =>
      this.set({ status: "available", version: versionOf(info), error: undefined })
    )
    u.on("update-not-available", () => this.set({ status: "not-available" }))
    u.on("download-progress", (progress) =>
      this.set({ status: "downloading", percent: percentOf(progress) })
    )
    u.on("update-downloaded", (info) =>
      this.set({ status: "downloaded", version: versionOf(info) })
    )
    u.on("error", (err) => this.set({ status: "error", error: message(err) }))
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onChange?.(this.state)
  }
}

function versionOf(info: unknown): string | undefined {
  if (
    info &&
    typeof info === "object" &&
    typeof (info as { version?: unknown }).version === "string"
  ) {
    return (info as { version: string }).version
  }
  return undefined
}

function percentOf(progress: unknown): number | undefined {
  if (
    progress &&
    typeof progress === "object" &&
    typeof (progress as { percent?: unknown }).percent === "number"
  ) {
    return Math.round((progress as { percent: number }).percent)
  }
  return undefined
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
