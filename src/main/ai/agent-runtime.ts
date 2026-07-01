import type { ToolCaller } from "@synapse/plugin-sdk"
import type { PlanStep } from "./plan/plan-types"
import type { ChatContentBlock, ChatMessage, ChatProvider, TokenUsage } from "./providers/types"
import type { RunTrace, RunTraceToolCall } from "./run-trace-store"
import type { AiToolRegistry } from "./tool-registry"
import { randomUUID } from "node:crypto"
import { logger } from "../logging"
import { DEFAULT_ANTHROPIC_MODEL } from "./providers/anthropic-provider"
import { addUsage, emptyUsage, totalTokens } from "./providers/types"
import { renderToolResultText } from "./tool-registry"

// The agent loop: stream a turn → if the model called tools, run them through
// the sandbox (via AiToolRegistry) → feed results back → repeat until the model
// answers or we hit maxSteps. Provider-agnostic, headless, cancellable. The
// approval hook is the seam P3's ApprovalGate plugs into — P2 auto-approves.

const DEFAULT_SYSTEM_PROMPT =
  "You are Synapse's built-in assistant. Help the user using the available tools. " +
  "Call a tool when it can answer precisely; otherwise answer directly and concisely."

const ROUTING_GUIDANCE_BASE =
  "When a task matches an installed plugin's specialty — cloud services with brokered " +
  "credentials, governed/approved writeback, revocable or audited actions, or a specific " +
  "declared scenario — prefer that plugin, and call describe_plugin first to confirm its " +
  "capability boundary. Plugins exist for what shell and scripts cannot safely do."

const ROUTING_GUIDANCE_PLAN =
  " For a task that needs several steps or multiple approvals, call update_plan first to lay out the steps, then keep it current as you work."

const ROUTING_GUIDANCE_SHELL =
  " Use run_shell only for general, local, scriptable tasks where no suitable plugin exists; " +
  "it always requires user confirmation."

export function buildSystemPrompt(base: string, opts: { shellEnabled: boolean }): string {
  const guidance =
    ROUTING_GUIDANCE_BASE +
    ROUTING_GUIDANCE_PLAN +
    (opts.shellEnabled ? ROUTING_GUIDANCE_SHELL : "")
  return `${base}\n\n${guidance}`
}

export interface AgentRuntimeOptions {
  provider: ChatProvider
  tools: AiToolRegistry
  model?: string
  maxSteps?: number
  maxTokens?: number
  budgetTokens?: number
  defaultSystem?: string
  shellEnabled?: boolean
  recordRun?: (trace: RunTrace) => void
  getPlan?: (runId: string) => PlanStep[] | undefined
  compress?: (
    system: string,
    messages: ChatMessage[]
  ) => Promise<{ messages: ChatMessage[]; summarizerTokens: number }>
}

export interface ApprovalRequest {
  toolName: string
  input: unknown
}

export type AgentEvent =
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean }

export interface AgentRunOptions {
  conversationId: string
  messages: ChatMessage[]
  system?: string
  signal?: AbortSignal
  onText?: (delta: string) => void
  onEvent?: (event: AgentEvent) => void
  approve?: (request: ApprovalRequest) => boolean | Promise<boolean>
  caller?: ToolCaller
  runId?: string
  origin?: "interactive" | "background-agent" | "subagent"
  parentRunId?: string
}

export interface AgentRunResult {
  messages: ChatMessage[]
  stopReason: "end_turn" | "max_steps" | "aborted" | "budget_exceeded"
  usage: TokenUsage
}

export class AgentRuntime {
  constructor(private readonly options: AgentRuntimeOptions) {}

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const runId = options.runId ?? randomUUID()
    const origin = options.origin ?? "interactive"
    const startedAt = Date.now()
    const toolCalls: RunTraceToolCall[] = []
    const messages = [...options.messages]
    const model = this.options.model ?? DEFAULT_ANTHROPIC_MODEL
    const maxSteps = this.options.maxSteps ?? 10
    const maxTokens = this.options.maxTokens ?? 4096
    const budgetTokens = this.options.budgetTokens
    const base = options.system ?? this.options.defaultSystem ?? DEFAULT_SYSTEM_PROMPT
    const system = buildSystemPrompt(base, { shellEnabled: this.options.shellEnabled ?? false })
    let usage = emptyUsage()

