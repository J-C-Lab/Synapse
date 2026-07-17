import type { ChatMessage, ChatProvider, RequestEstimateInput } from "../providers/types"
import type { SummarizeResult } from "./context-compressor"
import { emptyUsage } from "../providers/types"

// One provider call summarizing the older slice into a compact recap. Pure
// request-building + dispatch — no budget-ledger concerns at all. Durable
// admission/settlement for this call is owned by durable-agent-driver.ts's
// runCompressionAttempt (design §"Charge summarizer model requests through
// the same admission/settlement contract"), mirroring how
// model-step-runner.ts's callProviderAndStage is a pure provider call kept
// separate from holdAttempt/settleAttempt's ledger bookkeeping.

export const SUMMARIZE_SYSTEM =
  "Summarize the following conversation excerpt into a compact set of facts, decisions, and open threads; preserve names, IDs, and any state the assistant will need to continue."

export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 1024

/** The exact request shape a summarizer call is built from — reused for
 *  both the pre-dispatch upper-bound estimate (`provider.
 *  estimateRequestUpperBound`) and the real dispatch below, so admission is
 *  never computed against a smaller payload than what's actually sent
 *  (mirrors model-step-runner.ts's outgoingRequestContext discipline). */
export function summarizerRequestEstimateInput(
  model: string,
  older: ChatMessage[],
  maxOutputTokens: number = DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS
): RequestEstimateInput {
  return {
    model,
    systemText: SUMMARIZE_SYSTEM,
    messages: summarizerRequestMessages(older),
    tools: [],
    maxOutputTokens,
  }
}

function summarizerRequestMessages(older: ChatMessage[]): ChatMessage[] {
  return [{ role: "user", content: [{ type: "text", text: renderMessages(older) }] }]
}

/** One provider call summarizing the older slice into a compact recap. No
 *  budget admission/settlement here — the caller is responsible for that
 *  (see this file's top-of-file note). */
export async function summarizeViaProvider(
  provider: ChatProvider,
  model: string,
  older: ChatMessage[],
  maxOutputTokens: number = DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS
): Promise<SummarizeResult> {
  let summary = ""
  let tokens = 0
  for await (const event of provider.stream({
    model,
    system: SUMMARIZE_SYSTEM,
    messages: summarizerRequestMessages(older),
    tools: [],
    maxTokens: maxOutputTokens,
  })) {
    if (event.type === "text") summary += event.text
    else {
      summary =
        event.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n") || summary
      tokens = event.usage.outputTokens + event.usage.inputTokens
    }
  }
  if (tokens === 0) tokens = Math.ceil(summary.length / 4)
  return { text: summary.trim() || "(no summary)", tokens }
}

function renderMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const body = m.content
        .map((b) => {
          if (b.type === "text") return b.text
          return `[${b.type}]`
        })
        .join(" ")
      return `${m.role}: ${body}`
    })
    .join("\n\n")
}

// Exported for tests that need empty usage shape.
export { emptyUsage }
