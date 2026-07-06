import type { PlanStep } from "./plan-types"
import { describe, expect, it } from "vitest"
import { PLAN_FQ_PREFIX, PlanToolSource, UPDATE_PLAN_FQ } from "./plan-tool-source"
import { RunPlanRegistry } from "./run-plan-registry"

function caller(runId = "r1") {
  return { kind: "agent" as const, conversationId: "c1", runId }
}

function source() {
  const registry = new RunPlanRegistry()
  const emitted: { runId: string; steps: PlanStep[] }[] = []
  const src = new PlanToolSource({
    registry,
    emitPlan: (runId, steps) => emitted.push({ runId, steps }),
  })
  return { src, registry, emitted }
}

describe("planToolSource", () => {
  it("lists a read-only update_plan descriptor", () => {
    const { src } = source()
    const [desc] = src.listTools()
    expect(desc.fqName).toBe(UPDATE_PLAN_FQ)
    expect(desc.manifestTool.annotations?.readOnlyHint).toBe(true)
  })

  it("owns only plan-prefixed tools", () => {
    const { src } = source()
    expect(src.ownsTool(UPDATE_PLAN_FQ)).toBe(true)
    expect(src.ownsTool("execution:core/run_command")).toBe(false)
    expect(PLAN_FQ_PREFIX).toBe("plan:")
  })

  it("stores, emits, and acks a valid plan", async () => {
    const { src, registry, emitted } = source()
    const result = await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [{ title: "A", status: "in_progress" }, { title: "B" }] },
      { caller: caller(), signal: new AbortController().signal }
    )
    expect(registry.get("r1")).toEqual([
      { title: "A", status: "in_progress" },
      { title: "B", status: "pending" },
    ])
    expect(emitted).toEqual([{ runId: "r1", steps: registry.get("r1") }])
    expect(result.isError ?? false).toBe(false)
    expect(result.structured).toMatchObject({ ok: true, count: 2 })
  })

  it("emits an empty plan when steps is []", async () => {
    const { src, emitted } = source()
    await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [] },
      { caller: caller(), signal: new AbortController().signal }
    )
    expect(emitted[0].steps).toEqual([])
  })

  it("returns isError on malformed input without emitting", async () => {
    const { src, emitted } = source()
    const result = await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [{ notATitle: 1 }] },
      { caller: caller(), signal: new AbortController().signal }
    )
    expect(result.isError).toBe(true)
    expect(emitted).toHaveLength(0)
  })

  it("errors when the caller has no runId", async () => {
    const { src } = source()
    const result = await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [{ title: "A" }] },
      { caller: { kind: "agent", conversationId: "c1" }, signal: new AbortController().signal }
    )
    expect(result.isError).toBe(true)
  })

  it("still stores + acks when emitPlan throws (UI push is best-effort)", async () => {
    const registry = new RunPlanRegistry()
    const src = new PlanToolSource({
      registry,
      emitPlan: () => {
        throw new Error("renderer gone")
      },
    })
    const result = await src.invokeTool(
      UPDATE_PLAN_FQ,
      { steps: [{ title: "A" }] },
      { caller: caller(), signal: new AbortController().signal }
    )
    expect(result.isError ?? false).toBe(false)
    expect(registry.get("r1")).toEqual([{ title: "A", status: "pending" }])
  })
})
