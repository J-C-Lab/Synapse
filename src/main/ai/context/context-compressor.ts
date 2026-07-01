import type { ChatMessage } from "../providers/types"
import { estimateMessagesTokens, estimateTextTokens } from "./estimate-tokens"

// Fits the active conversation into the model window between turns. Lossless at
// the store layer — operates on a copy of the outgoing messages only. Never
// splits a tool_use/tool_result pair; system prompt is never summarized.

export const SUMMARY_PREFIX = "[Earlier conversation summary]"

export interface SummarizeResult {
  text: string
  tokens: number
}

export interface ContextCompressorOptions {
  thresholdTokens: number
  /** Fraction of threshold to preserve verbatim as recent turns. Default 0.5. */
  keepFraction?: number
  summarize: (older: ChatMessage[]) => Promise<SummarizeResult>
}

export interface CompressResult {
  messages: ChatMessage[]
  summarizerTokens: number
}

export class ContextCompressor {
  constructor(private readonly options: ContextCompressorOptions) {}

  async compress(system: string, messages: ChatMessage[]): Promise<CompressResult> {
    const threshold = this.options.thresholdTokens
    const systemTokens = estimateTextTokens(system)
    const estimate = systemTokens + estimateMessagesTokens(messages)
    if (estimate <= threshold) return { messages, summarizerTokens: 0 }

    const keepBudget = threshold * (this.options.keepFraction ?? 0.5)
    const splitAt = this.recentStartIndex(messages, keepBudget)
    const older = messages.slice(0, splitAt)
    const recent = messages.slice(splitAt)
    if (older.length === 0) {
      return { messages: this.hardTrim(system, recent), summarizerTokens: 0 }
    }

    try {
      const summary = await this.options.summarize(older)
      const out = [summaryMessage(summary.text), ...recent]
      return {
        messages: this.hardTrim(system, out),
        summarizerTokens: summary.tokens,
      }
    } catch {
      return { messages: this.hardTrim(system, recent), summarizerTokens: 0 }
    }
  }

  private hardTrim(system: string, messages: ChatMessage[]): ChatMessage[] {
    const threshold = this.options.thresholdTokens
    const systemTokens = estimateTextTokens(system)
    let out = messages

    while (systemTokens + estimateMessagesTokens(out) > threshold && out.length > 0) {
      const summaryAtFront = out.length > 0 && isSummaryMessage(out[0])
      const trimIdx = summaryAtFront ? 1 : 0
      const minLength = summaryAtFront ? 1 : 0

      if (out.length <= minLength + 1) break

      out = [...out.slice(0, trimIdx), ...out.slice(trimIdx + 1)]

      while (trimIdx < out.length && hasToolResult(out[trimIdx])) {
        out = [...out.slice(0, trimIdx), ...out.slice(trimIdx + 1)]
      }

      if (!summaryAtFront) {
        while (out.length > 1 && !isSafeTurnStart(out[0])) {
          out = out.slice(1)
        }
      }

      if (out.length <= minLength + (summaryAtFront ? 0 : 1)) break
    }

    return ensureSafeStart(out)
  }

  private recentStartIndex(messages: ChatMessage[], keepBudget: number): number {
    let used = 0
    let start = messages.length
    for (let i = messages.length - 1; i >= 0; i--) {
      used += estimateMessagesTokens([messages[i]])
      if (used > keepBudget) break
      start = i
    }
    while (start > 0 && hasToolResult(messages[start])) start--
    return start
  }
}

function hasToolResult(message: ChatMessage): boolean {
  return message.content.some((b) => b.type === "tool_result")
}

export function isSummaryMessage(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    message.content.some((b) => b.type === "text" && b.text.startsWith(SUMMARY_PREFIX))
  )
}

function isSafeTurnStart(message: ChatMessage): boolean {
  if (message.role !== "user") return false
  if (isSummaryMessage(message)) return true
  if (hasToolResult(message) && !message.content.some((b) => b.type === "text")) return false
  return message.content.some((b) => b.type === "text")
}

function summaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `${SUMMARY_PREFIX}\n${summary}` }],
  }
}

function ensureSafeStart(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages
  if (isSummaryMessage(messages[0])) {
    const recent = trimLeadingUnsafe(messages.slice(1))
    return recent.length > 0 ? [messages[0], ...recent] : [messages[0]]
  }
  return trimLeadingUnsafe(messages)
}

function trimLeadingUnsafe(messages: ChatMessage[]): ChatMessage[] {
  let out = messages
  while (out.length > 1 && !isSafeTurnStart(out[0])) {
    out = out.slice(1)
  }
  while (out.length > 1 && hasToolResult(out[0]) && !isSafeTurnStart(out[0])) {
    out = out.slice(1)
  }
  return out
}
