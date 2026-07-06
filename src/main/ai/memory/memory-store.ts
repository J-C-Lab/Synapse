import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../../lan/atomic-json-store"
import { normalizeMemoryScope } from "./memory-scope"

// Persists the agent's long-term memory as plain JSON (decision §11.1 — no
// native deps). Each entry keeps its text, tags, and (when an embedder is
// available) a vector used for semantic recall. The whole set is small enough
// to load and cosine-rank in memory, so no vector database is needed.

export interface MemoryScope {
  userId?: string
  workspaceId?: string
  conversationId?: string
  visibility: "conversation" | "workspace" | "global"
}

export interface MemoryEntry {
  id: string
  text: string
  tags: string[]
  createdAt: number
  scope: MemoryScope
  /** Embedding vector for semantic search; absent when no embedder ran. */
  embedding?: number[]
}

export function aiMemoryFilePath(userDataDir: string): string {
  return path.join(userDataDir, "ai", "memory.json")
}

export class MemoryStore {
  private entries: MemoryEntry[] | null = null

  constructor(private readonly filePath: string) {}

  async all(): Promise<MemoryEntry[]> {
    return [...(await this.load())]
  }

  async add(entry: MemoryEntry): Promise<void> {
    const entries = await this.load()
    entries.push(entry)
    await this.persist(entries)
  }

  /** Append several entries with a single write (used by document ingest). */
  async addMany(newEntries: MemoryEntry[]): Promise<void> {
    if (newEntries.length === 0) return
    const entries = await this.load()
    entries.push(...newEntries)
    await this.persist(entries)
  }

  async remove(id: string): Promise<boolean> {
    const entries = await this.load()
    const next = entries.filter((entry) => entry.id !== id)
    if (next.length === entries.length) return false
    await this.persist(next)
    return true
  }

  /** Remove every entry whose id is in `ids`, with one write. Returns the count. */
  async removeMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const remove = new Set(ids)
    const entries = await this.load()
    const next = entries.filter((entry) => !remove.has(entry.id))
    const removed = entries.length - next.length
    if (removed > 0) await this.persist(next)
    return removed
  }

  private async load(): Promise<MemoryEntry[]> {
    if (this.entries) return this.entries
    this.entries = normalize(await readJsonFile(this.filePath))
    return this.entries
  }

  private async persist(entries: MemoryEntry[]): Promise<void> {
    this.entries = entries
    await writeJsonFile(this.filePath, entries)
  }
}

function normalize(value: unknown): MemoryEntry[] {
  if (!Array.isArray(value)) return []
  const out: MemoryEntry[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.text !== "string") continue
    out.push({
      id: record.id,
      text: record.text,
      tags: Array.isArray(record.tags)
        ? record.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
      scope: normalizeMemoryScope(record.scope),
      embedding:
        Array.isArray(record.embedding) &&
        record.embedding.every((value) => typeof value === "number")
          ? (record.embedding as number[])
          : undefined,
    })
  }
  return out
}
