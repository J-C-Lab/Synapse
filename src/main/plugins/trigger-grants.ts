import type { TriggerDeclaration } from "@synapse/plugin-manifest"
import type { GrantIdentity, GrantStore } from "./grant-store"
import { getCapability, triggerUseToCapability } from "@synapse/plugin-manifest"

/** Standing grants for every non-auto capability listed in trigger `uses`. */
export async function grantTriggerUses(
  grants: Pick<GrantStore, "isGranted" | "grant">,
  identity: GrantIdentity,
  triggers: readonly TriggerDeclaration[] | undefined
): Promise<void> {
  if (!triggers?.length) return

  for (const use of triggers.flatMap((t) => t.uses)) {
    const cap = getCapability(use.capability)
    if (!cap || cap.tier === "auto") continue
    const normalized = triggerUseToCapability(use)
    if (await grants.isGranted(identity, normalized.id, normalized.scope)) continue
    await grants.grant(identity, normalized.id, "user", normalized.scope)
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
