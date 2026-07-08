import type { DisplayMessage } from "./chat-message-model"
import type { AiChatEvent, AiChatMessage } from "@/lib/electron"
import { describe, expect, it } from "vitest"
import { applyEvent, flushTextIntoBlocks, hydrateMessages } from "./chat-message-model"

describe("hydrateMessages", () => {
  it("rebuilds user and assistant bubbles with tool cards, in original order", () => {
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
    expect(messages.map((message) => [message.role, message.blocks])).toEqual([
      ["user", [{ kind: "text", text: "do it" }]],
      [
        "assistant",
        [
          { kind: "text", text: "on it" },
          { kind: "tool", id: "t1", name: "com_x_act", input: { a: 1 }, status: "success" },
        ],
      ],
      ["assistant", [{ kind: "text", text: "done" }]],
    ])
  })

  it("preserves order when a tool call precedes its trailing text within one turn", () => {
    const stored: AiChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "act", input: {} },
          { type: "text", text: "here's the result" },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
    ]

    const messages = hydrateMessages(stored)
    expect(messages[0]?.blocks.map((b) => b.kind)).toEqual(["tool", "text"])
  })

  it("merges adjacent text blocks into one paragraph", () => {
    const stored: AiChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    ]
    const messages = hydrateMessages(stored)
    expect(messages[0]?.blocks).toEqual([{ kind: "text", text: "part one part two" }])
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
    const blocks = hydrateMessages(stored)[0]?.blocks
    expect(blocks?.[0]).toMatchObject({ kind: "tool", status: "error" })
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

const CONVERSATION_ID = "c1"

/** Mirrors chat-page.tsx's handleEvent sequencing: text deltas accumulate, everything else flushes them first. */
function replay(messages: DisplayMessage[], events: AiChatEvent[]): DisplayMessage[] {
  let pending = ""
  let state = messages
  for (const event of events) {
    if (event.type === "text") {
      pending += event.delta
      continue
    }
    const lastIndex = state.length - 1
    const last = state[lastIndex]
    if (pending && last?.role === "assistant") {
      const next = state.slice()
      next[lastIndex] = { ...last, blocks: flushTextIntoBlocks(last.blocks, pending) }
      state = next
    }
    pending = ""
    state = applyEvent(state, event)
  }
  return state
}

function startingState(): DisplayMessage[] {
  return [
    { id: "u1", role: "user", blocks: [{ kind: "text", text: "go" }] },
    { id: "a1", role: "assistant", blocks: [] },
  ]
}

describe("live-streaming event ordering", () => {
  it("interleaves text and tool blocks in the order events actually arrive across multiple agent-loop steps", () => {
    const events: AiChatEvent[] = [
      { type: "text", conversationId: CONVERSATION_ID, delta: "checking the repo" },
      {
        type: "tool_call",
        conversationId: CONVERSATION_ID,
        id: "t1",
        name: "list_files",
        input: {},
      },
      { type: "tool_result", conversationId: CONVERSATION_ID, id: "t1", isError: false },
      { type: "text", conversationId: CONVERSATION_ID, delta: "found it, reading now" },
      {
        type: "tool_call",
        conversationId: CONVERSATION_ID,
        id: "t2",
        name: "read_file",
        input: {},
      },
      { type: "tool_result", conversationId: CONVERSATION_ID, id: "t2", isError: false },
      { type: "text", conversationId: CONVERSATION_ID, delta: "done" },
      {
        type: "done",
        conversationId: CONVERSATION_ID,
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]

    const result = replay(startingState(), events)
    const assistant = result[1]
    expect(assistant?.blocks.map((b) => (b.kind === "text" ? b.text : b.id))).toEqual([
      "checking the repo",
      "t1",
      "found it, reading now",
      "t2",
      "done",
    ])
    expect(assistant?.blocks.map((b) => b.kind)).toEqual(["text", "tool", "text", "tool", "text"])
  })

  it("marks the right tool block as errored without disturbing block order", () => {
    const events: AiChatEvent[] = [
      {
        type: "tool_call",
        conversationId: CONVERSATION_ID,
        id: "t1",
        name: "run_command",
        input: {},
      },
      { type: "tool_result", conversationId: CONVERSATION_ID, id: "t1", isError: true },
    ]
    const result = replay(startingState(), events)
    expect(result[1]?.blocks).toEqual([
      { kind: "tool", id: "t1", name: "run_command", input: {}, status: "error" },
    ])
  })

  it("appends an error as a new paragraph after existing text, not glued onto it", () => {
    const events: AiChatEvent[] = [
      { type: "text", conversationId: CONVERSATION_ID, delta: "working on it" },
      { type: "error", conversationId: CONVERSATION_ID, message: "connection lost" },
    ]
    const result = replay(startingState(), events)
    expect(result[1]?.blocks).toEqual([
      { kind: "text", text: "working on it\n\n⚠️ connection lost" },
    ])
  })
})
