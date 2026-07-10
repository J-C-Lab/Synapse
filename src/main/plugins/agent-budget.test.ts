import { describe, expect, it } from "vitest"
import { AgentBudgetLedger } from "./agent-budget"

const budget = {
  maxRuns: 1,
  period: "1d" as const,
  maxToolCallsPerRun: 2,
  maxTokensPerRun: 100,
  timeoutMs: 1000,
}

describe("agentBudgetLedger", () => {
  it("limits background-agent runs per plugin and trigger window", () => {
    const ledger = new AgentBudgetLedger(() => 0)
    const first = ledger.tryStart(
      { pluginId: "p", triggerId: "downloads", workspaceId: "work" },
      budget
    )
    expect(first).toMatchObject({ ok: true, runId: expect.any(String) })

    expect(
      ledger.tryStart({ pluginId: "p", triggerId: "downloads", workspaceId: "work" }, budget)
    ).toEqual({
      ok: false,
      why: "runs-exhausted",
    })
  })

  it("tracks tool calls and tokens per run", () => {
    const ledger = new AgentBudgetLedger(() => 0)
    const started = ledger.tryStart(
      { pluginId: "p", triggerId: "downloads", workspaceId: "work" },
      budget
    )
    if (!started.ok) throw new Error("expected run to start")

    expect(ledger.tryDebitToolCall(started.runId, budget)).toBe(true)
    expect(ledger.tryDebitToolCall(started.runId, budget)).toBe(true)
    expect(ledger.tryDebitToolCall(started.runId, budget)).toBe(false)

    expect(ledger.tryDebitTokens(started.runId, budget, 60)).toBe(true)
    expect(ledger.tryDebitTokens(started.runId, budget, 41)).toBe(false)
  })

  it("resets the run window after the configured period", () => {
    let now = 0
    const ledger = new AgentBudgetLedger(() => now)
    expect(
      ledger.tryStart({ pluginId: "p", triggerId: "downloads", workspaceId: "work" }, budget).ok
    ).toBe(true)
    now = 86_400_000
    expect(
      ledger.tryStart({ pluginId: "p", triggerId: "downloads", workspaceId: "work" }, budget).ok
    ).toBe(true)
  })

  it("two workspaces of the same trigger have independent run budgets", () => {
    const ledger = new AgentBudgetLedger()
    const budget = {
      maxRuns: 1,
      period: "1h" as const,
      maxToolCallsPerRun: 5,
      maxTokensPerRun: 1000,
      timeoutMs: 5000,
    }

    const work = ledger.tryStart({ pluginId: "p", triggerId: "t", workspaceId: "work" }, budget)
    expect(work.ok).toBe(true)
    const workAgain = ledger.tryStart(
      { pluginId: "p", triggerId: "t", workspaceId: "work" },
      budget
    )
    expect(workAgain.ok).toBe(false)

    const personal = ledger.tryStart(
      { pluginId: "p", triggerId: "t", workspaceId: "personal" },
      budget
    )
    expect(personal.ok).toBe(true)
  })
})
