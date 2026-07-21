import type { JsonSchema } from "@synapse/plugin-manifest"
import type { ToolCaller, ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type { AgentRunStore } from "../runs/agent-run-store"
import type { AgentRunCheckpointV1 } from "../runs/checkpoint-schema"
import type { ChildTaskScheduler } from "./child-task-scheduler"
import type { ChildTaskRecord } from "./child-task-types"
import { PLAN_FQ_PREFIX } from "../plan/plan-tool-source"
import { toAgentChildTaskSummary } from "../runs/run-projection"
import { SPAWN_SUBAGENT_FQ } from "../subagent/subagent-tool-source"
import { AiToolRegistry } from "../tool-registry"

// Conversation-owned durable async tasks. These names intentionally differ
// from the existing synchronous `spawn_subagent` contract: a start call only
// returns a durable task id and never waits for its child run to finish.
export const CHILD_TASK_FQ_PREFIX = "agent:core/"
const CHILD_TASK_PLUGIN_ID = "agent:core"
export const START_CHILD_TASK_FQ = `${CHILD_TASK_PLUGIN_ID}/start_subagent_task`
export const CHECK_CHILD_TASK_FQ = `${CHILD_TASK_PLUGIN_ID}/check_subagent_task`
export const LIST_CHILD_TASKS_FQ = `${CHILD_TASK_PLUGIN_ID}/list_subagent_tasks`
export const CANCEL_CHILD_TASK_FQ = `${CHILD_TASK_PLUGIN_ID}/cancel_subagent_task`

const CHILD_TASK_FQ_NAMES = new Set([
  START_CHILD_TASK_FQ,
  CHECK_CHILD_TASK_FQ,
  LIST_CHILD_TASKS_FQ,
  CANCEL_CHILD_TASK_FQ,
])
const DEFAULT_MAX_STEPS = 3
const MAX_CHILD_BUDGET_TOKENS = 1_000_000

export interface ChildTaskToolSourceOptions {
  /** Deferred because the host tool surface is assembled before index.ts
   * finishes wiring the scheduler's shared continuation callback. */
  scheduler: () => ChildTaskScheduler
  runStore: AgentRunStore
  /** The current host registry. A child registry is built from this only
   * after intersecting it with the caller checkpoint's frozen authority. */
  parentTools: () => AiToolRegistry
}

const START_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short label for this asynchronous task." },
    description: { type: "string", description: "Bounded description of the intended outcome." },
    instruction: { type: "string", description: "The self-contained instruction for the child." },
    allowedTools: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional subset of your current tool names. Omit to grant only your read-only tools. " +
        "Task and planning tools are never delegable.",
    },
    maxSteps: {
      type: "number",
      description: "Optional positive cap no greater than this run's frozen maxSteps.",
    },
    budgetTokens: {
      type: "number",
      description:
        "Optional finite token reservation for this child. It is debited from the root ledger; " +
        "the default is finite even when the parent run has no budget ceiling.",
    },
  },
  required: ["name", "description", "instruction"],
}

const TASK_ID_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The task id returned by start_subagent_task." },
  },
  required: ["taskId"],
}

