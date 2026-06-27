import type { ToolCaller } from "@synapse/plugin-sdk"
import type { CapabilityApprover, CapabilityAuditEntry, GrantPromptPort } from "./capability-gate"
import type { GrantIdentity } from "./grant-store"
import type { PluginManifest, PluginSourceKind } from "./types"
import { createHash } from "node:crypto"
import * as path from "node:path"
import {
  capabilityDeclarationHash,
  credentialDeclarationHash,
  triggerDeclarationHash,
} from "@synapse/plugin-manifest"
import { createFileSink } from "../logging/file-sink"
import { createCapabilityAudit } from "./capability-audit"
import { GrantStore, grantStoreFilePath } from "./grant-store"

export interface CapabilityGovernance {
  grants: Pick<GrantStore, "isGranted" | "grant">
  prompt: GrantPromptPort
  approve: CapabilityApprover
  audit: (entry: CapabilityAuditEntry) => void
}

export function buildGrantIdentity(
  pluginId: string,
  manifest: PluginManifest,
  sourceKind: PluginSourceKind
): GrantIdentity {
  const capHash = capabilityDeclarationHash(manifest.capabilities)
  const trigHash = triggerDeclarationHash(manifest.triggers ?? [])
  const credHash = credentialDeclarationHash(manifest.contributes.credentials ?? [])
  const declarationHash = createHash("sha256")
    .update(`${capHash}\n${trigHash}\n${credHash}`)
    .digest("hex")
    .slice(0, 16)
  return {
    pluginId,
    publisherId: "unsigned",
    signingKeyFingerprint: `local:${sourceKind}`,
    capabilityDeclarationHash: declarationHash,
  }
}

/** Maps tool invocation origin to the capability actor used by `ensure()`. */
export function callerToActor(
  caller: ToolCaller
): "user" | "agent" | "background" | "background-agent" {
  if (caller.kind === "user") return "user"
  if (caller.kind === "background-agent") return "background-agent"
  return "agent"
}

export interface CreateCapabilityGovernanceOptions {
  userDataDir: string
  grants?: GrantStore
  prompt?: GrantPromptPort
  approve?: CapabilityApprover
  audit?: (entry: CapabilityAuditEntry) => void
}

/**
 * Production defaults for the governance container. JIT prompt and per-call
 * approver auto-allow until the IPC round-trip (T9) and management UI (T10)
 * land; grants still persist through {@link GrantStore} once written.
 */
export function createCapabilityGovernance(
  options: CreateCapabilityGovernanceOptions
): CapabilityGovernance {
  const grants = options.grants ?? new GrantStore(grantStoreFilePath(options.userDataDir))
  const audit =
    options.audit ??
    createCapabilityAudit(
      createFileSink(path.join(options.userDataDir, "logs"), { fileName: "audit.log" })
    )
  const prompt = options.prompt ?? (async () => true)
  const approve = options.approve ?? (async () => true)
  return { grants, prompt, approve, audit }
}
