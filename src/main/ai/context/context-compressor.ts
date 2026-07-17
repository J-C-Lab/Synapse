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
  /** The exact leading prefix of the `messages` array passed to `compress()`
   *  that did not survive into the result, in original order — empty when
   *  nothing needed evicting. Computed structurally (see the reference-scan
   *  note on `computeEvicted` below), not by re-deriving eviction logic, so
   *  it stays correct across every internal branch (summarized, hard-trimmed,
   *  or a mix of both). Callers that need durable recoverability (Task 20's
   *  history-artifact capture) read this rather than diffing themselves. */
  evicted: ChatMessage[]
  summarizerTokens: number
  /** The raw summarizer output for this call, before the `SUMMARY_PREFIX`
   *  envelope was applied — present only when `summarize()` was actually
   *  invoked and succeeded this call. A durable caller that wants to embed
   *  extra guidance (e.g. an artifact URI) into the final summary text reads
   *  this rather than re-parsing `messages[0]`. */
  summaryText?: string
}

/** Thrown by a `summarize` callback to signal an infrastructure failure
 *  (budget admission, provider dispatch) that must propagate to the caller
 *  of `compress()` rather than being silently absorbed into the
 *  hard-trim-without-summary fallback. Any other thrown error is still
 *  treated as "summarization declined for this content" and falls back to
 *  hard-trimming — preserving this module's original graceful-degradation
 *  behavior for callers that don't distinguish failure causes. `compress()`
 *  unwraps and rethrows `cause` when set, so an upstream `instanceof` check
 *  against the original error type (e.g. `InsufficientBudgetError`) keeps
 *  working transparently through this wrapper. */
export class SummarizeInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "SummarizeInfrastructureError"
  }
}

export class ContextCompressor {
  constructor(private readonly options: ContextCompressorOptions) {}

  async compress(system: string, messages: ChatMessage[]): Promise<CompressResult> {
    const threshold = this.options.thresholdTokens
    const systemTokens = estimateTextTokens(system)
    const estimate = systemTokens + estimateMessagesTokens(messages)
    if (estimate <= threshold) return finalize(messages, messages, 0)

    const keepBudget = threshold * (this.options.keepFraction ?? 0.5)
    const splitAt = this.recentStartIndex(messages, keepBudget)
    const older = messages.slice(0, splitAt)
    const recent = messages.slice(splitAt)
    if (older.length === 0) {
      return finalize(messages, this.hardTrim(system, recent), 0)
    }

    try {
      const summary = await this.options.summarize(older)
      const out = [summaryMessage(summary.text), ...recent]
      return finalize(messages, this.hardTrim(system, out), summary.tokens, summary.text)
    } catch (err) {
      if (err instanceof SummarizeInfrastructureError) throw err.cause ?? err
      return finalize(messages, this.hardTrim(system, recent), 0)
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

function finalize(
  original: ChatMessage[],
  out: ChatMessage[],
  summarizerTokens: number,
  summaryText?: string
): CompressResult {
  return { messages: out, evicted: computeEvicted(original, out), summarizerTokens, summaryText }
}

/** Almost every internal path (recentStartIndex + hardTrim's cascading
 *  front-trims) preserves every kept message by reference — never a copy or
 *  a rebuilt object — and only ever removes from the front or prepends one
 *  freshly constructed synthetic summary message. That makes the kept
 *  portion of `out` an exact, reference-identical suffix of `original`, and
 *  a backward scan comparing the two by reference finds precisely where
 *  that suffix begins without needing to know which branch produced `out`.
 *
 *  One case breaks that suffix property: `hardTrim`'s `summaryAtFront`
 *  branch pins `original[0]` (an already-summarized message from an earlier
 *  compaction round, reference-identical, never rebuilt) while removing
 *  interior elements right after it — a preserved head plus a preserved
 *  tail with an evicted gap in between, not a leading prefix at all. There
 *  is no way to represent "the middle was evicted" as the leading-prefix
 *  slice this function promises (and that durable-agent-driver.ts's
 *  positional un-prefixing of `evicted` depends on): reporting `original[0]`
 *  as evicted would be an outright contradiction (it demonstrably survived,
 *  unchanged, in `out[0]`), and reporting the interior gap as a fabricated
 *  "leading prefix" would misattribute it to the wrong messages downstream.
 *  So when the backward scan cannot fully consume `out` but `out[0]` is
 *  still reference-identical to `original[0]`, nothing new is reported as
 *  evicted this round — the caller sees an unchanged compaction and simply
 *  tries again once there is genuinely new content to summarize. */
function computeEvicted(original: ChatMessage[], out: ChatMessage[]): ChatMessage[] {
  let kept = 0
  let i = out.length - 1
  const j0 = original.length - 1
  for (let j = j0; i >= 0 && j >= 0; i--, j--) {
    if (out[i] !== original[j]) break
    kept++
  }
  if (i === 0 && out.length > 0 && original.length > 0 && out[0] === original[0]) {
    return []
  }
  return original.slice(0, original.length - kept)
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