const DESCRIPTORS: readonly RegisteredToolDescriptor[] = [
  {
    fqName: START_CHILD_TASK_FQ,
    pluginId: CHILD_TASK_PLUGIN_ID,
    provenance: "host",
    replayGuarantee: "none",
    manifestTool: {
      name: "start_subagent_task",
      title: "Start asynchronous subagent task",
      description:
        "Create a durable, conversation-owned asynchronous subagent task. Returns immediately " +
        "with a task id; use check_subagent_task or list_subagent_tasks in a later turn. " +
        "The child receives only a subset of your frozen tool authority and a finite budget.",
      inputSchema: START_INPUT_SCHEMA,
      annotations: { requiresConfirmation: true },
      capabilities: [],
    },
  },
  {
    fqName: CHECK_CHILD_TASK_FQ,
    pluginId: CHILD_TASK_PLUGIN_ID,
    provenance: "host",
    replayGuarantee: "none",
    manifestTool: {
      name: "check_subagent_task",
      title: "Check asynchronous subagent task",
      description: "Read the bounded status and result reference for a task in this conversation.",
      inputSchema: TASK_ID_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      capabilities: [],
    },
  },
  {
    fqName: LIST_CHILD_TASKS_FQ,
    pluginId: CHILD_TASK_PLUGIN_ID,
    provenance: "host",
    replayGuarantee: "none",
    manifestTool: {
      name: "list_subagent_tasks",
      title: "List asynchronous subagent tasks",
      description: "List bounded status metadata for tasks owned by this conversation.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      capabilities: [],
    },
  },
  {
    fqName: CANCEL_CHILD_TASK_FQ,
    pluginId: CHILD_TASK_PLUGIN_ID,
    provenance: "host",
    replayGuarantee: "none",
    manifestTool: {
      name: "cancel_subagent_task",
      title: "Cancel asynchronous subagent task",
      description: "Durably cancel a queued or running task owned by this conversation.",
      inputSchema: TASK_ID_INPUT_SCHEMA,
      annotations: { requiresConfirmation: true },
      capabilities: [],
    },
  },
]

export class ChildTaskToolSource implements ToolHostSource {
  constructor(private readonly options: ChildTaskToolSourceOptions) {}

  ownsTool(fqName: string): boolean {
    return CHILD_TASK_FQ_NAMES.has(fqName)
  }

