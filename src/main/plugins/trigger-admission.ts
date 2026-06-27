export type AdmitReason = "throttled" | "faulted" | "paused"
export interface AdmitResult {
  ok: boolean
  reason?: AdmitReason
}

export interface AdmissionConfig {
  minIntervalMs: number
  maxConcurrency: number
  /** Consecutive faults before auto-pause. Default 5. */
  faultThreshold?: number
}

interface State extends AdmissionConfig {
  lastFiredAt: number
  inflight: number
  consecutiveFaults: number
  pausedManually: boolean
  pausedByFault: boolean
}

function keyOf(pluginId: string, triggerId: string): string {
  return `${pluginId}\0${triggerId}`
}

/**
 * Stage-(a) breaker: decides whether an incoming event may create a background
 * invocation at all. Owns fire-frequency, concurrency, fault auto-pause and
 * manual pause. NOT a consent mechanism — refusals are silent drops.
 *
 * State is keyed by (pluginId, triggerId) so identically-named triggers on
 * different plugins never share inflight, rate, or fault counters.
 */
export class AdmissionBreaker {
  private readonly states = new Map<string, State>()
  constructor(private readonly now: () => number = Date.now) {}

  configure(pluginId: string, triggerId: string, config: AdmissionConfig): void {
    const id = keyOf(pluginId, triggerId)
    const prev = this.states.get(id)
    this.states.set(id, {
      faultThreshold: 5,
      ...config,
      lastFiredAt: prev?.lastFiredAt ?? Number.NEGATIVE_INFINITY,
      inflight: prev?.inflight ?? 0,
      consecutiveFaults: prev?.consecutiveFaults ?? 0,
      pausedManually: prev?.pausedManually ?? false,
      pausedByFault: prev?.pausedByFault ?? false,
    })
  }

  admit(pluginId: string, triggerId: string): AdmitResult {
    const s = this.states.get(keyOf(pluginId, triggerId))
    if (!s) return { ok: false, reason: "paused" }
    if (s.pausedManually || s.pausedByFault)
      return { ok: false, reason: s.pausedByFault ? "faulted" : "paused" }
    if (s.inflight >= s.maxConcurrency) return { ok: false, reason: "throttled" }
    const t = this.now()
    if (t - s.lastFiredAt < s.minIntervalMs) return { ok: false, reason: "throttled" }
    s.lastFiredAt = t
    s.inflight += 1
    return { ok: true }
  }

  release(pluginId: string, triggerId: string): void {
    const s = this.states.get(keyOf(pluginId, triggerId))
    if (s && s.inflight > 0) s.inflight -= 1
  }

  recordFault(pluginId: string, triggerId: string): void {
    const s = this.states.get(keyOf(pluginId, triggerId))
    if (!s) return
    s.consecutiveFaults += 1
    if (s.consecutiveFaults >= (s.faultThreshold ?? 5)) s.pausedByFault = true
  }

  recordSuccess(pluginId: string, triggerId: string): void {
    const s = this.states.get(keyOf(pluginId, triggerId))
    if (s) s.consecutiveFaults = 0
  }

  pause(pluginId: string, triggerId: string): void {
    const s = this.states.get(keyOf(pluginId, triggerId))
    if (s) s.pausedManually = true
  }

  resume(pluginId: string, triggerId: string): void {
    const s = this.states.get(keyOf(pluginId, triggerId))
    if (s) {
      s.pausedManually = false
      s.pausedByFault = false
      s.consecutiveFaults = 0
    }
  }

  status(pluginId: string, triggerId: string): "active" | "paused" | "faulted" | undefined {
    const s = this.states.get(keyOf(pluginId, triggerId))
    if (!s) return undefined
    if (s.pausedByFault) return "faulted"
    if (s.pausedManually) return "paused"
    return "active"
  }

  remove(pluginId: string, triggerId: string): void {
    this.states.delete(keyOf(pluginId, triggerId))
  }
}
