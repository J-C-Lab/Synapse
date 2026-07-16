import type { OpenAiChatClient, OpenAiStreamChunk } from "./openai-provider"
import type { ProviderRequest, ProviderStreamEvent, RequestEstimateInput } from "./types"
import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import { buildCompletionParams, OpenAiProvider } from "./openai-provider"
import {
  BYTE_UPPER_BOUND_ESTIMATOR_ID,
  BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
} from "./request-estimator"

function fakeClient(chunks: OpenAiStreamChunk[]): {
  client: OpenAiChatClient
  create: ReturnType<typeof vi.fn>
} {
  const create = vi.fn(async () => {
    async function* gen(): AsyncIterable<OpenAiStreamChunk> {
      for (const chunk of chunks) yield chunk
    }
    return gen()
  })
  return { client: { chat: { completions: { create } } }, create }
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "gpt-4.1",
    system: "be helpful",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxTokens: 256,
    ...overrides,
  }
}

async function collect(provider: OpenAiProvider, req: ProviderRequest) {
  const events = []
  for await (const event of provider.stream(req)) events.push(event)
  return events
}

describe("openAiProvider", () => {
  it("streams text deltas and a final message with usage", async () => {
    const { client } = fakeClient([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
    ])
    const events = await collect(new OpenAiProvider({ client }), request())

    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
      "Hel",
      "lo",
    ])
    const final = events.at(-1)
    if (final?.type !== "message") throw new Error("expected final message")
    expect(final.message.content).toEqual([{ type: "text", text: "Hello" }])
    expect(final.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 4 })
    expect(final.stopReason).toBe("stop")
  })

  it("accumulates a streamed tool call into a tool_use block", async () => {
    const { client } = fakeClient([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "do_thing" } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      },
    ])
    const events = await collect(new OpenAiProvider({ client }), request())
    const final = events.at(-1)
    if (final?.type !== "message") throw new Error("expected final message")

    expect(final.message.content).toEqual([
      { type: "tool_use", id: "call_1", name: "do_thing", input: { a: 1 } },
    ])
    expect(final.stopReason).toBe("tool_use")
  })

  it("maps the IR into Chat Completions params", () => {
    const params = buildCompletionParams(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "run it" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c1", name: "act", input: { x: 1 } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "c1", content: "ok" }],
          },
        ],
        tools: [{ name: "act", description: "Act", inputSchema: { type: "object" } }],
      })
    )

    const messages = params.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: "system", content: "be helpful" })
    expect(messages[1]).toEqual({ role: "user", content: "run it" })
    expect(messages[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1" }] })
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" })
    expect(params.tools).toMatchObject([{ type: "function", function: { name: "act" } }])
  })

  it("calls onTransportProgress('headers') once create() resolves, then 'activity' per chunk", async () => {
    const chunks: OpenAiStreamChunk[] = [
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]
    const { client } = fakeClient(chunks)
    const provider = new OpenAiProvider({ client })

    const phases: string[] = []
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(
      request({ onTransportProgress: (p) => phases.push(p) })
    )) {
      events.push(event)
    }

    expect(phases).toEqual(["headers", "activity", "activity"])
  })
})

function estimateInput(overrides: Partial<RequestEstimateInput> = {}): RequestEstimateInput {
  return {
    model: "gpt-4.1",
    systemText: "be helpful",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxOutputTokens: 256,
    ...overrides,
  }
}

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

describe("openAiProvider — descriptor and estimateRequestUpperBound", () => {
  it("declares an immutable descriptor tagged with the instance's catalog id", () => {
    const { client } = fakeClient([])
    const provider = new OpenAiProvider({ client, id: "zhipu" })
    expect(provider.descriptor).toEqual({
      providerId: "zhipu",
      estimatorId: BYTE_UPPER_BOUND_ESTIMATOR_ID,
      estimatorVersion: BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
    })
  })

  it("computes an upper bound without creating any transport", () => {
    const { client } = fakeClient([])
    const provider = new OpenAiProvider({ client })
    const estimate = provider.estimateRequestUpperBound(estimateInput())
    expect(estimate?.estimatorId).toBe(BYTE_UPPER_BOUND_ESTIMATOR_ID)
    expect(estimate?.maxOutputTokens).toBe(256)
    expect(estimate?.inputUpperBoundTokens).toBeGreaterThan(0)
  })

  it("never exceeds the declared upper bound for Unicode, cache, multi-tool, and max-schema fixtures", async () => {
    const maxSchemaProperties: Record<string, unknown> = {}
    for (let i = 0; i < 40; i++) {
      maxSchemaProperties[`field_${i}`] = { type: "string", description: "x".repeat(80) }
    }

    const fixtures: RequestEstimateInput[] = [
      estimateInput({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "你好世界🎉こんにちは안녕하세요".repeat(20) }],
          },
        ],
      }),
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

    for (const fixture of fixtures) {
      const { client: estimateClient } = fakeClient([])
      const estimate = new OpenAiProvider({ client: estimateClient }).estimateRequestUpperBound(
        fixture
      )!
      const actualInputTokens = plausibleActualTokens(fixture)

      const { client } = fakeClient([
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: actualInputTokens, completion_tokens: 50 } },
      ])
      const events = await collect(new OpenAiProvider({ client }), {
        model: fixture.model,
        system: fixture.systemText,
        messages: fixture.messages,
        tools: fixture.tools,
        maxTokens: fixture.maxOutputTokens,
      })
      const final = events.at(-1)
      if (final?.type !== "message") throw new Error("expected final message")

      expect(final.usage.inputTokens).toBeLessThanOrEqual(estimate.inputUpperBoundTokens)
    }
  })
})
