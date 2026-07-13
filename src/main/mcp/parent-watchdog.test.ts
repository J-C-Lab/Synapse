import { describe, expect, it, vi } from "vitest"
import { startParentWatchdog } from "./parent-watchdog"

describe("startParentWatchdog", () => {
  it("calls onParentGone once the injected isAlive check reports the parent is dead", async () => {
    vi.useFakeTimers()
    let alive = true
    const onParentGone = vi.fn()
    const watchdog = startParentWatchdog({
      parentPid: 12345,
      checkIntervalMs: 100,
      isAlive: () => alive,
      onParentGone,
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(onParentGone).not.toHaveBeenCalled()

    alive = false
    await vi.advanceTimersByTimeAsync(100)
    expect(onParentGone).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(300)
    expect(onParentGone).toHaveBeenCalledTimes(1)

    watchdog.stop()
    vi.useRealTimers()
  })

  it("stop() prevents onParentGone from ever firing", async () => {
    vi.useFakeTimers()
    const onParentGone = vi.fn()
    const watchdog = startParentWatchdog({
      parentPid: 12345,
      checkIntervalMs: 100,
      isAlive: () => false,
      onParentGone,
    })
    watchdog.stop()

    await vi.advanceTimersByTimeAsync(1000)

    expect(onParentGone).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("the default isAlive uses process.kill(pid, 0) semantics — a real, currently-running process resolves alive", () => {
    const watchdog = startParentWatchdog({
      parentPid: process.pid,
      onParentGone: () => {
        throw new Error("should not fire for a live process")
      },
    })
    watchdog.stop()
  })
})
