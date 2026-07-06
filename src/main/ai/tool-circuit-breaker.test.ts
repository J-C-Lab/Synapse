import { describe, expect, it } from "vitest"
import { ToolCircuitBreaker } from "./tool-circuit-breaker"

// A pure, injectable-clock breaker. `now` is passed explicitly so tests never
// touch real time. Config below trips after 3 infra failures, recovers in 1000ms.
function breaker(): ToolCircuitBreaker {
  return new ToolCircuitBreaker("mcp:srv", { failureThreshold: 3, recoveryMs: 1000 })
}

describe("toolCircuitBreaker", () => {
  it("starts closed and allows calls", () => {
    const b = breaker()
    expect(b.tryAcquire(0)).toBe("allow")
    expect(b.snapshot(0).state).toBe("closed")
  })

  it("opens after the failure threshold and blocks within the recovery window", () => {
    const b = breaker()
    b.tryAcquire(0)
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    expect(b.snapshot(0).state).toBe("open")
    expect(b.tryAcquire(500)).toBe("block") // still within 1000ms recovery
  })

  it("admits exactly one probe after the recovery window (single-flight half-open)", () => {
    const b = breaker()
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    // 1200 > openedAt(0) + recovery(1000): first caller becomes the probe...
    expect(b.tryAcquire(1200)).toBe("allow_probe")
    expect(b.snapshot(1200).state).toBe("half_open")
    // ...concurrent second caller is blocked while the probe is in flight.
    expect(b.tryAcquire(1200)).toBe("block")
  })

  it("closes and resets when the probe succeeds", () => {
    const b = breaker()
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    expect(b.tryAcquire(1200)).toBe("allow_probe")
    b.recordSuccess(10, 1200)
    expect(b.snapshot(1200).state).toBe("closed")
    expect(b.snapshot(1200).consecutiveFailures).toBe(0)
    expect(b.tryAcquire(1300)).toBe("allow")
  })

  it("re-opens when the probe fails", () => {
    const b = breaker()
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    expect(b.tryAcquire(1200)).toBe("allow_probe")
    b.recordInfraFailure(1200)
    expect(b.snapshot(1200).state).toBe("open")
    expect(b.tryAcquire(1300)).toBe("block") // fresh recovery window from 1200
  })

  it("does not trip on tool errors — they are domain errors, not infra failures", () => {
    const b = breaker()
    for (let i = 0; i < 10; i++) b.recordToolError(5, i)
    expect(b.snapshot(10).state).toBe("closed")
    expect(b.tryAcquire(10)).toBe("allow")
    expect(b.snapshot(10).toolErrors).toBe(10)
  })

  it("resets the consecutive-failure count on success", () => {
    const b = breaker()
    b.recordInfraFailure(0)
    b.recordInfraFailure(0) // 2 of 3, not yet open
    b.recordSuccess(10, 0)
    expect(b.snapshot(0).consecutiveFailures).toBe(0)
    b.recordInfraFailure(0)
    b.recordInfraFailure(0)
    expect(b.snapshot(0).state).toBe("closed") // needs 3 in a row again
  })

  it("reports counts and a rolling average latency in its snapshot", () => {
    const b = breaker()
    b.recordSuccess(100, 0)
    b.recordSuccess(200, 1)
    b.recordToolError(300, 2)
    const snap = b.snapshot(2)
    expect(snap.key).toBe("mcp:srv")
    expect(snap.total).toBe(3)
    expect(snap.ok).toBe(2)
    expect(snap.toolErrors).toBe(1)
    expect(snap.infraFailures).toBe(0)
    expect(snap.avgLatencyMs).toBe(200) // (100 + 200 + 300) / 3
  })
})
