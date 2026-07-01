import type { ChatMessage } from "../providers/types"
import { describe, expect, it } from "vitest"
import { estimateMessagesTokens, estimateMessageTokens } from "./estimate-tokens"

function textMsg(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

describe("estimateTokens", () => {
  it("grows monotonically with text length", () => {
    const short = estimateMessageTokens(textMsg("hi"))
    const long = estimateMessageTokens(textMsg("hi".repeat(500)))
    expect(long).toBeGreaterThan(short)
  })

  it("adds structural overhead for non-text blocks", () => {
    const plain = estimateMessageTokens(textMsg("x"))
    const withTool: ChatMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "n", input: {} }],
    }
    expect(estimateMessageTokens(withTool)).toBeGreaterThanOrEqual(plain)
  })

  it("sums a list", () => {
    const total = estimateMessagesTokens([textMsg("aaaa"), textMsg("bbbb")])
    expect(total).toBe(
      estimateMessageTokens(textMsg("aaaa")) + estimateMessageTokens(textMsg("bbbb"))
    )
  })
})
