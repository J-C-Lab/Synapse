/** Per-run token budget caps for subagent inheritance (keyed by parent runId). */
export class RunBudgetRegistry {
  private readonly budgets = new Map<string, number | undefined>()

  set(runId: string, budgetTokens: number | undefined): void {
    this.budgets.set(runId, budgetTokens)
  }

  get(runId: string): number | undefined {
    return this.budgets.get(runId)
  }

  clear(runId: string): void {
    this.budgets.delete(runId)
  }
}
