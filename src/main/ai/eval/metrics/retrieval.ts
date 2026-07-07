export function precisionAtK(retrieved: string[], relevant: string[], k: number): number {
  if (k <= 0) return 0
  const top = retrieved.slice(0, k)
  const rel = new Set(relevant)
  const hit = top.filter((id) => rel.has(id)).length
  return hit / k
}

export function recall(retrieved: string[], relevant: string[]): number {
  if (relevant.length === 0) return 1
  const got = new Set(retrieved)
  const found = relevant.filter((id) => got.has(id)).length
  return found / relevant.length
}
