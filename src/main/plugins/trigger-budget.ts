export interface BudgetKey {
  pluginId: string
  triggerId: string
  capabilityId: string
  /** Stable string for the normalized scope (e.g. adapter.summarize or stableStringify). */
  scopeKey: string
}

export interface Budget {
  maxCalls: number
  period: "1m" | "1h" | "1d"
}

const PERIOD_MS: Record<Budget["period"], number> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
}

interface Window {
  windowStart: number
  count: number
}

function keyOf(k: BudgetKey): string {
  return `${k.pluginId}\0${k.triggerId}\0${k.capabilityId}\0${k.scopeKey}`
}

/** Pure fixed-window counter keyed by (plugin, trigger, capability, scope). */
export class BudgetLedger {
  private readonly windows = new Map<string, Window>()
  constructor(private readonly now: () => number = Date.now) {}

  private current(k: BudgetKey, budget: Budget): Window {
    const id = keyOf(k)
    const ms = PERIOD_MS[budget.period]
    const t = this.now()
    let w = this.windows.get(id)
    if (!w || t - w.windowStart >= ms) {
      w = { windowStart: t, count: 0 }
      this.windows.set(id, w)
    }
    return w
  }

  tryDebit(k: BudgetKey, budget: Budget): boolean {
    const w = this.current(k, budget)
    if (w.count >= budget.maxCalls) return false
    w.count += 1
    return true
  }

  usage(k: BudgetKey, budget: Budget): { used: number; max: number } {
    return { used: this.current(k, budget).count, max: budget.maxCalls }
  }

  /** Drop all counters for a plugin/trigger (teardown). */
  clear(pluginId: string, triggerId?: string): void {
    for (const id of this.windows.keys()) {
      const [p, t] = id.split("\0")
      if (p === pluginId && (triggerId === undefined || t === triggerId)) this.windows.delete(id)
    }
  }
}
