import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ToolHostPort } from "./tool-registry"

// Aggregates several tool sources behind the single ToolHostPort the
// AiToolRegistry consumes. P5 brings in external MCP servers alongside local
// plugin tools: the plugin host and the MCP client manager are both sources,
// merged here so the model sees one flat tool list. Invocations route back to
// the source that owns the fqName (plugins use `<pluginId>/<tool>`, external
// MCP tools use the `mcp:<serverId>/<tool>` namespace).

/** A tool source that can also claim ownership of an fqName for routing. */
export interface ToolHostSource extends ToolHostPort {
  /** True when this source produced (and can invoke) the given fqName. */
  ownsTool: (fqName: string) => boolean
}

export class CompositeToolHost implements ToolHostPort {
  constructor(private readonly sources: ToolHostSource[]) {}

  listTools(): RegisteredToolDescriptor[] {
    return this.sources.flatMap((source) => source.listTools())
  }

  invokeTool(fqName: string, input: unknown, options: ToolInvocationOptions): Promise<ToolResult> {
    const source = this.sources.find((candidate) => candidate.ownsTool(fqName))
    if (!source) throw new Error(`No tool source owns: ${fqName}`)
    return source.invokeTool(fqName, input, options)
  }
}

/**
 * Adapt a bare {@link ToolHostPort} (the plugin host) into a {@link ToolHostSource}
 * by tagging it as the owner of every fqName a sibling source does not claim.
 * Pass the sibling predicates that *should* win; everything else falls here.
 */
export function asFallbackSource(
  host: ToolHostPort,
  claimedBy: (fqName: string) => boolean
): ToolHostSource {
  return {
    listTools: () => host.listTools(),
    invokeTool: (fqName, input, options) => host.invokeTool(fqName, input, options),
    ownsTool: (fqName) => !claimedBy(fqName),
  }
}
