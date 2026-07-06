import type { ChatMessage } from "../providers/types"
import { describe, expect, it } from "vitest"
import {
  assistantMessage,
  compactHistory,
  hasAlternatingRoles,
  prependCompactionSummary,
  userMessage,
} from "./history-compactor"

describe("compactHistory", () => {
  it("preserves alternating roles when compacting a realistic conversation", () => {
    const messages = [
      userMessage(`older turn ${"a".repeat(4_000)}`),
      assistantMessage([{ type: "text", text: "reply one" }]),
      userMessage(`middle turn ${"b".repeat(4_000)}`),
      assistantMessage([{ type: "text", text: "reply two" }]),
      userMessage("latest user question"),
    ]

    const compacted = compactHistory(messages, { maxChars: 7_000 })

    expect(compacted.compacted).toBe(true)
    expect(hasAlternatingRoles(compacted.messages)).toBe(true)
    const latestText = compacted.messages
      .at(-1)
      ?.content.find((block) => block.type === "text" && block.text === "latest user question")
    expect(latestText).toBeDefined()
    const summaryBlock = compacted.messages.at(-1)?.content[0]
    expect(summaryBlock).toMatchObject({ text: expect.stringContaining("Synapse compacted") })
  })

  it("merges the compaction summary into the tail user message instead of adding a second user turn", () => {
    const messages = [
      userMessage(`older ${"x".repeat(5_000)}`),
      assistantMessage([{ type: "text", text: "ok" }]),
      userMessage("latest user question"),
    ]

    const compacted = compactHistory(messages, { maxChars: 4_000 })

    expect(compacted.compacted).toBe(true)
    expect(compacted.messages).toHaveLength(1)
    expect(hasAlternatingRoles(compacted.messages)).toBe(true)
    expect(compacted.messages[0]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Synapse compacted"),
    })
    expect(compacted.messages[0]?.content[1]).toMatchObject({
      type: "text",
      text: "latest user question",
    })
  })

  it("keeps a trailing tool exchange intact when it is preserved in the tail", () => {
    const messages = [
      userMessage(`older ${"x".repeat(5_000)}`),
      assistantMessage([{ type: "text", text: "working on it" }]),
      userMessage(`follow up ${"y".repeat(4_000)}`),
      assistantMessage([{ type: "tool_use", id: "t1", name: "demo", input: {} }]),
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, toolUseId: "t1", content: "tool output" }],
      } satisfies ChatMessage,
    ]

    const compacted = compactHistory(messages, { maxChars: 6_000 })

    expect(compacted.compacted).toBe(true)
    expect(hasAlternatingRoles(compacted.messages)).toBe(true)
    expect(
      compacted.messages.some((message) =>
        message.content.some((block) => block.type === "tool_result")
      )
    ).toBe(true)
    expect(
      compacted.messages.some((message) =>
        message.content.some((block) => block.type === "tool_use")
      )
    ).toBe(true)
  })

  it("prepends a standalone user summary when the preserved tail starts with assistant", () => {
    const tail = [
      assistantMessage([{ type: "tool_use", id: "t1", name: "demo", input: {} }]),
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, toolUseId: "t1", content: "tool output" }],
      },
    ]

    const merged = prependCompactionSummary(tail, "[Synapse compacted earlier context]")

    expect(merged).toHaveLength(3)
    expect(hasAlternatingRoles(merged)).toBe(true)
    expect(merged[0]?.role).toBe("user")
    expect(merged[1]?.role).toBe("assistant")
    expect(merged[2]?.role).toBe("user")
  })
})
