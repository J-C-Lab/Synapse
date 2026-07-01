import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { AiToolRegistry } from "../tool-registry"
import type { SubagentRunInput, SubagentRunResult } from "./subagent-runner"
import { PLAN_FQ_PREFIX } from "../plan/plan-tool-source"
import { AiToolRegistry as Registry } from "../tool-registry"

export const SUBAGENT_FQ_PREFIX = "agent:"
const SUBAGENT_PLUGIN_ID = "agent:core"
export const SPAWN_SUBAGENT_FQ = `${SUBAGENT_PLUGIN_ID}/spawn_subagent`

const DEFAULT_MAX_STEPS = 8

export interface SpawnSubagentOptions {
  runSubagent: (input: SubagentRunInput) => Promise<SubagentRunResult>
  parentTools: () => AiToolRegistry
  budgetTokens?: (runId: string) => number | undefined
}

const DESCRIPTOR: RegisteredToolDescriptor = {
  fqName: SPAWN_SUBAGENT_FQ,
  pluginId: SUBAGENT_PLUGIN_ID,
  manifestTool: {
    name: "spawn_subagent",
    title: "Delegate a subtask",
    description:
      "Delegate a focused subtask to a nested agent with a restricted set of tools (a subset of your own). Use for a self-contained unit of work you want to run with a narrowed scope. Provide `allowedTools` (a subset of your current tool names); omit it to give the subagent only your read-only tools. Returns the subagent's summary. Cannot be nested further.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "The subtask for the subagent to carry out." },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tool names the subagent may use; must be a subset of yours. Omit for read-only only.",
        },
        maxSteps: {
          type: "number",
          description: "Optional cap on the subagent's tool-loop rounds.",
        },
      },
      required: ["instruction"],
    },
    annotations: { requiresConfirmation: true },
  },
}

export class SpawnSubagentToolSource implements ToolHostSource {
  constructor(private readonly options: SpawnSubagentOptions) {}

  ownsTool(fqName: string): boolean {
    return fqName === SPAWN_SUBAGENT_FQ
  }

  listTools(): RegisteredToolDescriptor[] {
    return [DESCRIPTOR]
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options?: ToolInvocationOptions
  ): Promise<ToolResult> {
    if (fqName !== SPAWN_SUBAGENT_FQ) return errorResult(`Unknown tool: ${fqName}`)
    const caller = options?.caller
    if (!caller?.runId) return errorResult("spawn_subagent requires an active run.")
    if (caller.kind === "subagent" || caller.parentRunId) {
      return errorResult("Subagents cannot spawn further subagents (max depth 1).")
    }

    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
    const instruction = typeof args.instruction === "string" ? args.instruction : ""
    if (!instruction.trim()) return errorResult("instruction is required.")

    const parent = this.options.parentTools()
    const parentSchemas = parent.list()
    const parentNames = new Set(parentSchemas.map((s) => s.name))

    let allowedNames: string[]
    if (Array.isArray(args.allowedTools)) {
      allowedNames = args.allowedTools
        .filter((n): n is string => typeof n === "string")
        .filter((n) => parentNames.has(n))
    } else {
      allowedNames = parentSchemas
        .filter((s) => parent.describe(s.name)?.manifestTool.annotations?.readOnlyHint === true)
        .map((s) => s.name)
    }
    // Subagents are executors, not orchestrators — never delegate plan/subagent tools
    // (Route A: exclude by tool list; depth guard on spawn_subagent stays defense-in-depth).
    allowedNames = allowedNames.filter((name) => !isOrchestrationTool(parent.describe(name)))

    if (allowedNames.length === 0) {
      return errorResult("No tools available to delegate (empty allowed set after intersection).")
    }

    const allowedFq = new Set(
      allowedNames
        .map((name) => parent.describe(name)?.fqName)
        .filter((fq): fq is string => fq !== undefined)
    )

    const filteredHost = {
      listTools: () =>
        allowedNames
          .map((name) => parent.describe(name))
          .filter((d): d is RegisteredToolDescriptor => d !== undefined),
      invokeTool: (fq: string, i: unknown, o?: ToolInvocationOptions) => {
        if (!allowedFq.has(fq)) throw new Error(`Tool not allowed in subagent: ${fq}`)
        const safeName = allowedNames.find((n) => parent.describe(n)?.fqName === fq)
        if (!safeName) throw new Error(`Unknown tool: ${fq}`)
        return parent.invoke(safeName, i, o ?? { caller: options!.caller, signal: options?.signal })
      },
    }

    const maxSteps =
      typeof args.maxSteps === "number" && args.maxSteps > 0
        ? Math.floor(args.maxSteps)
        : DEFAULT_MAX_STEPS

    const result = await this.options.runSubagent({
      parentRunId: caller.runId,
      parentConversationId: caller.conversationId ?? "",
      instruction,
      tools: new Registry(filteredHost),
      maxSteps,
      budgetTokens: this.options.budgetTokens?.(caller.runId),
      signal: options?.signal,
    })

    return {
      content: [{ type: "text", text: `Subagent (${result.outcome}):\n${result.summary}` }],
      structured: { childRunId: result.childRunId, outcome: result.outcome },
    }
  }
}

function isOrchestrationTool(descriptor: RegisteredToolDescriptor | undefined): boolean {
  if (!descriptor) return false
  return (
    descriptor.fqName.startsWith(PLAN_FQ_PREFIX) || descriptor.fqName.startsWith(SUBAGENT_FQ_PREFIX)
  )
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}
