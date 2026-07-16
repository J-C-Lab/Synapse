import type { NormalizedCapability } from "@synapse/plugin-manifest"
import type { AiToolRegistry } from "../tool-registry"
import type { FrozenAuthoritySnapshotV1, FrozenPrincipalSnapshot } from "./authority-snapshot"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { freezeAuthoritySnapshot } from "./authority-snapshot"

/**
 * Rebuild the authority available to a recovering non-interactive run from
 * the live registry.  The checkpoint is used only as a *ceiling*: a restart
 * can never discover a newly-added tool, but a removed/changed live tool is
 * deliberately visible to the recovery classifier.
 */
export function rebuildRecoveryAuthority(
  checkpoint: AgentRunCheckpointV1,
  tools: AiToolRegistry,
  parent?: AgentRunCheckpointV1,
  currentCapabilities: readonly NormalizedCapability[] = [],
  currentPrincipal: FrozenPrincipalSnapshot = checkpoint.config.authority.principal,
  /** A child is constrained by its parent's live authority, not merely the
   * parent's creation-time snapshot. This is supplied by the startup
   * classifier after recursively deriving the parent from its real source. */
  parentCurrentAuthority?: FrozenAuthoritySnapshotV1
) {
  const frozenNames = new Set(checkpoint.config.authority.tools.map((tool) => tool.fqName))
  // A missing parent checkpoint is fail-closed for a child: no child tool is
  // recoverable without the parent authority that originally constrained it.
  const parentNames =
    checkpoint.identity.origin === "subagent"
      ? new Set(
          parentCurrentAuthority?.tools.map((tool) => tool.fqName) ??
            parent?.config.authority.tools.map((tool) => tool.fqName) ??
            []
        )
      : undefined
  return freezeAuthoritySnapshot({
    principal: currentPrincipal,
    capabilities: currentCapabilities,
    tools: tools
      .listWithDescriptors()
      .filter(
        ({ descriptor }) =>
          frozenNames.has(descriptor.fqName) && (!parentNames || parentNames.has(descriptor.fqName))
      )
      .map(({ schema, descriptor }) => ({
        descriptor,
        safeName: schema.name,
        modelSchema: schema,
      })),
  })
}
