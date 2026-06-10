// Splits a document into overlapping fixed-size chunks for embedding-based
// recall. Overlap keeps facts that straddle a boundary findable from either
// chunk. Character-based (not token-based) to stay dependency-free; the sizes
// are deliberately conservative so a chunk fits comfortably in an embedding
// request. Used by MemoryService.ingestDocument (P6b).

export interface ChunkOptions {
  /** Target chunk length in characters. */
  size?: number
  /** Characters shared between consecutive chunks. Clamped below `size`. */
  overlap?: number
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = Math.max(1, Math.floor(options.size ?? 1000))
  const overlap = Math.max(0, Math.floor(options.overlap ?? 150))
  const clean = text.replace(/\r\n/g, "\n").trim()
  if (!clean) return []
  if (clean.length <= size) return [clean]

  // Guard against overlap >= size, which would never advance the window.
  const step = Math.max(1, size - Math.min(overlap, size - 1))
  const chunks: string[] = []
  for (let start = 0; start < clean.length; start += step) {
    const chunk = clean.slice(start, start + size).trim()
    if (chunk) chunks.push(chunk)
    if (start + size >= clean.length) break
  }
  return chunks
}
