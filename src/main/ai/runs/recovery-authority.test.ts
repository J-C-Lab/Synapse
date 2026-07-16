import type { ToolHostPort } from "../tool-registry"
import type { AgentRunCheckpointV1 } from "./checkpoint-schema"
import { describe, expect, it } from "vitest"
import { AiToolRegistry } from "../tool-registry"
import { freezeAuthoritySnapshot } from "./authority-snapshot"
import { rebuildRecoveryAuthority } from "./recovery-authority"

function host(): ToolHostPort {
  return {
    listTools: () =>
      ["read", "write"].map((name) => ({
        fqName: `plugin.test/${name}`,
        pluginId: "plugin.test",
        provenance: "plugin" as const,
        manifestTool: { name, description: "", inputSchema: { type: "object" } },
      })),
    invokeTool: async () => ({ content: [] }),
  }
}

function snapshot(registry: AiToolRegistry, names: readonly string[]) {
  return freezeAuthoritySnapshot({
    principal: { kind: "subagent", actor: "background" },
    capabilities: [],
    tools: registry
      .listWithDescriptors()
      .filter(({ descriptor }) => names.includes(descriptor.fqName))
      .map(({ descriptor, schema }) => ({
        descriptor,
        safeName: schema.name,
        modelSchema: schema,
      })),
  })
}

describe("rebuildRecoveryAuthority", () => {
  it("constrains a recovering child by its parent's current tools, not the parent's frozen tools", () => {
    const registry = new AiToolRegistry(host())
    const child = {
      identity: { origin: "subagent" },
      config: { authority: snapshot(registry, ["plugin.test/read", "plugin.test/write"]) },
    } as AgentRunCheckpointV1
    const parentAtCreation = {
      identity: { origin: "interactive" },
      config: { authority: snapshot(registry, ["plugin.test/read", "plugin.test/write"]) },
    } as AgentRunCheckpointV1
    const parentNow = snapshot(registry, ["plugin.test/read"])

    const current = rebuildRecoveryAuthority(
      child,
      registry,
      parentAtCreation,
      [],
      child.config.authority.principal,
      parentNow
    )

    expect(current.tools.map((tool) => tool.fqName)).toEqual(["plugin.test/read"])
  })
})
