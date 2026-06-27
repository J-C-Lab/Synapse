import type { ToolCaller } from "@synapse/plugin-sdk"
import type { ChatContentBlock, ChatMessage, ChatProvider, TokenUsage } from "./providers/types"
import type { AiToolRegistry } from "./tool-registry"
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

export interface AgentRuntimeOptions {
  provider: ChatProvider
  tools: AiToolRegistry
  model?: string
  /** Hard ceiling on tool-use rounds, guarding against runaway loops. */
  maxSteps?: number
  maxTokens?: number
  /**
   * Cumulative token budget for the whole run. Once total usage reaches this,
   * the loop stops before the next (expensive) provider call. Undefined = no cap.
   */
  budgetTokens?: number
  defaultSystem?: string
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
  /** Conversation so far, including the new user message as the last entry. */
  messages: ChatMessage[]
  system?: string
  signal?: AbortSignal
  /** Incremental assistant text, for live UI. */
  onText?: (delta: string) => void
  /** Tool lifecycle events, for live UI. */
  onEvent?: (event: AgentEvent) => void
  /** Gate each tool call; return false to deny. Defaults to approve-all (P2). */
  approve?: (request: ApprovalRequest) => boolean | Promise<boolean>
  /** Override the caller identity attached to tool invocations. */
  caller?: ToolCaller
}

export interface AgentRunResult {
  messages: ChatMessage[]
  stopReason: "end_turn" | "max_steps" | "aborted" | "budget_exceeded"
  usage: TokenUsage
}

export class AgentRuntime {
  constructor(private readonly options: AgentRuntimeOptions) {}

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const messages = [...options.messages]
    const model = this.options.model ?? DEFAULT_ANTHROPIC_MODEL
    const maxSteps = this.options.maxSteps ?? 10
    const maxTokens = this.options.maxTokens ?? 4096
    const budgetTokens = this.options.budgetTokens
    const system = options.system ?? this.options.defaultSystem ?? DEFAULT_SYSTEM_PROMPT
    let usage = emptyUsage()

    for (let step = 0; step < maxSteps; step++) {
      if (options.signal?.aborted) return { messages, stopReason: "aborted", usage }
      // Guard before starting another expensive turn (the first turn always runs).
      if (step > 0 && budgetTokens !== undefined && totalTokens(usage) >= budgetTokens) {
        return { messages, stopReason: "budget_exceeded", usage }
      }

      const tools = this.options.tools.list()
      let assistant: ChatMessage | undefined

      for await (const event of this.options.provider.stream({
        model,
        system,
        messages,
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

      const toolCalls = assistant.content.filter(isToolUse)
      if (toolCalls.length === 0) {
        return { messages, stopReason: "end_turn", usage }
      }

      const resultBlocks: ChatContentBlock[] = []
      for (const call of toolCalls) {
        options.onEvent?.({ type: "tool_call", id: call.id, name: call.name, input: call.input })
        resultBlocks.push(await this.runOneTool(call, options))
      }
      messages.push({ role: "user", content: resultBlocks })
    }

    return { messages, stopReason: "max_steps", usage }
  }

  private async runOneTool(
    call: { id: string; name: string; input: unknown },
    options: AgentRunOptions
  ): Promise<ChatContentBlock> {
    const approved = options.approve
      ? await options.approve({ toolName: call.name, input: call.input })
      : true
    if (!approved) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      return toolResult(call.id, "Tool call denied.", true)
    }

    try {
      const result = await this.options.tools.invoke(call.name, call.input, {
        caller: options.caller ?? { kind: "agent", conversationId: options.conversationId },
        signal: options.signal,
      })
      const isError = result.isError ?? false
      options.onEvent?.({ type: "tool_result", id: call.id, isError })
      return toolResult(call.id, renderToolResultText(result) || "(no output)", isError)
    } catch (err) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      return toolResult(call.id, err instanceof Error ? err.message : String(err), true)
    }
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
