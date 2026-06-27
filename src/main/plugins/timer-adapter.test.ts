import { describe, expect, it } from "vitest"
import { createTimerAdapter, MAX_SET_TIMEOUT_DELAY_MS } from "./timer-adapter"

describe("timer adapter", () => {
  it("rejects an interval below the stable floor", () => {
    const a = createTimerAdapter({ minFloorMs: 60000 })
    expect(() => a.register("t", { intervalMs: 1000 }, () => {})).toThrow(/minimum interval/)
  })

  it("fires a safe event on each interval and stops on dispose", () => {
    const timers: Array<() => void> = []
    let now = 0
    const a = createTimerAdapter({
      minFloorMs: 0,
      now: () => now,
      setTimer: (cb) => {
        timers.push(cb)
        return timers.length - 1
      },
      clearTimer: () => {},
    })
    const fired: TimerEvent[] = []
    const dispose = a.register("t", { intervalMs: 1000 }, (e) => fired.push(e))
    now = 1000
    timers[0]?.()
    expect(fired[0]).toMatchObject({ firedAt: 1000 })
    expect(typeof fired[0]?.driftMs).toBe("number")
    dispose()
  })

  it("fires on cron schedule and reschedules after dispose stops future fires", () => {
    let now = new Date(2025, 0, 1, 8, 0, 0).getTime()
    const timeouts: Array<{ cb: () => void; at: number }> = []
    const a = createTimerAdapter({
      minFloorMs: 60_000,
      now: () => now,
      setTimeout: (cb, ms) => {
        timeouts.push({ cb, at: now + ms })
        return timeouts.length - 1
      },
      clearTimeout: () => {},
    })
    const fired: TimerEvent[] = []
    const dispose = a.registerCron("daily", "0 9 * * *", (event) => fired.push(event))

    expect(timeouts).toHaveLength(1)
    expect(timeouts[0]?.at).toBe(new Date(2025, 0, 1, 9, 0, 0).getTime())

    now = timeouts[0]!.at
    timeouts[0]?.cb()
    expect(fired[0]).toMatchObject({
      scheduledAt: new Date(2025, 0, 1, 9, 0, 0).getTime(),
      firedAt: now,
    })
    expect(timeouts).toHaveLength(2)

    dispose()
    const count = timeouts.length
    now = timeouts[1]!.at
    timeouts[1]?.cb()
    expect(fired).toHaveLength(1)
    expect(timeouts).toHaveLength(count)
  })

  it("chunks long cron delays to avoid setTimeout overflow busy-loop", () => {
    const target = new Date(2025, 1, 1, 9, 0, 0).getTime()
    let now = new Date(2025, 0, 2, 8, 0, 0).getTime()
    let pending: (() => void) | undefined
    const delays: number[] = []
    const fired: TimerEvent[] = []
    const a = createTimerAdapter({
      minFloorMs: 60_000,
      now: () => now,
      setTimeout: (cb, ms) => {
        delays.push(ms)
        pending = cb
        return delays.length - 1
      },
      clearTimeout: () => {
        pending = undefined
      },
    })

    a.registerCron("monthly", "0 9 1 * *", (event) => fired.push(event))

    expect(delays[0]).toBe(MAX_SET_TIMEOUT_DELAY_MS)

    now += MAX_SET_TIMEOUT_DELAY_MS
    pending?.()
    expect(fired).toHaveLength(0)
    expect(delays[1]).toBeLessThanOrEqual(MAX_SET_TIMEOUT_DELAY_MS)
    expect(delays[1]).toBeGreaterThan(0)

    now = target - 1000
    pending?.()
    expect(fired).toHaveLength(0)

    now = target
    pending?.()
    expect(fired).toHaveLength(1)
    expect(fired[0]?.scheduledAt).toBe(target)
  })
})

type TimerEvent = import("./timer-adapter").TimerEvent
