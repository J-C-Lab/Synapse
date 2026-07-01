import type { ChatMessage, ChatProvider } from "../providers/types"
import type { SummarizeResult } from "./context-compressor"
import { emptyUsage } from "../providers/types"

const SUMMARIZE_SYSTEM =
  "Summarize the following conversation excerpt into a compact set of facts, decisions, and open threads; preserve names, IDs, and any state the assistant will need to continue."

/** One provider call summarizing the older slice into a compact recap. */
export async function summarizeViaProvider(
  provider: ChatProvider,
  model: string,
  older: ChatMessage[]
): Promise<SummarizeResult> {
  const text = renderMessages(older)
  let summary = ""
  let tokens = 0
  for await (const event of provider.stream({
    model,
    system: SUMMARIZE_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: [],
    maxTokens: 1024,
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
