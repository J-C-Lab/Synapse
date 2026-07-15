import type { ChatMessage } from "../providers/types"
import { describe, expect, it } from "vitest"
import { deriveArtifactUris, toChatMessages, toDurableMessages } from "./durable-messages"

function textMessage(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: [{ type: "text", text }] }
}

describe("toDurableMessages", () => {
  it("assigns a stable messageId to every message when there is no prior history", () => {
    const durable = toDurableMessages([], [textMessage("user", "hi")])
    expect(durable).toHaveLength(1)
    expect(durable[0]?.messageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(durable[0]?.message).toEqual(textMessage("user", "hi"))
  })

  it("preserves prior messageIds unchanged and only assigns ids to newly appended messages", () => {
    const first = toDurableMessages([], [textMessage("user", "hi")])
    const second = toDurableMessages(first, [
      textMessage("user", "hi"),
      textMessage("assistant", "hello"),
    ])

    expect(second).toHaveLength(2)
    expect(second[0]?.messageId).toBe(first[0]?.messageId)
    expect(second[1]?.messageId).not.toBe(first[0]?.messageId)
  })

  it("never regenerates an id for an unchanged prefix across repeated calls", () => {
    const first = toDurableMessages([], [textMessage("user", "hi")])
    const secondCallSameInput = toDurableMessages(first, [textMessage("user", "hi")])
    expect(secondCallSameInput[0]?.messageId).toBe(first[0]?.messageId)
  })

  it("tags newly appended messages with the producing run id", () => {
    const durable = toDurableMessages([], [textMessage("user", "hi")], "run-1")
    expect(durable[0]?.producedByRunId).toBe("run-1")
  })

  it("throws if the new history is shorter than the previous durable history", () => {
    const first = toDurableMessages([], [textMessage("user", "a"), textMessage("assistant", "b")])
    expect(() => toDurableMessages(first, [textMessage("user", "a")])).toThrow(/may not shrink/)
  })
})

describe("toChatMessages", () => {
  it("round-trips back to plain ChatMessage[]", () => {
    const messages = [textMessage("user", "hi"), textMessage("assistant", "hello")]
    const durable = toDurableMessages([], messages)
    expect(toChatMessages(durable)).toEqual(messages)
  })
})

describe("deriveArtifactUris", () => {
  it("returns no uris for ordinary text/tool messages", () => {
    const durable = toDurableMessages([], [textMessage("user", "hi")])
    expect(deriveArtifactUris(durable)).toEqual([])
  })

  it("collects and dedupes artifact uris carried on tool_result blocks", () => {
    const durable = toDurableMessages(
      [],
      [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t1",
              content: "preview",
              artifact: { uri: "artifact://run/r1/a1" },
            } as never,
            {
              type: "tool_result",
              toolUseId: "t2",
              content: "preview2",
              artifact: { uri: "artifact://run/r1/a2" },
            } as never,
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t3",
              content: "preview3",
              artifact: { uri: "artifact://run/r1/a1" },
            } as never,
          ],
        },
      ]
    )

    expect(deriveArtifactUris(durable)).toEqual(["artifact://run/r1/a1", "artifact://run/r1/a2"])
  })
})
