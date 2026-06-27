import type { AgentTriggerBudget } from "@synapse/plugin-manifest"
import { randomUUID } from "node:crypto"

export interface AgentBudgetKey {
  pluginId: string
  triggerId: string
}

export type AgentRunStart = { ok: true; runId: string } | { ok: false; why: "runs-exhausted" }

const PERIOD_MS: Record<AgentTriggerBudget["period"], number> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
}

interface RunWindow {
  windowStart: number
  count: number
}

interface RunUsage {
  toolCalls: number
  tokens: number
}

export class AgentBudgetLedger {
  private readonly windows = new Map<string, RunWindow>()
  private readonly runs = new Map<string, RunUsage>()

  constructor(private readonly now: () => number = Date.now) {}

  tryStart(key: AgentBudgetKey, budget: AgentTriggerBudget): AgentRunStart {
    const window = this.currentWindow(key, budget)
    if (window.count >= budget.maxRuns) return { ok: false, why: "runs-exhausted" }
    window.count += 1
    const runId = randomUUID()
    this.runs.set(runId, { toolCalls: 0, tokens: 0 })
    return { ok: true, runId }
  }

  tryDebitToolCall(runId: string, budget: AgentTriggerBudget): boolean {
    const run = this.runs.get(runId)
    if (!run) return false
    if (run.toolCalls >= budget.maxToolCallsPerRun) return false
    run.toolCalls += 1
    return true
  }

  tryDebitTokens(runId: string, budget: AgentTriggerBudget, tokens: number): boolean {
    const run = this.runs.get(runId)
    if (!run) return false
    if (run.tokens + tokens > budget.maxTokensPerRun) return false
    run.tokens += tokens
    return true
  }

  finish(runId: string): void {
    this.runs.delete(runId)
  }

  clear(pluginId: string, triggerId?: string): void {
    for (const id of this.windows.keys()) {
      const [p, t] = id.split("\0")
      if (p === pluginId && (triggerId === undefined || t === triggerId)) this.windows.delete(id)
    }
  }

  private currentWindow(key: AgentBudgetKey, budget: AgentTriggerBudget): RunWindow {
    const id = `${key.pluginId}\0${key.triggerId}`
    const ms = PERIOD_MS[budget.period]
    const time = this.now()
    let window = this.windows.get(id)
    if (!window || time - window.windowStart >= ms) {
      window = { windowStart: time, count: 0 }
      this.windows.set(id, window)
    }
    return window
  }
}
