import type { ChunkOptions } from "./chunk-text"
import type { MemoryEntry, MemoryStore } from "./memory-store"
import type { Embedder } from "./openai-embedding-provider"
import { chunkText } from "./chunk-text"

// Long-term memory: save facts and recall them across conversations. Recall is
// semantic — the query and entries are embedded and ranked by cosine similarity
// — with a lexical (term-overlap) fallback when no embedder/key is available so
// the feature still works without an OpenAI key.

export interface MemorySearchHit {
  entry: MemoryEntry
  score: number
}

export interface SaveMemoryInput {
  text: string
  tags?: string[]
}

export interface IngestDocumentInput {
  /** Label identifying the document; recorded as a `source:<source>` tag. */
  source: string
  text: string
  tags?: string[]
}

export interface IngestDocumentResult {
  source: string
  chunks: number
}

export class MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly embedder: Embedder,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID()
  ) {}

  async save(input: SaveMemoryInput): Promise<MemoryEntry> {
    const text = input.text.trim()
    if (!text) throw new Error("Cannot save empty memory text.")
    const embedding = (await this.safeEmbed([text]))?.[0]
    const entry: MemoryEntry = {
      id: this.newId(),
      text,
      tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
      createdAt: this.now(),
      embedding,
    }
    await this.store.add(entry)
    return entry
  }

  /**
   * Chunk a document into overlapping pieces, embed them in one batched call,
   * and store each as a memory entry tagged `source:<source>` so it can be
   * recalled by {@link search}. Returns how many chunks were stored.
   */
  async ingestDocument(
    input: IngestDocumentInput,
    chunkOptions?: ChunkOptions
  ): Promise<IngestDocumentResult> {
    const source = input.source.trim()
    if (!source) throw new Error("Document source is required.")
    const chunks = chunkText(input.text, chunkOptions)
    if (chunks.length === 0) throw new Error("Cannot ingest an empty document.")

    const embeddings = await this.safeEmbed(chunks)
    const tags = [
      `source:${source}`,
      ...(input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    ]
    const entries: MemoryEntry[] = chunks.map((text, index) => ({
      id: this.newId(),
      text,
      tags,
      createdAt: this.now(),
      embedding: embeddings?.[index],
    }))

    await this.store.addMany(entries)
    return { source, chunks: chunks.length }
  }

  async search(query: string, limit = 5): Promise<MemorySearchHit[]> {
    const trimmed = query.trim()
    const entries = await this.store.all()
    if (!trimmed || entries.length === 0) return []

    const queryVector = (await this.safeEmbed([trimmed]))?.[0]
    const embeddable = entries.filter((entry) => entry.embedding && entry.embedding.length > 0)
    const hits =
      queryVector && embeddable.length > 0
        ? embeddable.map((entry) => ({
            entry,
            score: cosineSimilarity(queryVector, entry.embedding as number[]),
          }))
        : lexicalHits(trimmed, entries)

    return hits
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
  }

  async list(limit = 50): Promise<MemoryEntry[]> {
    const entries = await this.store.all()
    return entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, limit))
  }

  async delete(id: string): Promise<boolean> {
    return this.store.remove(id)
  }

  private async safeEmbed(texts: string[]): Promise<number[][] | null> {
    try {
      return await this.embedder.embed(texts)
    } catch {
      // A failed embedding (no key, network, quota) must not break save/search;
      // the caller falls back to lexical behaviour.
      return null
    }
  }
}

function lexicalHits(query: string, entries: MemoryEntry[]): MemorySearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return entries.map((entry) => {
    const haystack = `${entry.text} ${entry.tags.join(" ")}`.toLowerCase()
    const score = terms.reduce((sum, term) => (haystack.includes(term) ? sum + 1 : sum), 0)
    return { entry, score }
  })
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
