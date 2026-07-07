import type { ChunkOptions } from "./chunk-text"
import type { MemoryQueryScope } from "./memory-scope"
import type { MemoryEntry, MemoryScope, MemoryStore } from "./memory-store"
import type { Embedder } from "./openai-embedding-provider"
import { bm25Scores, normalizeScores } from "./bm25"
import { chunkText } from "./chunk-text"
import { entryMatchesQuery } from "./memory-scope"

// Long-term memory: save facts and recall them across conversations. Recall is
// hybrid — a semantic score (query + entries embedded, ranked by cosine) fused
// with a BM25 keyword score, each normalized to [0,1] and weighted. Embeddings
// generalize but miss exact tokens (error codes, paths, flags); BM25 nails those
// but not paraphrase — fusing gets both. With no embedder/key the vector signal
// is simply absent and recall runs on BM25 alone, so it works without a key.

// Fusion weights: embeddings lead, keyword corrects for exact-token misses.
const VECTOR_WEIGHT = 0.6
const KEYWORD_WEIGHT = 0.4

export interface MemorySearchHit {
  entry: MemoryEntry
  score: number
}

export interface SaveMemoryInput {
  text: string
  tags?: string[]
  scope?: MemoryScope
}

export interface IngestDocumentInput {
  /** Label identifying the document; recorded as a `source:<source>` tag. */
  source: string
  text: string
  tags?: string[]
  scope?: MemoryScope
}

export interface IngestDocumentResult {
  source: string
  chunks: number
}

export interface MemorySource {
  source: string
  /** Number of stored chunks for this document. */
  count: number
}

/** Tag prefix marking a chunk's originating document. */
export const SOURCE_TAG_PREFIX = "source:"

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
      scope: input.scope ?? { visibility: "global" },
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
      `${SOURCE_TAG_PREFIX}${source}`,
      ...(input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    ]
    const entries: MemoryEntry[] = chunks.map((text, index) => ({
      id: this.newId(),
      text,
      tags,
      createdAt: this.now(),
      scope: input.scope ?? { visibility: "global" },
      embedding: embeddings?.[index],
    }))

    await this.store.addMany(entries)
    return { source, chunks: chunks.length }
  }

  async search(
    query: string,
    limit = 5,
    scope: MemoryQueryScope = { includeGlobal: true }
  ): Promise<MemorySearchHit[]> {
    const trimmed = query.trim()
    const entries = (await this.store.all()).filter((entry) => entryMatchesQuery(entry, scope))
    if (!trimmed || entries.length === 0) return []

    const queryVector = (await this.safeEmbed([trimmed]))?.[0]
    const vector = new Map<string, number>()
    if (queryVector) {
      for (const entry of entries) {
        if (entry.embedding && entry.embedding.length > 0) {
          vector.set(entry.id, cosineSimilarity(queryVector, entry.embedding))
        }
      }
    }
    // Search both the fact and its tags (a chunk's `source:` lives in tags).
    const keyword = bm25Scores(
      trimmed,
      entries.map((entry) => ({ id: entry.id, text: `${entry.text} ${entry.tags.join(" ")}` }))
    )
    const normVector = normalizeScores(vector)
    const normKeyword = normalizeScores(keyword)

    return entries
      .map((entry) => ({
        entry,
        score:
          VECTOR_WEIGHT * (normVector.get(entry.id) ?? 0) +
          KEYWORD_WEIGHT * (normKeyword.get(entry.id) ?? 0),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
  }

  async list(limit = 50, scope?: MemoryQueryScope): Promise<MemoryEntry[]> {
    const entries = scope
      ? (await this.store.all()).filter((entry) => entryMatchesQuery(entry, scope))
      : await this.store.all()
    return entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, limit))
  }

  async get(id: string, scope?: MemoryQueryScope): Promise<MemoryEntry | undefined> {
    const entries = await this.store.all()
    return entries.find((entry) => entry.id === id && (!scope || entryMatchesQuery(entry, scope)))
  }

  async delete(id: string): Promise<boolean> {
    return this.store.remove(id)
  }

  /** Ingested documents (by `source:` tag) with their chunk counts, sorted by name. */
  async listSources(): Promise<MemorySource[]> {
    const counts = new Map<string, number>()
    for (const entry of await this.store.all()) {
      const source = sourceOf(entry.tags)
      if (source) counts.set(source, (counts.get(source) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => a.source.localeCompare(b.source))
  }

  /** Delete every chunk belonging to a document. Returns how many were removed. */
  async deleteSource(source: string): Promise<number> {
    const ids = (await this.store.all())
      .filter((entry) => sourceOf(entry.tags) === source)
      .map((entry) => entry.id)
    return this.store.removeMany(ids)
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

/** The document a chunk came from, read from its `source:` tag, or undefined. */
function sourceOf(tags: string[]): string | undefined {
  const tag = tags.find((value) => value.startsWith(SOURCE_TAG_PREFIX))
  return tag ? tag.slice(SOURCE_TAG_PREFIX.length) : undefined
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
