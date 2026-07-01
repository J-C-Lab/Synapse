import type { PlanStep } from "./plan-types"

// The agent's declared plan for a single active run, keyed by runId. In-memory
// only — the durable record is RunTrace.plan (written at run end). Cleared when
// the run finishes.
export class RunPlanRegistry {
  private readonly byRun = new Map<string, PlanStep[]>()

  set(runId: string, steps: PlanStep[]): void {
    this.byRun.set(runId, steps)
  }

  get(runId: string): PlanStep[] | undefined {
    return this.byRun.get(runId)
  }

  clear(runId: string): void {
    this.byRun.delete(runId)
  }
}
