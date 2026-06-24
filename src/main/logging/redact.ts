// Redacts secret-looking values from structured log fields before they reach a
// sink. Key-name based (we never want provider keys, session tokens, or auth
// headers landing in a log file), recursive, with a depth cap so a cyclic or
// pathologically nested object can't blow the stack.

const SECRET_KEY = /api[-_]?key|token|secret|password|authorization|cookie/i
const MAX_DEPTH = 4

export function redactFields(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[depth-capped]"
  if (Array.isArray(value)) return value.map((item) => redactFields(item, depth + 1))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactFields(val, depth + 1)
    }
    return out
  }
  return value
}
