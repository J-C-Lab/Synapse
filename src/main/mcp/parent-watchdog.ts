import process from "node:process"

export interface ParentWatchdogOptions {
  parentPid: number
  /** How often to check, in ms. Default 2000. */
  checkIntervalMs?: number
  /** Called exactly once, the first time the parent is observed gone. */
  onParentGone: () => void
  /** Test seam — real liveness check is process.kill(pid, 0), which throws
   *  if the process doesn't exist (works cross-platform, including
   *  Windows, where Node's process.kill maps signal 0 to an existence
   *  check rather than actually sending a signal). */
  isAlive?: (pid: number) => boolean
}

export interface ParentWatchdog {
  stop: () => void
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function startParentWatchdog(options: ParentWatchdogOptions): ParentWatchdog {
  const isAlive = options.isAlive ?? defaultIsAlive
  const interval = setInterval(() => {
    if (!isAlive(options.parentPid)) {
      clearInterval(interval)
      options.onParentGone()
    }
  }, options.checkIntervalMs ?? 2000)
  interval.unref()
  return { stop: () => clearInterval(interval) }
}
