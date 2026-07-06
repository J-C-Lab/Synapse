// A per-tool circuit breaker with an explicit, injected clock. Pure and
// Electron-free so it unit-tests without any harness (CLAUDE.md IPC pattern).
//
// Design notes vs. the naive Java reference this was adapted from:
//   • HALF_OPEN admits exactly ONE probe (single-flight). The naive version let
//     every caller through in half-open and re-punched a recovering dependency.
//     JS is single-threaded, so flipping `probeInFlight` synchronously inside
//     tryAcquire() is enough to serialize concurrent async callers.
//   • Only INFRA failures (thrown/timed-out invocations) trip the breaker.
//     A tool that runs and returns `isError` (file-not-found, bad args) is a
//     domain error, not an outage — it must not short-circuit the tool.

export type CircuitState = "closed" | "open" | "half_open"

export type AcquireDecision = "allow" | "allow_probe" | "block"

export interface BreakerConfig {
  /** Consecutive infra failures that trip CLOSED → OPEN. */
  failureThreshold: number
  /** How long OPEN waits before admitting a probe (ms). */
  recoveryMs: number
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  recoveryMs: 60_000,
}

export interface ToolStatSnapshot {
  key: string
  state: CircuitState
  total: number
  ok: number
  /** Failures that count toward tripping (throws + timeouts). */
  infraFailures: number
  /** `isError` results — recorded but never trip the breaker. */
  toolErrors: number
  consecutiveFailures: number
  avgLatencyMs: number
  openedAt?: number
  lastErrorAt?: number
  /** Wall-clock of the last recorded activity — drives idle eviction. */
  lastTouchedAt: number
}

export class ToolCircuitBreaker {
  private state: CircuitState = "closed"
  private consecutiveFailures = 0
  private probeInFlight = false
  private openedAt?: number
  private lastErrorAt?: number
  private lastTouchedAt = 0

  private total = 0
  private ok = 0
  private infraFailures = 0
  private toolErrors = 0
  private latencySum = 0

  private readonly config: BreakerConfig

  constructor(
    private readonly key: string,
    config: Partial<BreakerConfig> = {}
  ) {
    this.config = { ...DEFAULT_BREAKER_CONFIG, ...config }
  }

  /** Decide whether a call may proceed. Claims the single half-open probe. */
  tryAcquire(now: number): AcquireDecision {
    if (this.state === "closed") return "allow"
    if (this.state === "open") {
      const recoveredAt = (this.openedAt ?? now) + this.config.recoveryMs
      if (now < recoveredAt) return "block"
      this.state = "half_open"
    }
    // half_open: admit exactly one probe.
    if (this.probeInFlight) return "block"
    this.probeInFlight = true
    return "allow_probe"
  }

  recordSuccess(latencyMs: number, now: number): void {
    this.touch(latencyMs, now)
    this.ok++
    this.consecutiveFailures = 0
    this.probeInFlight = false
    this.state = "closed"
    this.openedAt = undefined
  }

  /** A thrown/timed-out invocation: counts toward tripping. */
  recordInfraFailure(now: number): void {
    this.touch(0, now)
    this.infraFailures++
    this.consecutiveFailures++
    this.lastErrorAt = now
    this.probeInFlight = false
    if (this.state === "half_open" || this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = "open"
      this.openedAt = now
    }
  }

  /** An `isError` result: stats only, never trips the breaker. */
  recordToolError(latencyMs: number, now: number): void {
    this.touch(latencyMs, now)
    this.toolErrors++
  }

  snapshot(now: number): ToolStatSnapshot {
    // Reflect a due recovery in reads too, so a stale OPEN isn't reported after
    // its window has elapsed without any intervening call.
    let state = this.state
    if (state === "open" && now >= (this.openedAt ?? now) + this.config.recoveryMs) {
      state = "half_open"
    }
    return {
      key: this.key,
      state,
      total: this.total,
      ok: this.ok,
      infraFailures: this.infraFailures,
      toolErrors: this.toolErrors,
      consecutiveFailures: this.consecutiveFailures,
      avgLatencyMs: this.total === 0 ? 0 : Math.round(this.latencySum / this.total),
      openedAt: this.openedAt,
      lastErrorAt: this.lastErrorAt,
      lastTouchedAt: this.lastTouchedAt,
    }
  }

  /** Wall-clock of last activity, for the host's idle eviction. */
  idleSince(): number {
    return this.lastTouchedAt
  }

  private touch(latencyMs: number, now: number): void {
    this.total++
    this.latencySum += latencyMs
    this.lastTouchedAt = now
  }
}
