import type { ChatMessage } from "../providers/types"
import { describe, expect, it, vi } from "vitest"
import {
  ContextCompressor,
  isSummaryMessage,
  SummarizeInfrastructureError,
} from "./context-compressor"

function user(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] }
}
function assistant(text: string): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }] }
}
function big(text: string, n: number): ChatMessage {
  return user(text.repeat(n))
}

function summarizer(summary = "SUMMARY") {
  return vi.fn(async () => ({ text: summary, tokens: 5 }))
}

describe("contextCompressor", () => {
  it("returns input unchanged when under threshold", async () => {
    const summarize = summarizer()
    const c = new ContextCompressor({ thresholdTokens: 1_000_000, summarize })
    const messages = [user("a"), assistant("b")]
    const out = await c.compress("SYS", messages)
    expect(out.messages).toEqual(messages)
    expect(out.evicted).toEqual([])
    expect(summarize).not.toHaveBeenCalled()
  })

  it("replaces older turns with one summary message when over threshold", async () => {
    const summarize = summarizer("recap")
    const c = new ContextCompressor({ thresholdTokens: 200, keepFraction: 0.5, summarize })
    const older = big("old ", 200)
    const recent1 = user("recent-1")
    const recent2 = assistant("recent-2")
    const messages = [older, recent1, recent2]
    const out = await c.compress("SYS", messages)

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(out.messages[0].content[0]).toMatchObject({ type: "text" })
    expect(JSON.stringify(out.messages[0])).toContain("recap")
    expect(out.messages).toContainEqual(user("recent-1"))
    expect(out.messages).toContainEqual(assistant("recent-2"))
    expect(out.summarizerTokens).toBe(5)
    expect(out.summaryText).toBe("recap")
    // evicted is the exact leading prefix that didn't survive — here just
    // `older`, by reference, in original order.
    expect(out.evicted).toEqual([older])
    expect(out.evicted[0]).toBe(older)
  })

  it("pulls the boundary back to include a whole tool_use/tool_result pair", async () => {
    const summarize = summarizer("recap")
    const c = new ContextCompressor({ thresholdTokens: 100, keepFraction: 0.5, summarize })
    const toolUse: ChatMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "n", input: {} }],
    }
    const toolResult: ChatMessage = {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "r", isError: false }],
    }
    const messages = [big("old ", 60), toolUse, toolResult, user("tail-recent")]
    const out = await c.compress("SYS", messages)

    const resultIds = new Set(
      out.messages.flatMap((m) =>
        m.content
          .filter((b) => b.type === "tool_result")
          .map((b) => (b as { toolUseId: string }).toolUseId)
      )
    )
    const useIds = new Set(
      out.messages.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id)
      )
    )
    for (const id of resultIds) expect(useIds.has(id)).toBe(true)
  })

  it("hard-trims when summary + recent still exceed the threshold", async () => {
    const longSummary = "S".repeat(4000)
    const summarize = vi.fn(async () => ({ text: longSummary, tokens: 5 }))
    const c = new ContextCompressor({ thresholdTokens: 300, keepFraction: 0.5, summarize })
    const messages = [big("old ", 400), big("recent-a ", 60), big("recent-b ", 60), user("tail")]
    const out = await c.compress("SYS", messages)

    expect(isSummaryMessage(out.messages[0])).toBe(true)
    expect(out.messages[out.messages.length - 1]).toEqual(user("tail"))
    expect(out.messages.length).toBeGreaterThanOrEqual(1)
    expect(out.messages.length).toBeLessThan(messages.length)
  })

  it("hard-trims to a safe user turn when summarize fails and recent is oversized", async () => {
    const summarize = vi.fn(async () => {
      throw new Error("provider down")
    })
    const c = new ContextCompressor({ thresholdTokens: 120, keepFraction: 0.5, summarize })
    const toolUse: ChatMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "n", input: {} }],
    }
    const toolResult: ChatMessage = {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "r", isError: false }],
    }
    const messages = [big("old ", 200), toolUse, toolResult, user("recent")]
    const out = await c.compress("SYS", messages)

    expect(out.messages[0].role).toBe("user")
    expect(
      isSummaryMessage(out.messages[0]) || out.messages[0].content.some((b) => b.type === "text")
    ).toBe(true)
    expect(out.messages).toContainEqual(user("recent"))
  })

  it("falls back to the recent window (no summary) when summarize throws", async () => {
    const summarize = vi.fn(async () => {
      throw new Error("provider down")
    })
    const c = new ContextCompressor({ thresholdTokens: 200, keepFraction: 0.5, summarize })
    const messages = [big("old ", 200), user("recent")]
    const out = await c.compress("SYS", messages)

    expect(out.messages).toContainEqual(user("recent"))
    expect(
      out.messages.every((m) => JSON.stringify(m).includes("old ") === false || m === messages[0])
    ).toBe(true)
    // Still evicted, and computeEvicted's reference-scan reports it, even
    // though no summary was produced for it.
    expect(out.evicted).toEqual([messages[0]])
  })

  it("reports the exact evicted prefix (including a hard-trimmed tool_use/tool_result pair) as `evicted`", async () => {
    const longSummary = "S".repeat(4000)
    const summarize = vi.fn(async () => ({ text: longSummary, tokens: 5 }))
    const c = new ContextCompressor({ thresholdTokens: 300, keepFraction: 0.5, summarize })
    const older = big("old ", 400)
    const recentA = big("recent-a ", 60)
    const recentB = big("recent-b ", 60)
    const tail = user("tail")
    const messages = [older, recentA, recentB, tail]
    const out = await c.compress("SYS", messages)

    expect(out.messages[out.messages.length - 1]).toEqual(tail)
    // Whatever hardTrim additionally dropped beyond `older` (recentA and/or
    // recentB) must show up in `evicted` too — it's real content that
    // didn't survive, regardless of which internal branch dropped it.
    expect(out.evicted[0]).toBe(older)
    expect(out.evicted.length).toBeGreaterThan(1)
    // evicted + kept-verbatim-tail must exactly reconstruct the original
    // input length (the synthetic summary message, if any, isn't part of
    // either count — it's neither original input nor evicted-from-input).
    const keptVerbatimCount = out.messages.length - (isSummaryMessage(out.messages[0]) ? 1 : 0)
    expect(out.evicted.length + keptVerbatimCount).toBe(messages.length)
  })

  it("propagates the original error when summarize throws SummarizeInfrastructureError, instead of silently hard-trimming", async () => {
    class FakeBudgetError extends Error {}
    const original = new FakeBudgetError("insufficient budget")
    const summarize = vi.fn(async () => {
      throw new SummarizeInfrastructureError("infra failure", { cause: original })
    })
    const c = new ContextCompressor({ thresholdTokens: 200, keepFraction: 0.5, summarize })
    const messages = [big("old ", 200), user("recent")]

    await expect(c.compress("SYS", messages)).rejects.toBe(original)
  })

  it("second round of compression evicts the prior synthetic summary along with newly-old real messages", async () => {
    let call = 0
    const summarize = vi.fn(async () => {
      call += 1
      return { text: `recap-${call}`, tokens: 5 }
    })
    const c = new ContextCompressor({ thresholdTokens: 200, keepFraction: 0.5, summarize })

    const round1Older = big("old ", 200)
    const round1Recent = user("recent-1")
    const first = await c.compress("SYS", [round1Older, round1Recent])
    expect(first.evicted).toEqual([round1Older])
    expect(isSummaryMessage(first.messages[0])).toBe(true)

    // Simulate the caller re-projecting: the round-1 synthetic summary is
    // fed back in as position 0 (as durable-agent-driver.ts's
    // projectCompactedMessages would build it), plus enough new real
    // content to exceed the threshold again.
    const priorSummary = first.messages[0]
    const round2New = big("new ", 200)
    const round2Recent = user("recent-2")
    const second = await c.compress("SYS", [priorSummary, round2New, round2Recent])

    expect(summarize).toHaveBeenCalledTimes(2)
    // The prior summary is always the leading element of whatever gets
    // evicted this round, since eviction only ever removes a leading
    // prefix and the synthetic summary is always at position 0.
    expect(second.evicted[0]).toBe(priorSummary)
    expect(second.evicted).toContainEqual(round2New)
    expect(second.messages).toContainEqual(round2Recent)
  })
})
