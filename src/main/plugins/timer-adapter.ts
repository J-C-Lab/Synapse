import {
  nextCronFire,
  normalizeCronExpression,
  validateCronExpression,
} from "@synapse/plugin-manifest"

export interface TimerEvent {
  scheduledAt: number
  firedAt: number
  driftMs: number
}

export interface TimerSchedule {
  intervalMs: number
}

export interface TimerAdapterOptions {
  minFloorMs: number
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  setTimeout?: (cb: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export interface TimerAdapter {
  register: (
    triggerId: string,
    schedule: TimerSchedule,
    fire: (e: TimerEvent) => void
  ) => () => void
  registerCron: (
    triggerId: string,
    cronExpression: string,
    fire: (e: TimerEvent) => void
  ) => () => void
}

/** Node/Electron setTimeout delay ceiling (~24.8 days). Longer waits must be chunked. */
export const MAX_SET_TIMEOUT_DELAY_MS = 2 ** 31 - 1

export function createTimerAdapter(options: TimerAdapterOptions): TimerAdapter {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((cb, ms) => setInterval(cb, ms))
  const clearTimer =
    options.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
  const setTimeoutFn = options.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimeoutFn =
    options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  return {
    register(triggerId, schedule, fire) {
      if (schedule.intervalMs < options.minFloorMs)
        throw new Error(`timer ${triggerId}: minimum interval is ${options.minFloorMs}ms`)
      let scheduledAt = now()
      const handle = setTimer(() => {
        const firedAt = now()
        fire({ scheduledAt, firedAt, driftMs: firedAt - scheduledAt - schedule.intervalMs })
        scheduledAt = firedAt
      }, schedule.intervalMs)
      return () => clearTimer(handle)
    },

    registerCron(triggerId, cronExpression, fire) {
      const normalized = normalizeCronExpression(cronExpression)
      validateCronExpression(normalized, { minIntervalMs: options.minFloorMs })

      let disposed = false
      let timeoutHandle: unknown
      let targetScheduledAt = 0

      const armTimer = (): void => {
        if (disposed) return
        const current = now()
        if (targetScheduledAt === 0) targetScheduledAt = nextCronFire(current, normalized)

        const remaining = targetScheduledAt - current
        if (remaining <= 0) {
          const firedAt = now()
          fire({ scheduledAt: targetScheduledAt, firedAt, driftMs: firedAt - targetScheduledAt })
          targetScheduledAt = 0
          armTimer()
          return
        }

        const delay = Math.min(remaining, MAX_SET_TIMEOUT_DELAY_MS)
        timeoutHandle = setTimeoutFn(() => {
          if (disposed) return
          if (now() >= targetScheduledAt) {
            const firedAt = now()
            fire({
              scheduledAt: targetScheduledAt,
              firedAt,
              driftMs: firedAt - targetScheduledAt,
            })
            targetScheduledAt = 0
          }
          armTimer()
        }, delay)
      }

      armTimer()
      return () => {
        disposed = true
        clearTimeoutFn(timeoutHandle)
      }
    },
  }
}
