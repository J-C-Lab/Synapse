import type { AgentRunSnapshot } from "@synapse/agent-protocol"
import type { DisplayMessage, ToolCard } from "./chat-message-model"
import type { AiChatEvent, AiChatMessage } from "@/lib/electron"
import { describe, expect, it } from "vitest"
import {
  applyArtifactAvailability,
  applyEvent,
  flushTextIntoBlocks,
  hydrateMessages,
  mergeDurableRunSnapshot,
} from "./chat-message-model"

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

  it("carries the bounded artifact summary from a tool_result onto its tool card", () => {
    const stored: AiChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "act", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: "preview...",
            artifact: {
              uri: "artifact://run/run-1/a1",
              kind: "tool-result",
              mediaType: "text/plain",
              capturedBytes: 5000,
              complete: false,
              truncationReason: "artifact-limit",
            },
          },
        ],
      },
    ]
    const card = hydrateMessages(stored)[0]?.blocks[0] as ToolCard
    expect(card.artifact).toEqual({
      uri: "artifact://run/run-1/a1",
      kind: "tool-result",
      mediaType: "text/plain",
      capturedBytes: 5000,
      complete: false,
      truncationReason: "artifact-limit",
    })
    expect(card.artifactAvailability).toBeUndefined()
  })

  it("leaves artifact undefined for a tool_result with no offloaded artifact", () => {
    const stored: AiChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "act", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
    ]
    const card = hydrateMessages(stored)[0]?.blocks[0] as ToolCard
    expect(card.artifact).toBeUndefined()
  })
})

describe("applyArtifactAvailability", () => {
  function withArtifactCard(uri: string): DisplayMessage[] {
    return [
      {
        id: "a1",
        role: "assistant",
        blocks: [
          {
            kind: "tool",
            id: "t1",
            name: "act",
            input: {},
            status: "success",
            artifact: {
              uri,
              kind: "tool-result",
              mediaType: "text/plain",
              capturedBytes: 10,
              complete: true,
            },
          },
        ],
      },
    ]
  }

  it("sets availability on every card whose artifact.uri matches", () => {
    const messages = withArtifactCard("artifact://run/run-1/a1")
    const next = applyArtifactAvailability(messages, "artifact://run/run-1/a1", "available")
    expect((next[0]?.blocks[0] as ToolCard).artifactAvailability).toBe("available")
  })

  it("leaves a card with a different artifact uri untouched", () => {
    const messages = withArtifactCard("artifact://run/run-1/a1")
    const next = applyArtifactAvailability(
      messages,
      "artifact://run/run-1/other",
      "artifact_expired"
    )
    expect((next[0]?.blocks[0] as ToolCard).artifactAvailability).toBeUndefined()
  })

  it("leaves a text-only card untouched", () => {
    const messages: DisplayMessage[] = [
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "hi" }] },
    ]
    expect(applyArtifactAvailability(messages, "artifact://run/run-1/a1", "available")).toEqual(
      messages
    )
  })

  it("is idempotent-safe to apply a terminal status a second time (never regresses to checking)", () => {
    const messages = withArtifactCard("artifact://run/run-1/a1")
    const first = applyArtifactAvailability(
      messages,
      "artifact://run/run-1/a1",
      "artifact_forbidden"
    )
    const second = applyArtifactAvailability(first, "artifact://run/run-1/a1", "artifact_forbidden")
    expect((second[0]?.blocks[0] as ToolCard).artifactAvailability).toBe("artifact_forbidden")
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

describe("durable snapshot rehydration", () => {
  const snapshot: AgentRunSnapshot = {
    identity: { runId: "run-1", rootRunId: "run-1", origin: "interactive", conversationId: "c1" },
    status: "waiting_approval",
    recovery: { kind: "automatic" },
    lastSequence: 12,
    createdAt: 1,
    updatedAt: 2,
    pendingApprovalIds: ["approval-1"],
    childTasks: [],
    artifacts: [],
    messages: [],
    toolCalls: [
      {
        ordinal: 0,
        modelStep: 0,
        toolUseId: "tool-1",
        safeName: "read_file",
        fqName: "read_file",
        status: "pending_approval",
      },
    ],
  }

  it("rehydrates an in-flight tool card exactly once across a snapshot and duplicate live event", () => {
    const restored = mergeDurableRunSnapshot(startingState(), snapshot)
    const afterDuplicate = applyEvent(restored, {
      type: "tool_call",
      conversationId: CONVERSATION_ID,
      id: "tool-1",
      name: "read_file",
      input: { path: "secret" },
    })

    const cards = afterDuplicate.flatMap((message) =>
      message.blocks.filter((block) => block.kind === "tool" && block.id === "tool-1")
    )
    expect(cards).toEqual([
      { kind: "tool", id: "tool-1", name: "read_file", input: {}, status: "running" },
    ])
  })

  it("updates the rehydrated card when a later durable snapshot resolves it", () => {
    const restored = mergeDurableRunSnapshot(startingState(), snapshot)
    const completed = mergeDurableRunSnapshot(restored, {
      ...snapshot,
      toolCalls: [{ ...snapshot.toolCalls[0]!, status: "completed", isError: true }],
    })
    expect(completed.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({ kind: "tool", id: "tool-1", status: "error" })
    )
  })

  it("merges a later tool from the same model step into the existing durable step message", () => {
    const first = mergeDurableRunSnapshot([], {
      ...snapshot,
      messages: [
        {
          messageId: "assistant-1",
          producedByRunId: "run-1",
          role: "assistant",
          ordinal: 1,
          text: "I will inspect both files.",
        },
      ],
      toolCalls: [{ ...snapshot.toolCalls[0]!, assistantMessageId: "assistant-1" }],
    })
    const merged = mergeDurableRunSnapshot(first, {
      ...snapshot,
      messages: [
        {
          messageId: "assistant-1",
          producedByRunId: "run-1",
          role: "assistant",
          ordinal: 1,
          text: "I will inspect both files.",
        },
      ],
      toolCalls: [
        { ...snapshot.toolCalls[0]!, assistantMessageId: "assistant-1" },
        {
          ...snapshot.toolCalls[0]!,
          ordinal: 1,
          toolUseId: "tool-2",
          safeName: "list_files",
          fqName: "list_files",
          assistantMessageId: "assistant-1",
        },
      ],
    })

    expect(merged).toHaveLength(1)
    expect(merged[0]?.id).toBe("durable-run:run-1:step:0")
    expect(merged[0]?.blocks).toEqual([
      { kind: "text", text: "I will inspect both files." },
      { kind: "tool", id: "tool-1", name: "read_file", input: {}, status: "running" },
      { kind: "tool", id: "tool-2", name: "list_files", input: {}, status: "running" },
    ])
  })

  it("restores persisted in-flight assistant text even when the turn has no tool card", () => {
    const restored = mergeDurableRunSnapshot([], {
      ...snapshot,
      status: "running",
      messages: [
        {
          messageId: "assistant-1",
          producedByRunId: "run-1",
          role: "assistant",
          ordinal: 1,
          text: "Recovered answer before final commit.",
        },
      ],
      toolCalls: [],
    })
    expect(restored).toEqual([
      {
        id: "durable-run:run-1:message:assistant-1",
        role: "assistant",
        blocks: [{ kind: "text", text: "Recovered answer before final commit." }],
      },
    ])
  })
})
