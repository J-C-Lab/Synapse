import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredTool, RegisteredToolDescriptor, ToolInvocationOptions } from "./types"
import { validateToolInput } from "./tool-input-validation"

/**
 * Thrown when a tool call's input fails validation against the manifest
 * `inputSchema`, before the plugin handler runs. Carries the per-field issues
 * so an agent/UI can explain (or self-correct) the bad call.
 */
export class ToolInputValidationError extends Error {
  readonly fqName: string
  readonly issues: string[]

  constructor(fqName: string, issues: string[]) {
    super(`Invalid input for tool ${fqName}: ${issues.join("; ")}`)
    this.name = "ToolInputValidationError"
    this.fqName = fqName
    this.issues = issues
  }
}

/**
 * The slice of the registry the tool bridge depends on. Keeping it a narrow
 * port (rather than the whole `PluginRegistry`) keeps the bridge unit-testable
 * with a tiny fake.
 */
export interface ToolRegistryPort {
  listTools: () => RegisteredToolDescriptor[]
  invokeTool: (
    pluginId: string,
    toolName: string,
    input: unknown,
    options: ToolInvocationOptions
  ) => Promise<ToolResult>
}

export interface PluginToolBridgeOptions {
  registry: ToolRegistryPort
}

/**
 * Turns the registry's plugin tools into programmatically-callable
 * {@link RegisteredTool}s. This is the host-side seam the AI layer (P2
 * AgentRuntime, P4 MCP server) calls: it validates input against the manifest
 * `inputSchema`, then delegates execution to the sandbox via the registry.
 */
export class PluginToolBridge {
  constructor(private readonly options: PluginToolBridgeOptions) {}

  /** All tools contributed by active plugins, each with a bound runner. */
  list(): RegisteredTool[] {
    return this.options.registry.listTools().map((descriptor) => this.toRegisteredTool(descriptor))
  }

  get(fqName: string): RegisteredTool | undefined {
    const descriptor = this.options.registry.listTools().find((tool) => tool.fqName === fqName)
    return descriptor ? this.toRegisteredTool(descriptor) : undefined
  }

  async invoke(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const tool = this.get(fqName)
    if (!tool) throw new Error(`Tool not found: ${fqName}`)
    return tool.run(input, options)
  }

  private toRegisteredTool(descriptor: RegisteredToolDescriptor): RegisteredTool {
    return {
      ...descriptor,
      run: (input, options) => this.run(descriptor, input, options),
    }
  }

  private async run(
    descriptor: RegisteredToolDescriptor,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const issues = validateToolInput(descriptor.manifestTool.inputSchema, input)
    if (issues.length > 0) throw new ToolInputValidationError(descriptor.fqName, issues)

    return this.options.registry.invokeTool(
      descriptor.pluginId,
      descriptor.manifestTool.name,
      input,
      options
    )
  }
}
