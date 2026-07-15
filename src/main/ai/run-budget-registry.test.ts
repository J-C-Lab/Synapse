import { describe, expect, it } from "vitest"
import { RunBudgetRegistry } from "./run-budget-registry"

// This registry is deprecated in favor of RootBudgetLedgerStore
// (src/main/ai/budget/root-budget-ledger.test.ts covers the durable
// replacement). Kept green only because the synchronous subagent's
// read-only `.get()` lookup still depends on it until Task 15.
describe("runBudgetRegistry", () => {
  it("stores and clears per-run budgets", () => {
    const registry = new RunBudgetRegistry()
    registry.set("run-a", 5000)
    registry.set("run-b", undefined)
    expect(registry.get("run-a")).toBe(5000)
    expect(registry.get("run-b")).toBeUndefined()
    expect(registry.get("missing")).toBeUndefined()
    registry.clear("run-a")
    expect(registry.get("run-a")).toBeUndefined()
  })
})
