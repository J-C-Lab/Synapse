import type { TriggerUse } from "@synapse/plugin-manifest"
import type { BackgroundInvoker } from "./background-invoker"
import type { BudgetBreakerPort, BudgetDebitOutcome } from "./capability-gate"
import type { BudgetLedger } from "./trigger-budget"
import type { TriggerRegistry } from "./trigger-registry"
import type { PluginManifest } from "./types"
import { getCapability, stableStringify } from "@synapse/plugin-manifest"

/** Stable scope bucket for a trigger `uses` entry — shared by debit and panel. */
export function scopeKeyForUse(use: TriggerUse): string {
  if (use.scope === undefined) return ""
  const adapter = getCapability(use.capability)?.scopeAdapter
  if (adapter) return adapter.summarize(adapter.canonicalize(use.scope))
  return stableStringify(use.scope)
}

export function createBudgetBreakerPort(deps: {
  invoker: BackgroundInvoker
  ledger: BudgetLedger
  manifestFor: (pluginId: string) => PluginManifest | undefined
  registry: Pick<TriggerRegistry, "getDeclaration">
}): BudgetBreakerPort {
  return {
    isTriggerOrigin: (id) => deps.invoker.isTriggerOrigin(id),
    tryDebit: (request): BudgetDebitOutcome => {
      const rec = request.invocationId ? deps.invoker.get(request.invocationId) : undefined
      if (!rec) return "exhausted"
      const decl =
        deps.registry.getDeclaration(rec.pluginId, rec.triggerId) ??
        deps.manifestFor(rec.pluginId)?.triggers?.find((t) => t.id === rec.triggerId)
      const uses = rec.allowedUses ?? decl?.uses ?? []
      const use = uses.find((u) => u.capability === request.capability)
      if (!use) return "not-in-uses"
      const ok = deps.ledger.tryDebit(
        {
          pluginId: rec.pluginId,
          triggerId: rec.triggerId,
          workspaceId: rec.actor === "background-agent" ? rec.workspaceId : undefined,
          capabilityId: request.capability,
          scopeKey: scopeKeyForUse(use),
        },
        use.budget
      )
      return ok ? "debited" : "exhausted"
    },
  }
}
