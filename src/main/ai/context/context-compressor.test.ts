import type { ChatMessage } from "../providers/types"
import { describe, expect, it, vi } from "vitest"
import { ContextCompressor, isSummaryMessage } from "./context-compressor"

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
    expect(summarize).not.toHaveBeenCalled()
  })

  it("replaces older turns with one summary message when over threshold", async () => {
    const summarize = summarizer("recap")
    const c = new ContextCompressor({ thresholdTokens: 200, keepFraction: 0.5, summarize })
    const messages = [big("old ", 200), user("recent-1"), assistant("recent-2")]
    const out = await c.compress("SYS", messages)

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(out.messages[0].content[0]).toMatchObject({ type: "text" })
    expect(JSON.stringify(out.messages[0])).toContain("recap")
    expect(out.messages).toContainEqual(user("recent-1"))
    expect(out.messages).toContainEqual(assistant("recent-2"))
    expect(out.summarizerTokens).toBe(5)
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
  })
})
