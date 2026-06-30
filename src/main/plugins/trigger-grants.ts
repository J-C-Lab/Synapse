import type { TriggerDeclaration } from "@synapse/plugin-manifest"
import type { GrantIdentity, GrantRecord, GrantStore } from "./grant-store"
import {
  declaredCredentialBrokerScopeContains,
  declaredNetworkScopeContains,
  getCapability,
  stableStringify,
  triggerUseToCapability,
} from "@synapse/plugin-manifest"

function declaredGrantCoversUse(
  capabilityId: string,
  grantScope: unknown,
  useScope: unknown
): boolean {
  if (useScope === undefined) return true
  if (grantScope === undefined) return false
  if (capabilityId === "network:https") {
    return declaredNetworkScopeContains(grantScope, useScope)
  }
  if (capabilityId === "credentials:broker") {
    return declaredCredentialBrokerScopeContains(grantScope, useScope)
  }
  const cap = getCapability(capabilityId)
  if (!cap?.scopeAdapter) return false
  return (
    stableStringify(cap.scopeAdapter.canonicalize(grantScope)) ===
    stableStringify(cap.scopeAdapter.canonicalize(useScope))
  )
}

function existingGrantCoversUse(
  records: readonly GrantRecord[],
  capabilityId: string,
  useScope: unknown
): boolean {
  const existing = records.find((r) => r.capabilityId === capabilityId)
  if (!existing) return false
  return declaredGrantCoversUse(capabilityId, existing.grantScope, useScope)
}

/** Standing grants for every non-auto capability listed in trigger `uses`. */
export async function grantTriggerUses(
  grants: Pick<GrantStore, "isGranted" | "grant" | "list">,
  identity: GrantIdentity,
  triggers: readonly TriggerDeclaration[] | undefined
): Promise<void> {
  if (!triggers?.length) return

  let existingGrants = await grants.list(identity)

  for (const use of triggers.flatMap((t) => t.uses)) {
    const cap = getCapability(use.capability)
    if (!cap || cap.tier === "auto") continue
    const normalized = triggerUseToCapability(use)
    if (await grants.isGranted(identity, normalized.id, normalized.scope)) continue
    if (existingGrantCoversUse(existingGrants, normalized.id, normalized.scope)) continue
    await grants.grant(identity, normalized.id, "user", normalized.scope)
    existingGrants = await grants.list(identity)
  }

  for (const trigger of triggers) {
    if (trigger.type === "fs.watch") {
      const scope = { paths: trigger.scope.paths }
      if (await grants.isGranted(identity, "fs:watch")) continue
      await grants.grant(identity, "fs:watch", "user", scope)
    }
    if (trigger.type === "hotkey") {
      const scope = { accelerator: trigger.scope.accelerator }
      if (await grants.isGranted(identity, "hotkey:global", scope)) continue
      await grants.grant(identity, "hotkey:global", "user", scope)
    }
  }
}

/** Revoke standing grants for trigger `uses` when a plugin is disabled (spec §2). */
export async function revokeTriggerUses(
  grants: Pick<GrantStore, "revoke">,
  identity: GrantIdentity,
  triggers: readonly TriggerDeclaration[] | undefined
): Promise<void> {
  if (!triggers?.length) return

  const seen = new Set<string>()
  for (const trigger of triggers) {
    if (trigger.type === "fs.watch") seen.add("fs:watch")
    if (trigger.type === "hotkey") seen.add("hotkey:global")
    for (const use of trigger.uses) seen.add(use.capability)
  }
  for (const capabilityId of seen) {
    const cap = getCapability(capabilityId)
    if (!cap || cap.tier === "auto") continue
    await grants.revoke(identity, capabilityId, "user")
  }
}
