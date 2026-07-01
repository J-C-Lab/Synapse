import type { ChatMessage, ChatProvider } from "../providers/types"
import type { RunTrace } from "../run-trace-store"
import type { AiToolRegistry } from "../tool-registry"
import { randomUUID } from "node:crypto"
import { AgentRuntime } from "../agent-runtime"

const SUMMARY_MAX = 2000

/** Subagents execute a delegated slice — no further planning or delegation. */
export const SUBAGENT_SYSTEM_PROMPT =
  "You are executing a delegated subtask. Complete it directly using the tools you have. " +
  "Do not spawn subagents or update the task plan — focus on the instruction and return a concise result."

export interface SubagentRunInput {
  parentRunId: string
  parentConversationId: string
  instruction: string
  tools: AiToolRegistry
  maxSteps: number
  budgetTokens?: number
  signal?: AbortSignal
}

export interface SubagentRunResult {
  summary: string
  childRunId: string
  outcome: RunTrace["outcome"]
}

export interface SubagentRunnerOptions {
  provider: ChatProvider
  model?: string
  recordRun?: (trace: RunTrace) => void
}

export class SubagentRunner {
  constructor(private readonly options: SubagentRunnerOptions) {}

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const childRunId = randomUUID()
    const runtime = new AgentRuntime({
      provider: this.options.provider,
      tools: input.tools,
      model: this.options.model,
      maxSteps: input.maxSteps,
      budgetTokens: input.budgetTokens,
      recordRun: this.options.recordRun,
      defaultSystem: SUBAGENT_SYSTEM_PROMPT,
      shellEnabled: false,
    })

    const result = await runtime.run({
      conversationId: input.parentConversationId,
      messages: [subUserMessage(input.instruction)],
      signal: input.signal,
      runId: childRunId,
      origin: "subagent",
      parentRunId: input.parentRunId,
      caller: {
        kind: "subagent",
        conversationId: input.parentConversationId,
        runId: childRunId,
        parentRunId: input.parentRunId,
      },
    })

    return {
      summary: summarize(result.messages, result.stopReason),
      childRunId,
      outcome: result.stopReason,
    }
  }
}

function subUserMessage(instruction: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text: instruction }] }
}

function summarize(messages: ChatMessage[], stopReason: string): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant")
  const text =
    last?.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() ?? ""
  const body = text.slice(0, SUMMARY_MAX)
  if (stopReason === "end_turn") return body || "(subtask produced no text)"
  return `${body}\n\n[subtask stopped: ${stopReason}]`.trim()
}
