import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ProviderToolSchema } from "./providers/types"

// Bridges the plugin tool surface to what a model can call. Plugin fqNames look
// like `com.example.hello-world/greet`, which contain `.` and `/` and so fail
// the Anthropic/OpenAI tool-name charset (`^[a-zA-Z0-9_-]{1,128}$`). We sanitize
// to a model-safe name and keep a reverse map so invocations route back to the
// real fqName (decision §11.3 — sanitize at the provider layer, no alias table
// in the manifest).

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
  private safeToFq = new Map<string, string>()

  constructor(private readonly host: ToolHostPort) {}

  /** Current tools as model-facing schemas. Rebuilds the reverse map. */
  list(): ProviderToolSchema[] {
    return this.refresh().map(({ schema }) => schema)
  }

  /** Invoke a tool by its model-facing (sanitized) name. */
  async invoke(
    safeName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    let fqName = this.safeToFq.get(safeName)
    if (!fqName) {
      // The map may be stale (tools changed since the last list); rebuild once.
      this.refresh()
      fqName = this.safeToFq.get(safeName)
    }
    if (!fqName) throw new Error(`Unknown tool: ${safeName}`)
    return this.host.invokeTool(fqName, input, options)
  }

  private refresh(): { schema: ProviderToolSchema; fqName: string }[] {
    this.safeToFq.clear()
    const used = new Set<string>()
    return this.host.listTools().map((descriptor) => {
      const safeName = uniqueName(sanitizeToolName(descriptor.fqName), used)
      used.add(safeName)
      this.safeToFq.set(safeName, descriptor.fqName)
      return {
        fqName: descriptor.fqName,
        schema: {
          name: safeName,
          description: descriptor.manifestTool.description,
          inputSchema: descriptor.manifestTool.inputSchema,
        },
      }
    })
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

function sanitizeToolName(fqName: string): string {
  const cleaned = fqName.replace(/[^\w-]/g, "_")
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 124)}_${i}`
    if (!used.has(candidate)) return candidate
  }
}
