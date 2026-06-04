import type { JsonSchema } from "@synapse/plugin-manifest"
import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { MemoryService } from "./memory-service"

// Built-in memory tools exposed to the agent as a ToolHostSource, alongside
// plugin and external-MCP tools (they share one registry, naming, and approval
// path). Namespaced `memory:` so the composite host routes them here. Unlike
// plugin tools these don't run in the vm sandbox, so input is validated inline.

export const MEMORY_FQ_PREFIX = "memory:"
const MEMORY_PLUGIN_ID = "memory:core"

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): JsonSchema => ({ type: "object", properties, required })

const TOOLS: RegisteredToolDescriptor[] = [
  {
    fqName: `${MEMORY_PLUGIN_ID}/memory_save`,
    pluginId: MEMORY_PLUGIN_ID,
    manifestTool: {
      name: "memory_save",
      title: "Save memory",
      description:
        "Save a durable fact to long-term memory so it can be recalled in later conversations. Use for stable preferences, decisions, and facts the user wants remembered.",
      inputSchema: objectSchema(
        {
          text: { type: "string", description: "The fact to remember." },
          tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
        },
        ["text"]
      ),
      annotations: { readOnlyHint: false },
    },
  },
  {
    fqName: `${MEMORY_PLUGIN_ID}/memory_search`,
    pluginId: MEMORY_PLUGIN_ID,
    manifestTool: {
      name: "memory_search",
      title: "Search memory",
      description:
        "Recall relevant facts from long-term memory by semantic similarity to a query. Call this before answering when prior context may help.",
      inputSchema: objectSchema(
        {
          query: { type: "string", description: "What to recall." },
          limit: { type: "number", description: "Max results (default 5)." },
        },
        ["query"]
      ),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${MEMORY_PLUGIN_ID}/memory_list`,
    pluginId: MEMORY_PLUGIN_ID,
    manifestTool: {
      name: "memory_list",
      title: "List memory",
      description: "List the most recent saved memories.",
      inputSchema: objectSchema({
        limit: { type: "number", description: "Max results (default 50)." },
      }),
      annotations: { readOnlyHint: true },
    },
  },
  {
    fqName: `${MEMORY_PLUGIN_ID}/memory_delete`,
    pluginId: MEMORY_PLUGIN_ID,
    manifestTool: {
      name: "memory_delete",
      title: "Delete memory",
      description: "Delete a saved memory by its id.",
      inputSchema: objectSchema({ id: { type: "string", description: "Memory id." } }, ["id"]),
      annotations: { destructiveHint: true },
    },
  },
]

export class MemoryToolSource implements ToolHostSource {
  constructor(private readonly memory: MemoryService) {}

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(MEMORY_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return TOOLS
  }

  async invokeTool(fqName: string, input: unknown): Promise<ToolResult> {
    const toolName = fqName.slice(`${MEMORY_PLUGIN_ID}/`.length)
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
    try {
      switch (toolName) {
        case "memory_save":
          return await this.save(args)
        case "memory_search":
          return await this.search(args)
        case "memory_list":
          return await this.list(args)
        case "memory_delete":
          return await this.remove(args)
        default:
          return errorResult(`Unknown memory tool: ${fqName}`)
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }

  private async save(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.text !== "string" || !args.text.trim()) return errorResult("text is required.")
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined
    const entry = await this.memory.save({ text: args.text, tags })
    return json({ saved: { id: entry.id, text: entry.text, tags: entry.tags } })
  }

  private async search(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.query !== "string" || !args.query.trim()) {
      return errorResult("query is required.")
    }
    const hits = await this.memory.search(args.query, numberOr(args.limit, 5))
    return json({
      results: hits.map((hit) => ({
        id: hit.entry.id,
        text: hit.entry.text,
        tags: hit.entry.tags,
        score: Number(hit.score.toFixed(4)),
      })),
    })
  }

  private async list(args: Record<string, unknown>): Promise<ToolResult> {
    const entries = await this.memory.list(numberOr(args.limit, 50))
    return json({
      memories: entries.map((entry) => ({ id: entry.id, text: entry.text, tags: entry.tags })),
    })
  }

  private async remove(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.id !== "string") return errorResult("id is required.")
    const deleted = await this.memory.delete(args.id)
    return json({ deleted })
  }
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "json", json: value }], structured: value }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}
