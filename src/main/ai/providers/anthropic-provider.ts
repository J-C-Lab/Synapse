import type {
  ChatContentBlock,
  ChatMessage,
  ChatProvider,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolSchema,
  TokenUsage,
} from "./types"
import Anthropic from "@anthropic-ai/sdk"

// Anthropic adapter. Default provider (decision: Claude-first). Translates the
// neutral IR to the Messages API, streams text deltas, and applies prompt
// caching: a single breakpoint on the system block caches tools + system
// (render order is tools → system → messages), and a breakpoint on the last
// message caches the growing conversation prefix. See shared/prompt-caching.md.

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"

/** Minimal slice of the SDK the provider uses — lets tests inject a fake. */
export interface AnthropicMessageStream extends AsyncIterable<Anthropic.RawMessageStreamEvent> {
  finalMessage: () => Promise<Anthropic.Message>
}
export interface AnthropicMessagesClient {
  messages: {
    stream: (
      params: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal }
    ) => AnthropicMessageStream
  }
}

export interface AnthropicProviderOptions {
  apiKey?: string
  /** Inject a client for tests; in production it's built from `apiKey`. */
  client?: AnthropicMessagesClient
}

export class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic"
  private readonly client: AnthropicMessagesClient

  constructor(options: AnthropicProviderOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey })
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const stream = this.client.messages.stream(buildMessageParams(req), { signal: req.signal })

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text }
      }
    }

    const final = await stream.finalMessage()
    yield {
      type: "message",
      message: fromAnthropicMessage(final),
      usage: fromAnthropicUsage(final.usage),
      stopReason: final.stop_reason ?? "end_turn",
    }
  }
}

export function buildMessageParams(req: ProviderRequest): Anthropic.MessageStreamParams {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [
      {
        type: "text",
        text: req.system,
        // Caches tools + system together (system renders after tools).
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: req.tools.map(toAnthropicTool),
    messages: withConversationCacheBreakpoint(req.messages.map(toAnthropicMessage)),
  }
}

function toAnthropicTool(tool: ProviderToolSchema): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }
}

function toAnthropicMessage(message: ChatMessage): Anthropic.MessageParam {
  return { role: message.role, content: message.content.map(toContentBlockParam) }
}

function toContentBlockParam(block: ChatContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input }
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: [{ type: "text", text: block.content }],
        is_error: block.isError,
      }
  }
}

// Mark the last content block of the last message so the cache covers the whole
// conversation prefix; each turn reads the prior prefix and writes the new tail.
function withConversationCacheBreakpoint(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1]
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return messages
  const blocks = [...last.content]
  const tail = blocks[blocks.length - 1]
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } } as typeof tail
  return [...messages.slice(0, -1), { ...last, content: blocks }]
}

export function fromAnthropicMessage(message: Anthropic.Message): ChatMessage {
  const content: ChatMessage["content"] = []
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text })
    else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input })
    }
    // thinking / server-tool blocks are not part of the P2 IR
  }
  return { role: "assistant", content }
}

export function fromAnthropicUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  }
}
