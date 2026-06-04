import OpenAI from "openai"

// Embeds text with OpenAI's embeddings API (decision: memory recall uses
// embeddings). Reuses the stored OpenAI BYOK key; when no key is configured
// `embed` returns null so the memory service can fall back to lexical search.
// The client is injectable for tests (mirrors the chat providers).

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"

/** A source of embeddings; null means embeddings are unavailable right now. */
export interface Embedder {
  embed: (texts: string[]) => Promise<number[][] | null>
}

/** Minimal slice of the SDK the provider uses — lets tests inject a fake. */
export interface EmbeddingClient {
  embeddings: {
    create: (params: {
      model: string
      input: string[]
    }) => Promise<{ data: { embedding: number[] }[] }>
  }
}

export interface OpenAiEmbeddingProviderOptions {
  /** Resolves the OpenAI key at call time (it may be set after construction). */
  getApiKey: () => Promise<string | undefined>
  model?: string
  /** Inject a client for tests; in production it's built from the key. */
  client?: EmbeddingClient
}

export class OpenAiEmbeddingProvider implements Embedder {
  constructor(private readonly options: OpenAiEmbeddingProviderOptions) {}

  async embed(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return []
    const client = await this.resolveClient()
    if (!client) return null
    const response = await client.embeddings.create({
      model: this.options.model ?? DEFAULT_EMBEDDING_MODEL,
      input: texts,
    })
    return response.data.map((item) => item.embedding)
  }

  private async resolveClient(): Promise<EmbeddingClient | null> {
    if (this.options.client) return this.options.client
    const apiKey = await this.options.getApiKey()
    return apiKey ? (new OpenAI({ apiKey }) as unknown as EmbeddingClient) : null
  }
}
