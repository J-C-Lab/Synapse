import type {
  ChatContentBlock,
  ChatMessage,
  ChatProvider,
  ChatProviderDescriptor,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolSchema,
  RequestEstimateInput,
  RequestUpperBoundEstimate,
  TokenUsage,
} from "./types"
import OpenAI from "openai"
import { resolveModelCapabilityProfile } from "./model-capability-profile"
import { byteUpperBoundEstimator } from "./request-estimator"

// OpenAI adapter (P5b). Maps the provider-neutral IR to the Chat Completions
// API, streams text deltas, and accumulates streamed tool calls into the IR's
// tool_use blocks. OpenAI has no prompt-cache breakpoints to place (caching is
// automatic server-side), so usage simply surfaces cached prompt tokens.

export const DEFAULT_OPENAI_MODEL = "gpt-4.1"

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}

/** One streamed chunk — the subset of ChatCompletionChunk we read. */
export interface OpenAiStreamChunk {
  choices: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number } | null
  } | null
}

/** Minimal slice of the SDK the provider uses — lets tests inject a fake. */
export interface OpenAiChatClient {
  chat: {
    completions: {
      create: (
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal }
      ) => Promise<AsyncIterable<OpenAiStreamChunk>>
    }
  }
}

export interface OpenAiProviderOptions {
  apiKey?: string
  /**
   * OpenAI-compatible base URL. Omit for OpenAI itself; set it to reuse this
   * adapter for compatible vendors (Zhipu, SiliconFlow, Alibaba Bailian, …).
   */
  baseURL?: string
  /** Catalog id this instance serves; defaults to "openai". */
  id?: string
  /** Inject a client for tests; in production it's built from `apiKey`. */
  client?: OpenAiChatClient
}

export class OpenAiProvider implements ChatProvider {
  readonly id: string
  readonly descriptor: ChatProviderDescriptor
  private readonly client: OpenAiChatClient

  constructor(options: OpenAiProviderOptions) {
    this.id = options.id ?? "openai"
    this.client = options.client ?? defaultClient(options.apiKey, options.baseURL)
    this.descriptor = {
      providerId: this.id,
      estimatorId: byteUpperBoundEstimator.id,
      estimatorVersion: byteUpperBoundEstimator.version,
    }
  }

  estimateRequestUpperBound(input: RequestEstimateInput): RequestUpperBoundEstimate | undefined {
    const profile = resolveModelCapabilityProfile(this.id, input.model)
    return byteUpperBoundEstimator.estimate(input, profile)
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const stream = await this.client.chat.completions.create(buildCompletionParams(req), {
      signal: req.signal,
    })
    req.onTransportProgress?.("headers")

    let text = ""
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()
    let finishReason: string | null | undefined
    let usage: TokenUsage = { ...EMPTY_USAGE }

    for await (const chunk of stream) {
      req.onTransportProgress?.("activity")
      const choice = chunk.choices[0]
      const delta = choice?.delta
      if (delta?.content) {
        text += delta.content
        yield { type: "text", text: delta.content }
      }
      for (const call of delta?.tool_calls ?? []) {
        const entry = toolCalls.get(call.index) ?? { id: "", name: "", args: "" }
        if (call.id) entry.id = call.id
        if (call.function?.name) entry.name += call.function.name
        if (call.function?.arguments) entry.args += call.function.arguments
        toolCalls.set(call.index, entry)
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (chunk.usage) usage = fromOpenAiUsage(chunk.usage)
    }

    yield {
      type: "message",
      message: assembleMessage(text, toolCalls),
      usage,
      stopReason: finishReason === "tool_calls" ? "tool_use" : (finishReason ?? "end_turn"),
    }
  }
}

function defaultClient(apiKey: string | undefined, baseURL?: string): OpenAiChatClient {
  const client = new OpenAI({ apiKey, baseURL })
  return {
    chat: {
      completions: {
        create: (params, options) =>
          client.chat.completions.create(
            { ...params, stream: true } as OpenAI.ChatCompletionCreateParamsStreaming,
            options
          ) as unknown as Promise<AsyncIterable<OpenAiStreamChunk>>,
      },
    },
  }
}

export function buildCompletionParams(req: ProviderRequest): Record<string, unknown> {
  return {
    model: req.model,
    max_completion_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "system", content: req.system }, ...req.messages.flatMap(toOpenAiMessages)],
    tools: req.tools.length > 0 ? req.tools.map(toOpenAiTool) : undefined,
  }
}

function toOpenAiTool(tool: ProviderToolSchema): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function toOpenAiMessages(message: ChatMessage): Record<string, unknown>[] {
  if (message.role === "assistant") {
    const text = message.content
      .filter(
        (block): block is Extract<ChatContentBlock, { type: "text" }> => block.type === "text"
      )
      .map((block) => block.text)
      .join("")
    const toolCalls = message.content
      .filter(
        (block): block is Extract<ChatContentBlock, { type: "tool_use" }> =>
          block.type === "tool_use"
      )
      .map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }))
    const out: Record<string, unknown> = { role: "assistant", content: text || null }
    if (toolCalls.length > 0) out.tool_calls = toolCalls
    return [out]
  }

  // User turns carry plain text and/or tool_result blocks; OpenAI wants tool
  // results as separate `role: "tool"` messages keyed by tool_call_id.
  const messages: Record<string, unknown>[] = []
  const text: string[] = []
  for (const block of message.content) {
    if (block.type === "text") text.push(block.text)
    else if (block.type === "tool_result") {
      messages.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content })
    }
  }
  if (text.length > 0) messages.unshift({ role: "user", content: text.join("\n") })
  return messages
}

function assembleMessage(
  text: string,
  toolCalls: Map<number, { id: string; name: string; args: string }>
): ChatMessage {
  const content: ChatContentBlock[] = []
  if (text) content.push({ type: "text", text })
  for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: parseArguments(call.args),
    })
  }
  return { role: "assistant", content }
}

function parseArguments(args: string): unknown {
  if (!args.trim()) return {}
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

export function fromOpenAiUsage(usage: NonNullable<OpenAiStreamChunk["usage"]>): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  }
}
