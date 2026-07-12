import type { ToolResult } from "@synapse/plugin-sdk"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ToolHostSource } from "./composite-tool-host"

export interface BackgroundHostToolAuthorizer {
  ensure: (request: CapabilityRequest) => Promise<void>
  /** A pure read (no audit, no budget debit) — which of the given candidate
   *  capability ids are currently granted for this plugin's identity. */
  confirmedCapabilities: (candidateIds: readonly string[]) => Promise<Set<string>>
}

export interface GovernedBackgroundToolHostOptions {
  authorizer: BackgroundHostToolAuthorizer
  sources: ToolHostSource[]
  /** Resolved once, before construction, via authorizer.confirmedCapabilities() —
   *  ToolHostPort.listTools() is synchronous, so an async grant check cannot
   *  live inside listTools() itself. */
  confirmed: ReadonlySet<string>
}

/** Routes memory:read/execution:read host tool calls through the real
 *  CapabilityGate a plugin's own sandboxed capability calls already go
 *  through (via PluginBridge.createBackgroundHostToolAuthorizer()) — grant
 *  check, uses[] budget debit, and audit entry, all from the one real
 *  mechanism. listTools() additionally filters by `confirmed` so a
 *  declared-but-unconfirmed tool is hidden from the model entirely, not
 *  listed-then-denied on every call. */
export class GovernedBackgroundToolHost implements ToolHostSource {
  constructor(private readonly options: GovernedBackgroundToolHostOptions) {
    for (const source of options.sources) {
      for (const descriptor of source.listTools()) {
        capabilityIdFor(descriptor)
      }
    }
  }

  ownsTool(fqName: string): boolean {
    return this.options.sources.some((source) => source.ownsTool(fqName))
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.options.sources
      .flatMap((source) => source.listTools())
      .filter((descriptor) => this.options.confirmed.has(capabilityIdFor(descriptor)))
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const source = this.options.sources.find((candidate) => candidate.ownsTool(fqName))
    if (!source) throw new Error(`No tool source owns: ${fqName}`)
    const descriptor = source.listTools().find((candidate) => candidate.fqName === fqName)
    const capability = descriptor ? capabilityIdFor(descriptor) : fqName
    const toolName = fqName.split("/").at(-1) ?? fqName

    await this.options.authorizer.ensure({
      capability,
      invocation: {
        source: "tool",
        caller: options.caller,
        trigger: `tool:${fqName}`,
        signal: options.signal,
      },
      operation: toolName,
      signal: options.signal,
    })

    return source.invokeTool(fqName, input, options)
  }
}

function capabilityIdFor(descriptor: RegisteredToolDescriptor): string {
  const capabilities = descriptor.manifestTool.capabilities ?? []
  if (capabilities.length !== 1) {
    throw new Error(
      `GovernedBackgroundToolHost: ${descriptor.fqName} must declare exactly one capability, got ${capabilities.length}`
    )
  }
  return capabilities[0]!.id
}
