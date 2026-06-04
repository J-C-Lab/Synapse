import type { AiChatMessage } from "@/lib/electron"
import { describe, expect, it } from "vitest"
import { hydrateMessages } from "./chat-message-model"

describe("hydrateMessages", () => {
  it("rebuilds user and assistant bubbles with tool cards", () => {
    const stored: AiChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "t1", name: "com_x_act", input: { a: 1 } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]

    const messages = hydrateMessages(stored)
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "do it"],
      ["assistant", "on it"],
      ["assistant", "done"],
    ])
    // The tool_result-only user turn produced no bubble, just updated the card.
    expect(messages[1]?.tools).toEqual([
      { id: "t1", name: "com_x_act", input: { a: 1 }, status: "success" },
    ])
  })

  it("marks a tool card as error from its tool_result", () => {
    const stored: AiChatMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "act", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "boom", isError: true }],
      },
    ]
    expect(hydrateMessages(stored)[0]?.tools[0]?.status).toBe("error")
  })

  it("does not emit a bubble for a tool-result-only user turn", () => {
    const stored: AiChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "act", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
    ]
    const messages = hydrateMessages(stored)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe("assistant")
  })
})