  listTools(): RegisteredToolDescriptor[] {
    return [...DESCRIPTORS]
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    try {
      if (fqName === START_CHILD_TASK_FQ) return await this.start(input, options.caller)
      if (fqName === CHECK_CHILD_TASK_FQ) return await this.check(input, options.caller)
      if (fqName === LIST_CHILD_TASKS_FQ) return await this.list(options.caller)
      if (fqName === CANCEL_CHILD_TASK_FQ) return await this.cancel(input, options.caller)
      return errorResult(`Unknown tool: ${fqName}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }

  private async start(input: unknown, caller: ToolCaller): Promise<ToolResult> {
    const parent = await this.requireInteractiveConversationCaller(caller)
    const parsed = parseStartInput(input, parent)
    if (!parsed.ok) return errorResult(parsed.reason)

    const tools = this.narrowedChildTools(parent, parsed.value.allowedTools)
    if (!tools.ok) return errorResult(tools.reason)

    const { taskId } = await this.scheduler.start({
      originRunId: parent.identity.runId,
      name: parsed.value.name,
      description: parsed.value.description,
      instruction: parsed.value.instruction,
      tools: tools.registry,
      providerId: parent.config.providerId,
      model: parent.config.model,
      maxOutputTokens: parent.config.maxOutputTokens,
      maxSteps: parsed.value.maxSteps,
      budgetTokens: parsed.value.budgetTokens,
    })
    const record = await this.scheduler.store.get(taskId)
    return textResult(taskPayload(record))
  }

  private async check(input: unknown, caller: ToolCaller): Promise<ToolResult> {
    const parent = await this.requireInteractiveConversationCaller(caller)
    const taskId = parseTaskId(input)
    if (!taskId.ok) return errorResult(taskId.reason)
    const record = await this.readOwnedTask(taskId.value, parent.identity.conversationId!)
    return record ? textResult(taskPayload(record, true)) : inaccessibleTaskResult()
  }

  private async list(caller: ToolCaller): Promise<ToolResult> {
    const parent = await this.requireInteractiveConversationCaller(caller)
    const tasks = await this.scheduler.store.listForConversation(parent.identity.conversationId!)
    return textResult({ tasks: tasks.map((task) => taskPayload(task)) })
  }

  private async cancel(input: unknown, caller: ToolCaller): Promise<ToolResult> {
    const parent = await this.requireInteractiveConversationCaller(caller)
    const taskId = parseTaskId(input)
    if (!taskId.ok) return errorResult(taskId.reason)
    const record = await this.readOwnedTask(taskId.value, parent.identity.conversationId!)
    if (!record) return inaccessibleTaskResult()
    await this.scheduler.cancel(record.taskId)
    return textResult(taskPayload(await this.scheduler.store.get(record.taskId)))
  }

  /** A task id is intentionally not a bearer capability. Every call reloads
   * the invoking checkpoint and checks the immutable conversation owner
   * before it ever looks up/list/cancels a task. */
  private async requireInteractiveConversationCaller(
    caller: ToolCaller
  ): Promise<AgentRunCheckpointV1> {
    if (
      caller.kind !== "agent" ||
      !caller.runId ||
      !caller.conversationId ||
      caller.parentRunId !== undefined
    ) {
      throw new Error("asynchronous child tasks require an active interactive conversation run.")
    }
    const loaded = await this.options.runStore.load(caller.runId)
    if (!loaded.ok) throw new Error(`origin run ${caller.runId} checkpoint is ${loaded.reason}`)
    const checkpoint = loaded.checkpoint
    if (
      checkpoint.identity.origin !== "interactive" ||
      !checkpoint.identity.conversationId ||
      checkpoint.identity.conversationId !== caller.conversationId
    ) {
      throw new Error("asynchronous child tasks require an active interactive conversation run.")
    }
    return checkpoint
  }

  private async readOwnedTask(
    taskId: string,
    conversationId: string
  ): Promise<ChildTaskRecord | undefined> {
    try {
      const record = await this.scheduler.store.get(taskId)
      return record.conversationId === conversationId ? record : undefined
    } catch {
      // Do not distinguish unknown ids, corrupt records, and ids owned by a
      // different conversation: none is actionable to this caller.
      return undefined
    }
  }

  private narrowedChildTools(
    parent: AgentRunCheckpointV1,
    requested: readonly string[] | undefined
  ): { ok: true; registry: AiToolRegistry } | { ok: false; reason: string } {
    const live = this.options.parentTools().listWithDescriptors()
    const frozenByFq = new Map(parent.config.authority.tools.map((tool) => [tool.fqName, tool]))
    const visible = live.filter(({ schema, descriptor }) => {
      const frozen = frozenByFq.get(descriptor.fqName)
      return frozen !== undefined && frozen.safeName === schema.name
    })
    const byName = new Map(visible.map((entry) => [entry.schema.name, entry]))
    const requestedNames =
      requested ??
      visible
        .filter(({ descriptor }) => descriptor.manifestTool.annotations?.readOnlyHint === true)
        .map(({ schema }) => schema.name)

    const unknown = requestedNames.filter((name) => !byName.has(name))
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: `allowedTools contains a tool outside your frozen authority: ${unknown[0]}`,
      }
    }

    const allowed = requestedNames
      .map((name) => byName.get(name)!)
      .filter(({ descriptor }) => !isOrchestrationTool(descriptor))
    const allowedFq = new Set(allowed.map(({ descriptor }) => descriptor.fqName))
    const allowedDescriptors = allowed.map(({ descriptor }) => descriptor)
    const parentTools = this.options.parentTools()
    return {
      ok: true,
      registry: new AiToolRegistry({
        listTools: () => allowedDescriptors,
        invokeTool: (fqName, input, options) => {
          if (!allowedFq.has(fqName)) throw new Error(`Tool not allowed in child task: ${fqName}`)
          const safeName = allowed.find(({ descriptor }) => descriptor.fqName === fqName)?.schema
            .name
          if (!safeName) throw new Error(`Unknown child task tool: ${fqName}`)
          return parentTools.invoke(safeName, input, options)
        },
      }),
    }
  }

  private get scheduler(): ChildTaskScheduler {
    return this.options.scheduler()
  }
}

function parseStartInput(
  input: unknown,
  parent: AgentRunCheckpointV1
):
  | {
      ok: true
      value: {
        name: string
        description: string
        instruction: string
        allowedTools?: string[]
        maxSteps: number
        budgetTokens: number
      }
    }
  | { ok: false; reason: string } {
  const value = asObject(input)
  const name = boundedString(value.name, "name", 500)
  const description = boundedString(value.description, "description", 4_000)
  const instruction = boundedString(value.instruction, "instruction", 32_000)
  if (!name.ok) return { ok: false, reason: name.reason }
  if (!description.ok) return { ok: false, reason: description.reason }
  if (!instruction.ok) return { ok: false, reason: instruction.reason }
  let allowedTools: string[] | undefined
  if (value.allowedTools !== undefined) {
    if (
      !Array.isArray(value.allowedTools) ||
      !value.allowedTools.every((name) => typeof name === "string")
    ) {
      return { ok: false, reason: "allowedTools must be an array of tool names." }
    }
    allowedTools = [...new Set(value.allowedTools.map((name) => name.trim()).filter(Boolean))]
  }
  const maxSteps =
    value.maxSteps === undefined
      ? Math.min(DEFAULT_MAX_STEPS, parent.config.maxSteps)
      : value.maxSteps
  if (!isPositiveInteger(maxSteps) || maxSteps > parent.config.maxSteps) {
    return {
      ok: false,
      reason: "maxSteps must be a positive integer no greater than the parent run's maxSteps.",
    }
  }
  const defaultBudget = defaultChildBudget(parent, maxSteps)
  const budgetTokens = value.budgetTokens === undefined ? defaultBudget : value.budgetTokens
  if (!isPositiveInteger(budgetTokens) || budgetTokens > MAX_CHILD_BUDGET_TOKENS) {
    return {
      ok: false,
      reason: `budgetTokens must be a finite positive integer no greater than ${MAX_CHILD_BUDGET_TOKENS}.`,
    }
  }
  return {
    ok: true,
    value: {
      name: name.value,
      description: description.value,
      instruction: instruction.value,
      allowedTools,
      maxSteps,
      budgetTokens,
    },
  }
}

function defaultChildBudget(parent: AgentRunCheckpointV1, maxSteps: number): number {
  const perStep = Math.max(1, parent.config.maxOutputTokens)
  const derived = Math.min(MAX_CHILD_BUDGET_TOKENS, perStep * maxSteps)
  return parent.config.runBudgetTokens === undefined
    ? derived
    : Math.max(1, Math.min(parent.config.runBudgetTokens, derived))
}

function parseTaskId(input: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  const taskId = asObject(input).taskId
  if (typeof taskId !== "string" || !/^[\w-]{1,128}$/.test(taskId)) {
    return { ok: false, reason: "taskId must be a valid task id." }
  }
  return { ok: true, value: taskId }
}

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

function boundedString(
  value: unknown,
  field: string,
  maxChars: number
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || !value.trim())
    return { ok: false, reason: `${field} is required.` }
  if (value.length > maxChars) return { ok: false, reason: `${field} is too long.` }
  return { ok: true, value: value.trim() }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isOrchestrationTool(descriptor: RegisteredToolDescriptor): boolean {
  return (
    descriptor.fqName.startsWith(PLAN_FQ_PREFIX) ||
    descriptor.fqName === SPAWN_SUBAGENT_FQ ||
    CHILD_TASK_FQ_NAMES.has(descriptor.fqName)
  )
}

function taskPayload(record: ChildTaskRecord, includeDescription = false): Record<string, unknown> {
  return {
    taskId: record.taskId,
    childRunId: record.currentRunId,
    name: record.name.slice(0, 500),
    status: record.status,
    summary: toAgentChildTaskSummary(record),
    ...(includeDescription ? { description: record.description.slice(0, 4_000) } : {}),
    ...(record.resultArtifact
      ? {
          result: {
            uri: record.resultArtifact.uri,
            kind: record.resultArtifact.kind,
            mediaType: record.resultArtifact.mediaType,
            capturedBytes: record.resultArtifact.capturedBytes,
            complete: record.resultArtifact.complete,
          },
        }
      : {}),
  }
}

function textResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structured: payload,
  }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

function inaccessibleTaskResult(): ToolResult {
  return errorResult("task not found or not accessible from this conversation.")
}
