import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { PlanStep, PlanStepStatus } from "./plan-types"
import type { RunPlanRegistry } from "./run-plan-registry"

export const PLAN_FQ_PREFIX = "plan:"
const PLAN_PLUGIN_ID = "plan:core"
export const UPDATE_PLAN_FQ = `${PLAN_PLUGIN_ID}/update_plan`

const STATUSES: PlanStepStatus[] = ["pending", "in_progress", "completed"]

export interface PlanToolOptions {
  registry: RunPlanRegistry
  /** Push the current plan to the renderer. Failure must be swallowed by the caller-provided fn. */
  emitPlan: (runId: string, steps: PlanStep[]) => void
}

const DESCRIPTOR: RegisteredToolDescriptor = {
  fqName: UPDATE_PLAN_FQ,
  pluginId: PLAN_PLUGIN_ID,
  manifestTool: {
    name: "update_plan",
    title: "Update task plan",
    description:
      "Declare or update the ordered list of steps you intend to take for this task. Call it first for any multi-step task, then keep it current: mark a step in_progress when you start it and completed when done. Replaces the whole plan each call — always send the full list. Purely advisory and visible to the user; it takes no action itself.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "The full ordered list of steps.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short imperative step description." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Defaults to pending.",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["steps"],
    },
    annotations: { readOnlyHint: true },
  },
}

export class PlanToolSource implements ToolHostSource {
  constructor(private readonly options: PlanToolOptions) {}

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(PLAN_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return [DESCRIPTOR]
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options?: ToolInvocationOptions
  ): Promise<ToolResult> {
    if (fqName !== UPDATE_PLAN_FQ) return errorResult(`Unknown tool: ${fqName}`)
    const runId = options?.caller.runId
    if (!runId) return errorResult("update_plan requires an active run.")

    const parsed = parseSteps(input)
    if (!parsed.ok) return errorResult(parsed.reason)

    this.options.registry.set(runId, parsed.steps)
    try {
      this.options.emitPlan(runId, parsed.steps)
    } catch {
      // best-effort: the plan is stored + will still be folded into the trace.
    }
    return {
      content: [{ type: "text", text: `Plan updated (${parsed.steps.length} steps).` }],
      structured: { ok: true, count: parsed.steps.length },
    }
  }
}

function parseSteps(
  input: unknown
): { ok: true; steps: PlanStep[] } | { ok: false; reason: string } {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  if (!Array.isArray(obj.steps)) return { ok: false, reason: "steps must be an array." }
  const steps: PlanStep[] = []
  for (const raw of obj.steps) {
    if (!raw || typeof raw !== "object")
      return { ok: false, reason: "each step must be an object." }
    const r = raw as Record<string, unknown>
    if (typeof r.title !== "string" || r.title.trim() === "") {
      return { ok: false, reason: "each step needs a non-empty title." }
    }
    const status =
      typeof r.status === "string" && STATUSES.includes(r.status as PlanStepStatus)
        ? (r.status as PlanStepStatus)
        : "pending"
    steps.push({ title: r.title, status })
  }
  return { ok: true, steps }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}