    const finish = (stopReason: AgentRunResult["stopReason"]): AgentRunResult => {
      this.recordTrace({ runId, origin, options, startedAt, toolCalls, outcome: stopReason })
      return { messages, stopReason, usage }
    }

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (options.signal?.aborted) return finish("aborted")
        if (step > 0 && budgetTokens !== undefined && totalTokens(usage) >= budgetTokens) {
          return finish("budget_exceeded")
        }

        const tools = this.options.tools.list()
        let assistant: ChatMessage | undefined

        const outgoing = this.options.compress
          ? await this.options.compress(system, messages)
          : { messages, summarizerTokens: 0 }
        if (outgoing.summarizerTokens > 0) {
          usage = addUsage(usage, { ...emptyUsage(), outputTokens: outgoing.summarizerTokens })
        }

        for await (const event of this.options.provider.stream({
          model,
          system,
          messages: outgoing.messages,
          tools,
          maxTokens,
          signal: options.signal,
        })) {
          if (event.type === "text") {
            options.onText?.(event.text)
          } else {
            assistant = event.message
            usage = addUsage(usage, event.usage)
          }
        }

        if (!assistant) throw new Error("Provider stream ended without a final message")
        messages.push(assistant)

        const calls = assistant.content.filter(isToolUse)
        if (calls.length === 0) return finish("end_turn")

        const resultBlocks: ChatContentBlock[] = []
        for (const call of calls) {
          options.onEvent?.({ type: "tool_call", id: call.id, name: call.name, input: call.input })
          resultBlocks.push(await this.runOneTool(call, options, runId, toolCalls))
        }
        messages.push({ role: "user", content: resultBlocks })
      }

      return finish("max_steps")
    } catch (err) {
      this.recordTrace({ runId, origin, options, startedAt, toolCalls, outcome: "error" })
      throw err
    }
  }

  private recordTrace(args: {
    runId: string
    origin: RunTrace["origin"]
    options: AgentRunOptions
    startedAt: number
    toolCalls: RunTraceToolCall[]
    outcome: RunTrace["outcome"]
  }): void {
    const record = this.options.recordRun
    if (!record) return
    const trace: RunTrace = {
      runId: args.runId,
      origin: args.origin,
      startedAt: args.startedAt,
      endedAt: Date.now(),
      outcome: args.outcome,
      toolCalls: args.toolCalls,
    }
    if (args.origin === "interactive" || args.origin === "subagent") {
      trace.conversationId = args.options.conversationId
    } else trace.invocationId = args.options.conversationId
    if (args.options.parentRunId !== undefined) trace.parentRunId = args.options.parentRunId

    const plan = this.options.getPlan?.(args.runId)
    if (plan && plan.length > 0) trace.plan = plan

    try {
      record(trace)
    } catch (err) {
      logger.child("agent-runtime").warn("recordRun threw; run trace dropped", {
        runId: args.runId,
        err,
      })
    }
  }

  private async runOneTool(
    call: { id: string; name: string; input: unknown },
    options: AgentRunOptions,
    runId: string,
    toolCalls: RunTraceToolCall[]
  ): Promise<ChatContentBlock> {
    const startedAt = Date.now()
    const record = (ok: boolean, error?: string): void => {
      toolCalls.push({
        name: this.resolveToolName(call.name),
        startedAt,
        ms: Date.now() - startedAt,
        ok,
        error,
      })
    }

    const approved = options.approve
      ? await options.approve({ toolName: call.name, input: call.input })
      : true
    if (!approved) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      record(false, "denied")
      return toolResult(call.id, "Tool call denied.", true)
    }

    try {
      const result = await this.options.tools.invoke(call.name, call.input, {
        caller: options.caller ?? { kind: "agent", conversationId: options.conversationId, runId },
        signal: options.signal,
      })
      const isError = result.isError ?? false
      options.onEvent?.({ type: "tool_result", id: call.id, isError })
      record(!isError, isError ? "tool-error" : undefined)
      return toolResult(call.id, renderToolResultText(result) || "(no output)", isError)
    } catch (err) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      const message = err instanceof Error ? err.message : String(err)
      record(false, message)
      return toolResult(call.id, message, true)
    }
  }

  private resolveToolName(safeName: string): string {
    return this.options.tools.describe(safeName)?.fqName ?? safeName
  }
}

function isToolUse(
  block: ChatContentBlock
): block is { type: "tool_use"; id: string; name: string; input: unknown } {
  return block.type === "tool_use"
}

function toolResult(toolUseId: string, content: string, isError: boolean): ChatContentBlock {
  return { type: "tool_result", toolUseId, content, isError }
}
