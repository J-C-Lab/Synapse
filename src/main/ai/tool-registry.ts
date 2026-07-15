import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ProviderToolSchema } from "./providers/types"
import type { InvocationRecoveryAdapter } from "./tools/invocation-recovery"
import { createHash } from "node:crypto"
import { logger } from "../logging"
import { projectModelVisibleTool, warnOnce } from "./guardrails/tool-metadata"
import { frozenProvenance } from "./runs/authority-snapshot"
import { noneRecoveryAdapter } from "./tools/invocation-recovery"

// Bridges the plugin tool surface to what a model can call. Plugin fqNames look
// like `com.example.hello-world/greet`, which contain `.` and `/` and so fail
// the Anthropic/OpenAI tool-name charset (`^[a-zA-Z0-9_-]{1,128}$`). Host tools
// keep sanitized readable names; third-party tools receive opaque aliases. The
// reverse map routes all model calls back to the real fqName without putting an
// alias table in plugin manifests.

/** The slice of PluginHost the AI tool registry depends on. */
export interface ToolHostPort {
  listTools: () => RegisteredToolDescriptor[]
  invokeTool: (
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ) => Promise<ToolResult>
}

export class AiToolRegistry {
  private safeToDescriptor = new Map<string, RegisteredToolDescriptor>()
  private exclusionWarnings = new Map<string, string>()

  constructor(
    private readonly host: ToolHostPort,
    /** 可选：返回某插件的 agent 可读能力 note，前置到该插件每个工具的描述。 */
    private readonly pluginNote?: (pluginId: string) => string | undefined
  ) {}

  /** Current tools as model-facing schemas. Rebuilds the reverse map. */
  list(): ProviderToolSchema[] {
    return this.listWithDescriptors().map(({ schema }) => schema)
  }

  /** Same as {@link list}, paired with the descriptor each schema came from —
   *  what run-authority freezing (see runs/authority-snapshot.ts) needs to
   *  derive owner identity, required capabilities, and adapter metadata per
   *  visible tool. */
  listWithDescriptors(): { schema: ProviderToolSchema; descriptor: RegisteredToolDescriptor }[] {
    return this.refresh()
  }

  /** The plugin descriptor behind a model-facing name (for approval/annotations). */
  describe(safeName: string): RegisteredToolDescriptor | undefined {
    if (!this.safeToDescriptor.has(safeName)) this.refresh()
    return this.safeToDescriptor.get(safeName)
  }

  /** Invoke a tool by its model-facing (sanitized) name. */
  async invoke(
    safeName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    let descriptor = this.safeToDescriptor.get(safeName)
    if (!descriptor) {
      // The map may be stale (tools changed since the last list); rebuild once.
      this.refresh()
      descriptor = this.safeToDescriptor.get(safeName)
    }
    if (!descriptor) throw new Error(`Unknown tool: ${safeName}`)

    const projected = projectModelVisibleTool({
      description: descriptor.manifestTool.description,
      inputSchema: descriptor.manifestTool.inputSchema,
      outputSchema: descriptor.manifestTool.outputSchema,
      provenance: descriptor.provenance,
      hostNote: this.pluginNote?.(descriptor.pluginId),
    })
    if (!projected.ok) throw new Error(`Tool ${safeName} is not model-visible: ${projected.reason}`)

    return this.host.invokeTool(descriptor.fqName, input, options)
  }

  private refresh(): { schema: ProviderToolSchema; descriptor: RegisteredToolDescriptor }[] {
    this.safeToDescriptor.clear()
    const used = new Set<string>()
    return this.host
      .listTools()
      .map((descriptor) => {
        const safeName = uniqueName(modelToolName(descriptor), used)
        used.add(safeName)
        this.safeToDescriptor.set(safeName, descriptor)

        const projected = projectModelVisibleTool({
          description: descriptor.manifestTool.description,
          inputSchema: descriptor.manifestTool.inputSchema,
          outputSchema: descriptor.manifestTool.outputSchema,
          provenance: descriptor.provenance,
          hostNote: this.pluginNote?.(descriptor.pluginId),
        })
        if (!projected.ok) {
          warnOnce(this.exclusionWarnings, descriptor.fqName, projected.reason, (msg) =>
            logger.warn(msg)
          )
          return undefined
        }
        return {
          descriptor,
          schema: {
            name: safeName,
            description: projected.description,
            inputSchema: projected.inputSchema,
          },
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  }
}

/** Flatten a tool result into the plain text handed back to the model. */
export function renderToolResultText(result: ToolResult): string {
  const parts: string[] = []
  for (const block of result.content) {
    if (block.type === "text") parts.push(block.text)
    else if (block.type === "json") parts.push(JSON.stringify(block.json))
    else if (block.type === "image") parts.push(`[image: ${block.path}]`)
  }
  return parts.join("\n")
}

export function sanitizeToolName(fqName: string): string {
  const cleaned = fqName.replace(/[^\w-]/g, "_")
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned
}

/**
 * Provider tool names are model-visible metadata. Host tools may use their
 * readable, host-authored names; names supplied by plugins and external MCP
 * servers must not become an unframed prompt-injection channel. The reverse
 * map retains the descriptor's real fqName for routing and audit.
 */
export function modelToolName(
  descriptor: Pick<RegisteredToolDescriptor, "fqName" | "provenance">
): string {
  if (descriptor.provenance === "host") return sanitizeToolName(descriptor.fqName)
  const source = descriptor.provenance === "mcp-client" ? "mcp" : "plugin"
  const digest = createHash("sha256").update(descriptor.fqName).digest("hex").slice(0, 20)
  return `external_${source}_${digest}`
}

/** The invocation-recovery adapter behind a tool descriptor. Every existing
 *  host/plugin/MCP tool source declares "none" today — see
 *  tools/invocation-recovery.ts for why an invocation id alone is never
 *  sufficient to claim more. */
export function invocationAdapterFor(
  descriptor: Pick<RegisteredToolDescriptor, "provenance">
): InvocationRecoveryAdapter {
  return noneRecoveryAdapter(frozenProvenance(descriptor.provenance))
}

export function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 124)}_${i}`
    if (!used.has(candidate)) return candidate
  }
}
