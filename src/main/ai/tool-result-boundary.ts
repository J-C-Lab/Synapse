import type { ToolContentBlock, ToolResult } from "@synapse/plugin-sdk"

/** Maximum characters admitted from a non-streaming plugin/MCP boundary.
 * Command execution has its own byte-stream tee; this is for adapters that
 * otherwise deliver one already-materialized result object. */
export const NON_STREAMING_INGRESS_CAP_CHARS = 2_000_000

export interface NonStreamingEmergencyCapMarker {
  synapseNonStreamingCapped: true
  omittedChars: number
}

/**
 * Bounds a ToolResult at the first host-owned boundary after an untrusted
 * adapter returns. It never renders the entire result into a second giant
 * string: text is copied only up to the cap, and JSON/structured values are
 * admitted only when a non-allocating conservative walk proves they fit.
 *
 * This cannot undo allocations a same-process plugin already made inside its
 * own VM, but it prevents that object from being duplicated into model,
 * checkpoint, log, or IPC memory. External MCP framing must additionally be
 * bounded by its transport before JSON parsing.
 */
export function boundNonStreamingToolResult(
  result: ToolResult,
  maxChars: number = NON_STREAMING_INGRESS_CAP_CHARS
): ToolResult {
  const safeMax = Math.max(0, Math.floor(maxChars))
  const notice =
    "\n\n[Synapse: non-streaming buffering cap reached; output was rejected before persistence. This result is incomplete.]"
  const payloadBudget = Math.max(0, safeMax - notice.length)
  const pieces: string[] = []
  let used = 0
  let truncated = false
  let omittedChars = 0

  for (const block of result.content) {
    const remaining = Math.max(0, payloadBudget - used)
    const rendered = renderedBlockWithinBudget(block, remaining)
    if (rendered === undefined) {
      if (block.type === "text") {
        pieces.push(block.text.slice(0, remaining))
        omittedChars += block.text.length - remaining
      } else {
        omittedChars += 1
      }
      truncated = true
      break
    }
    if (rendered.length > remaining) {
      pieces.push(rendered.slice(0, remaining))
      omittedChars += rendered.length - remaining
      truncated = true
      break
    }
    pieces.push(rendered)
    used += rendered.length
  }

  // Structured data is another unbounded downstream serialization surface.
  // Retain it only after proving an intentionally conservative upper bound.
  if (!truncated && !valueFitsWithin(result.structured, safeMax)) truncated = true
  if (!truncated) return result

  const rawPreview = pieces.join("\n")
  const preview = rawPreview.slice(0, payloadBudget)
  const marker: NonStreamingEmergencyCapMarker = {
    synapseNonStreamingCapped: true,
    // This is an exact count for bounded text blocks and a lower bound for
    // rejected JSON/structured shapes. We never stringify a rejected shape
    // merely to make this diagnostic more precise.
    omittedChars: Math.max(1, omittedChars),
  }
  return {
    content: [{ type: "text", text: `${preview}${notice}`.slice(0, safeMax) }],
    isError: true,
    structured: marker,
  }
}

function renderedBlockWithinBudget(block: ToolContentBlock, remaining: number): string | undefined {
  if (block.type === "text") return block.text.length <= remaining ? block.text : undefined
  if (block.type === "image") {
    const text = `[image: ${block.path}]`
    return text.length <= remaining ? text : undefined
  }
  if (!valueFitsWithin(block.json, remaining)) return undefined
  // The conservative preflight above bounds this serialization before it is
  // attempted, so JSON.stringify never gets an unbounded allocation budget.
  const text = JSON.stringify(block.json)
  return text.length <= remaining ? text : undefined
}

/** Conservative, non-allocating upper bound for JSON serialization. It may
 * reject a value that would fit, but never accepts one whose normal JSON
 * encoding can exceed `limit`. `for…in` avoids allocating Object.keys() for
 * an attacker-provided enormous object. */
function valueFitsWithin(value: unknown, limit: number): boolean {
  let remaining = limit
  const consume = (count: number): boolean => {
    remaining -= count
    return remaining >= 0
  }
  const walk = (current: unknown, depth: number): boolean => {
    if (depth > 32 || remaining < 0) return false
    if (current === undefined) return true
    if (current === null || typeof current === "boolean") return consume(5)
    if (typeof current === "number") return Number.isFinite(current) && consume(32)
    if (typeof current === "string") return consume(current.length * 6 + 2)
    if (Array.isArray(current)) {
      if (!consume(2)) return false
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0 && !consume(1)) return false
        if (index >= 10_000 || !walk(current[index], depth + 1)) return false
      }
      return true
    }
    if (typeof current !== "object") return false
    if (!consume(2)) return false
    let count = 0
    for (const key in current as Record<string, unknown>) {
      count += 1
      if (count > 10_000 || !consume(key.length * 6 + 4)) return false
      let child: unknown
      try {
        child = (current as Record<string, unknown>)[key]
      } catch {
        return false
      }
      if (!walk(child, depth + 1)) return false
    }
    return true
  }
  return walk(value, 0)
}
