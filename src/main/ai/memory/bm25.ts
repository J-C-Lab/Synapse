// Okapi BM25 keyword scoring for memory recall. Embeddings miss exact,
// high-entropy tokens — error codes (TS2741), file paths, CLI flags, function
// names — which is exactly what a dev-tool memory holds. BM25 catches those and
// is fused with the embedding score in memory-service (hybrid retrieval), so the
// two signals complement each other instead of one falling back to the other.

export interface Bm25Doc {
  id: string
  text: string
}

// Standard BM25 constants: k1 damps term-frequency saturation, b controls how
// strongly document length is normalized.
const K1 = 1.5
const B = 0.75

// Contiguous CJK (Han) runs — Chinese has no spaces, so we index unigrams and
// bigrams over each run to give it matchable "terms".
const HAN_RUN = /\p{Script=Han}+/gu

/**
 * Split text into keyword tokens: lowercased alphanumeric/underscore runs
 * (words, identifiers, error codes), plus unigrams and bigrams over contiguous
 * CJK runs.
 */
export function tokenize(text: string): string[] {
  const lower = (text ?? "").toLowerCase()
  const tokens: string[] = []
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(match[0])
  for (const run of lower.matchAll(HAN_RUN)) {
    const s = run[0]
    for (let i = 0; i < s.length; i++) {
      tokens.push(s[i])
      if (i + 1 < s.length) tokens.push(s.slice(i, i + 2))
    }
  }
  return tokens
}

/**
 * Raw BM25 score per doc for the query (0 when no query term matches). Blank
 * query → empty map. Caller normalizes before fusing with vector scores.
 */
export function bm25Scores(query: string, docs: Bm25Doc[]): Map<string, number> {
  const queryTerms = [...new Set(tokenize(query))]
  const scores = new Map<string, number>()
  if (queryTerms.length === 0 || docs.length === 0) return scores

  const indexed = docs.map((doc) => {
    const terms = tokenize(doc.text)
    const tf = new Map<string, number>()
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)
    return { id: doc.id, length: terms.length, tf }
  })
  const avgLength = indexed.reduce((sum, doc) => sum + doc.length, 0) / indexed.length || 1
  const df = new Map<string, number>()
  for (const term of queryTerms) {
    df.set(term, indexed.filter((doc) => doc.tf.has(term)).length)
  }

  for (const doc of indexed) {
    let score = 0
    for (const term of queryTerms) {
      const tf = doc.tf.get(term) ?? 0
      if (tf === 0) continue
      const docFreq = df.get(term)!
      const idf = Math.log(1 + (indexed.length - docFreq + 0.5) / (docFreq + 0.5))
      const denom = tf + K1 * (1 - B + (B * doc.length) / avgLength)
      score += idf * ((tf * (K1 + 1)) / denom)
    }
    scores.set(doc.id, score)
  }
  return scores
}

/** Scale a score map to [0, 1] by its max. All-zero (or empty) → unchanged. */
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
  let max = 0
  for (const value of scores.values()) if (value > max) max = value
  if (max <= 0) return scores
  const normalized = new Map<string, number>()
  for (const [id, value] of scores) normalized.set(id, value / max)
  return normalized
}
