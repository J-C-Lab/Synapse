import { describe, expect, it } from "vitest"
import { BudgetLedger } from "./trigger-budget"

const key = {
  pluginId: "p",
  triggerId: "t",
  capabilityId: "network:https",
  scopeKey: "api.example.com",
}

describe("budgetLedger", () => {
  it("debits up to maxCalls then refuses within the period", () => {
    const ledger = new BudgetLedger(() => 0)
    const budget = { maxCalls: 2, period: "1h" as const }
    expect(ledger.tryDebit(key, budget)).toBe(true)
    expect(ledger.tryDebit(key, budget)).toBe(true)
    expect(ledger.tryDebit(key, budget)).toBe(false)
  })

  it("isolates budgets across capabilities (no cross-drain)", () => {
    const ledger = new BudgetLedger(() => 0)
    const net = { ...key, capabilityId: "network:https" }
    const notif = { ...key, capabilityId: "notification" }
    const budget = { maxCalls: 1, period: "1h" as const }
    expect(ledger.tryDebit(net, budget)).toBe(true)
    expect(ledger.tryDebit(net, budget)).toBe(false)
    expect(ledger.tryDebit(notif, budget)).toBe(true)
  })

  it("resets after the period elapses", () => {
    let now = 0
    const ledger = new BudgetLedger(() => now)
    const budget = { maxCalls: 1, period: "1h" as const }
    expect(ledger.tryDebit(key, budget)).toBe(true)
    expect(ledger.tryDebit(key, budget)).toBe(false)
    now += 60 * 60 * 1000 + 1
    expect(ledger.tryDebit(key, budget)).toBe(true)
  })

  it("reports usage for the observability panel", () => {
    const ledger = new BudgetLedger(() => 0)
    const budget = { maxCalls: 5, period: "1h" as const }
    ledger.tryDebit(key, budget)
    expect(ledger.usage(key, budget)).toEqual({ used: 1, max: 5 })
  })
})
