import { describe, expect, it } from "vitest"
import { RunBudgetRegistry } from "./run-budget-registry"

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
