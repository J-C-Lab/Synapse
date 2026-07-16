import type Anthropic from "@anthropic-ai/sdk"
import type { AnthropicMessagesClient, AnthropicMessageStream } from "./anthropic-provider"
import type { ProviderRequest, ProviderStreamEvent, RequestEstimateInput } from "./types"
import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import {
  AnthropicProvider,
  buildMessageParams,
  fromAnthropicMessage,
  fromAnthropicUsage,
} from "./anthropic-provider"
import {
  BYTE_UPPER_BOUND_ESTIMATOR_ID,
  BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
} from "./request-estimator"

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

    const onListeners: Record<string, (() => void)[]> = {}
    const fakeStream: AnthropicMessageStream = {
      async *[Symbol.asyncIterator]() {
        for (const event of deltaEvents) yield event
      },
      finalMessage: async () => finalMessage,
      on: (event, listener) => {
        onListeners[event] = onListeners[event] ?? []
        onListeners[event]!.push(listener)
      },
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

  it("wires onTransportProgress to the SDK's connect and streamEvent listeners", async () => {
    const deltaEvents = [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    ] as unknown as Anthropic.RawMessageStreamEvent[]
    const finalMessage = {
      content: [{ type: "text", text: "Hi" }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: "end_turn",
    } as unknown as Anthropic.Message

    const onListeners: Record<string, (() => void)[]> = {}
    const fakeStream: AnthropicMessageStream = {
      async *[Symbol.asyncIterator]() {
        onListeners.connect?.forEach((fn) => fn())
        for (const event of deltaEvents) {
          onListeners.streamEvent?.forEach((fn) => fn())
          yield event
        }
      },
      finalMessage: async () => finalMessage,
      on: (event, listener) => {
        onListeners[event] = onListeners[event] ?? []
        onListeners[event]!.push(listener)
      },
    }
    const client: AnthropicMessagesClient = { messages: { stream: () => fakeStream } }

    const provider = new AnthropicProvider({ client })
    const phases: string[] = []
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(
      request({ onTransportProgress: (p) => phases.push(p) })
    )) {
      events.push(event)
    }

    expect(phases).toEqual(["headers", "activity"])
  })
})

function estimateInput(overrides: Partial<RequestEstimateInput> = {}): RequestEstimateInput {
  return {
    model: "claude-opus-4-8",
    systemText: "You are Synapse's built-in assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxOutputTokens: 1024,
    ...overrides,
  }
}

/** A generous ~3.5 bytes/token approximation of what a real tokenizer would
 *  report — always well below the byte-conservative (1 byte/token) estimate,
 *  standing in for "actual provider token accounting" in these fixtures. */
function plausibleActualTokens(input: RequestEstimateInput): number {
  const bytes =
    Buffer.byteLength(input.systemText, "utf8") +
    input.messages.reduce(
      (sum, m) =>
        sum +
        m.content.reduce((s, block) => {
          if (block.type === "text") return s + Buffer.byteLength(block.text, "utf8")
          if (block.type === "tool_result") return s + Buffer.byteLength(block.content, "utf8")
          return s + Buffer.byteLength(JSON.stringify(block.input), "utf8")
        }, 0),
      0
    ) +
    input.tools.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t), "utf8"), 0)
  return Math.ceil(bytes / 3.5)
}

function fakeStreamReturning(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}): AnthropicMessagesClient {
  const finalMessage = {
    content: [{ type: "text", text: "ok" }],
    usage,
    stop_reason: "end_turn",
  } as unknown as Anthropic.Message
  const fakeStream: AnthropicMessageStream = {
    async *[Symbol.asyncIterator]() {},
    finalMessage: async () => finalMessage,
    on: () => {},
  }
  return { messages: { stream: () => fakeStream } }
}

describe("anthropicProvider — descriptor and estimateRequestUpperBound", () => {
  it("declares an immutable descriptor identifying the byte-conservative estimator", () => {
    const provider = new AnthropicProvider({ client: fakeStreamReturning({} as never) })
    expect(provider.descriptor).toEqual({
      providerId: "anthropic",
      estimatorId: BYTE_UPPER_BOUND_ESTIMATOR_ID,
      estimatorVersion: BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
    })
  })

  it("computes an upper bound without creating any transport", () => {
    const provider = new AnthropicProvider({ client: fakeStreamReturning({} as never) })
    const estimate = provider.estimateRequestUpperBound(estimateInput())
    expect(estimate?.estimatorId).toBe(BYTE_UPPER_BOUND_ESTIMATOR_ID)
    expect(estimate?.maxOutputTokens).toBe(1024)
    expect(estimate?.inputUpperBoundTokens).toBeGreaterThan(0)
  })

  it("never exceeds the declared upper bound for Unicode, cache, multi-tool, and max-schema fixtures", async () => {
    const maxSchemaProperties: Record<string, unknown> = {}
    for (let i = 0; i < 40; i++) {
      maxSchemaProperties[`field_${i}`] = { type: "string", description: "x".repeat(80) }
    }

    const fixtures: RequestEstimateInput[] = [
      // Unicode-heavy content.
      estimateInput({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "你好世界🎉こんにちは안녕하세요".repeat(20) }],
          },
        ],
      }),
      // Cache-relevant multi-turn content (a large prior tool_result feeding
      // the conversation prefix Anthropic's cache breakpoint covers).
      estimateInput({
        messages: [
          { role: "user", content: [{ type: "text", text: "read the file" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "t1",
                content: "line of file content\n".repeat(200),
                isError: false,
              },
            ],
          },
        ],
      }),
      // Multiple simultaneous tool calls in one assistant turn.
      estimateInput({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "search_files", input: { pattern: "*.ts" } },
              { type: "tool_use", id: "t2", name: "list_files", input: { root: "src" } },
              { type: "tool_use", id: "t3", name: "read_file", input: { path: "b.ts" } },
            ],
          },
        ],
      }),
      // Maximum-size tool schemas.
      estimateInput({
        tools: [
          {
            name: "big_tool",
            description: "y".repeat(2000),
            inputSchema: { type: "object", properties: maxSchemaProperties },
          },
        ],
      }),
    ]

    const provider = new AnthropicProvider({ client: fakeStreamReturning({} as never) })
    for (const fixture of fixtures) {
      const estimate = provider.estimateRequestUpperBound(fixture)!
      const actualInputTokens = plausibleActualTokens(fixture)

      const client = fakeStreamReturning({
        input_tokens: actualInputTokens,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
      const streamed = new AnthropicProvider({ client })
      let usage: { inputTokens: number } | undefined
      for await (const event of streamed.stream({
        model: fixture.model,
        system: fixture.systemText,
        messages: fixture.messages,
        tools: fixture.tools,
        maxTokens: fixture.maxOutputTokens,
      })) {
        if (event.type === "message") usage = event.usage
      }

      expect(usage!.inputTokens).toBeLessThanOrEqual(estimate.inputUpperBoundTokens)
    }
  })
})
