import type Anthropic from "@anthropic-ai/sdk"
import type { AnthropicMessagesClient, AnthropicMessageStream } from "./anthropic-provider"
import type { ProviderRequest, ProviderStreamEvent } from "./types"
import { describe, expect, it } from "vitest"
import {
  AnthropicProvider,
  buildMessageParams,
  fromAnthropicMessage,
  fromAnthropicUsage,
} from "./anthropic-provider"

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "claude-opus-4-8",
    system: "You are helpful.",
    maxTokens: 1024,
    tools: [
      {
        name: "greet",
        description: "Greet",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
      },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...overrides,
  }
}

describe("buildMessageParams", () => {
  it("puts a cache breakpoint on the system block and the last message", () => {
    const params = buildMessageParams(request())
    const system = params.system as Anthropic.TextBlockParam[]
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" })

    const lastMessage = params.messages[params.messages.length - 1]
    const content = lastMessage?.content as Anthropic.ContentBlockParam[]
    expect(content[content.length - 1]).toMatchObject({ cache_control: { type: "ephemeral" } })
  })

  it("translates tools and message blocks to the Messages API shape", () => {
    const params = buildMessageParams(
      request({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "greet", input: { name: "Ada" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "t1", content: "done", isError: false }],
          },
        ],
      })
    )

    expect(params.tools?.[0]).toMatchObject({ name: "greet", input_schema: { type: "object" } })
    const toolUse = (params.messages[0]?.content as Anthropic.ContentBlockParam[])[0]
    expect(toolUse).toMatchObject({ type: "tool_use", id: "t1", name: "greet" })
    const toolResult = (params.messages[1]?.content as Anthropic.ContentBlockParam[])[0]
    expect(toolResult).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: "done" }],
    })
  })
})

describe("fromAnthropicMessage / fromAnthropicUsage", () => {
  it("extracts text and tool_use blocks, ignoring others", () => {
    const message = {
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t1", name: "greet", input: { name: "Ada" } },
        { type: "thinking", thinking: "...", signature: "" },
      ],
    } as unknown as Anthropic.Message
    expect(fromAnthropicMessage(message)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t1", name: "greet", input: { name: "Ada" } },
      ],
    })
  })

  it("maps usage including cache fields", () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    } as unknown as Anthropic.Usage
    expect(fromAnthropicUsage(usage)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
    })
  })
})

describe("anthropicProvider.stream", () => {
  it("yields text deltas then a final message from the SDK stream", async () => {
    const deltaEvents = [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "He" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "llo" } },
    ] as unknown as Anthropic.RawMessageStreamEvent[]

    const finalMessage = {
      content: [{ type: "text", text: "Hello" }],
      usage: {
        input_tokens: 4,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: "end_turn",
    } as unknown as Anthropic.Message

    const fakeStream: AnthropicMessageStream = {
      async *[Symbol.asyncIterator]() {
        for (const event of deltaEvents) yield event
      },
      finalMessage: async () => finalMessage,
    }
    const client: AnthropicMessagesClient = { messages: { stream: () => fakeStream } }

    const provider = new AnthropicProvider({ client })
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(request())) events.push(event)

    expect(events).toEqual([
      { type: "text", text: "He" },
      { type: "text", text: "llo" },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        stopReason: "end_turn",
      },
    ])
  })
})
