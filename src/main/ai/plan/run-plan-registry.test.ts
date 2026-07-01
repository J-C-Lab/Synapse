import { describe, expect, it } from "vitest"
import { RunPlanRegistry } from "./run-plan-registry"

describe("runPlanRegistry", () => {
  it("stores and reads a plan by runId", () => {
    const reg = new RunPlanRegistry()
    reg.set("r1", [{ title: "A", status: "pending" }])
    expect(reg.get("r1")).toEqual([{ title: "A", status: "pending" }])
  })

  it("overwrites on repeated set (full-replace semantics)", () => {
    const reg = new RunPlanRegistry()
    reg.set("r1", [{ title: "A", status: "pending" }])
    reg.set("r1", [
      { title: "A", status: "completed" },
      { title: "B", status: "pending" },
    ])
    expect(reg.get("r1")).toHaveLength(2)
    expect(reg.get("r1")?.[0].status).toBe("completed")
  })

  it("returns undefined after clear", () => {
    const reg = new RunPlanRegistry()
    reg.set("r1", [{ title: "A", status: "pending" }])
    reg.clear("r1")
    expect(reg.get("r1")).toBeUndefined()
  })

  it("isolates plans across runIds", () => {
    const reg = new RunPlanRegistry()
    reg.set("r1", [{ title: "A", status: "pending" }])
    reg.set("r2", [{ title: "B", status: "pending" }])
    expect(reg.get("r1")?.[0].title).toBe("A")
    expect(reg.get("r2")?.[0].title).toBe("B")
  })
})
