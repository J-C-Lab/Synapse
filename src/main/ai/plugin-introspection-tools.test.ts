import type { PluginCapabilityProfile } from "@synapse/plugin-manifest"
import { describe, expect, it } from "vitest"
import {
  PLUGIN_INTROSPECT_PREFIX,
  PluginIntrospectionToolSource,
} from "./plugin-introspection-tools"

const profile: PluginCapabilityProfile = {
  riskLevel: "high",
  surfaces: {
    cloudAccess: true,
    credentials: true,
    remoteWriteback: true,
    background: true,
    localFileRead: false,
    localFileWrite: false,
    osIntegration: false,
    agentCallable: true,
  },
  summaries: [],
  warnings: [],
  controls: ["revoke", "audit"],
}

describe("pluginIntrospectionToolSource", () => {
  it("owns its namespace and lists describe_plugin", () => {
    const source = new PluginIntrospectionToolSource(async () => profile)
    expect(source.ownsTool(`${PLUGIN_INTROSPECT_PREFIX}describe_plugin`)).toBe(true)
    expect(source.ownsTool("com.x/y")).toBe(false)
    expect(source.listTools().map((tool) => tool.manifestTool.name)).toEqual(["describe_plugin"])
  })

  it("returns the resolved profile as json", async () => {
    const source = new PluginIntrospectionToolSource(async () => profile)
    const result = await source.invokeTool(`${PLUGIN_INTROSPECT_PREFIX}describe_plugin`, {
      pluginId: "com.synapse.github-inbox",
    })
    expect(result.structured).toMatchObject({ riskLevel: "high" })
  })

  it("errors when the plugin is unknown", async () => {
    const source = new PluginIntrospectionToolSource(async () => undefined)
    const result = await source.invokeTool(`${PLUGIN_INTROSPECT_PREFIX}describe_plugin`, {
      pluginId: "nope",
    })
    expect(result.isError).toBe(true)
  })
})
