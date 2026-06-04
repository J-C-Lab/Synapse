import type { OpenAiChatClient, OpenAiStreamChunk } from "./openai-provider"
import type { ProviderRequest } from "./types"
import { describe, expect, it, vi } from "vitest"
import { buildCompletionParams, OpenAiProvider } from "./openai-provider"

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
})
