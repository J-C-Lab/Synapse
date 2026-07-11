import type { PluginCapabilityProfile } from "@synapse/plugin-manifest"
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor } from "../plugins/types"
import type { ToolHostSource } from "./composite-tool-host"

// Built-in introspection tool exposed to the agent as a ToolHostSource. Lets the
// model pull a plugin's full capability profile (risk, surfaces, controls) to
// decide whether/how to use it — the agent half of the capability profile work.

export const PLUGIN_INTROSPECT_PREFIX = "synapse:introspect/"
const INTROSPECT_PLUGIN_ID = "synapse:introspect"

/** Resolve a plugin's profile (grant-aware) by id, or undefined if unknown. */
export type ProfileResolver = (pluginId: string) => Promise<PluginCapabilityProfile | undefined>

const TOOLS: RegisteredToolDescriptor[] = [
  {
    fqName: `${INTROSPECT_PLUGIN_ID}/describe_plugin`,
    pluginId: INTROSPECT_PLUGIN_ID,
    provenance: "host",
    manifestTool: {
      name: "describe_plugin",
      title: "Describe plugin",
      description:
        "Return the capability profile of an installed plugin: risk level, what it touches (cloud, credentials, remote writeback, background, local files), and how it is governed (revoke, approval-required, audit). Call before using an unfamiliar plugin's tools to understand its risk and approval boundaries.",
      inputSchema: {
        type: "object",
        properties: { pluginId: { type: "string", description: "The plugin id to describe." } },
        required: ["pluginId"],
      },
      annotations: { readOnlyHint: true },
    },
  },
]

export class PluginIntrospectionToolSource implements ToolHostSource {
  constructor(private readonly resolveProfile: ProfileResolver) {}

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(PLUGIN_INTROSPECT_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return TOOLS
  }

  async invokeTool(fqName: string, input: unknown): Promise<ToolResult> {
    if (fqName !== `${INTROSPECT_PLUGIN_ID}/describe_plugin`) {
      return errorResult(`Unknown tool: ${fqName}`)
    }
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
    if (typeof args.pluginId !== "string" || !args.pluginId.trim()) {
      return errorResult("pluginId is required.")
    }
    try {
      const profile = await this.resolveProfile(args.pluginId.trim())
      if (!profile) return errorResult(`Plugin not found: ${args.pluginId}`)
      return { content: [{ type: "json", json: profile }], structured: profile }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}
