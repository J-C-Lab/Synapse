/**
 * Per-run token budget caps for subagent inheritance (keyed by parent runId).
 *
 * @deprecated In-memory only — lost on restart and not checkpointed. Being
 * replaced by the durable, revisioned `RootBudgetLedgerStore`
 * (src/main/ai/budget/root-budget-ledger.ts) plus the idempotent
 * admit/settle/forfeit/release operations in
 * src/main/ai/budget/model-admission.ts. This registry stays wired for the
 * synchronous subagent's `.get()` budget lookup (read-only) until Task 15
 * migrates that caller; no new caller may write to it via `.set()`.
 */
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
