import type { ToolContentBlock, ToolResult } from "@synapse/plugin-sdk"

/** Maximum characters admitted from a non-streaming plugin/MCP boundary.
 * Command execution has its own byte-stream tee; this is for adapters that
 * otherwise deliver one already-materialized result object. */
export const NON_STREAMING_INGRESS_CAP_CHARS = 2_000_000
/** Stops a huge array of individually tiny blocks from bypassing the text
 * budget and forcing an unbounded join/render allocation downstream. */
export const MAX_NON_STREAMING_CONTENT_BLOCKS = 1_024
const MAX_NON_STREAMING_JSON_NODES = 10_000
const INVALID_DATA = Symbol("invalid-data-property")

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

  // Never read a property from an adapter-owned result before proving it is a
  // data property. Even a result which fits the cap is copied: returning the
  // original would leave an accessor for a later renderer/persistence step.
  const sanitized = cloneToolResult(result)
  if (!sanitized) {
    return cappedResult(safeMax, "", 1, notice)
  }
  const content = sanitized.content
  const blockLimit = Math.min(content.length, MAX_NON_STREAMING_CONTENT_BLOCKS)
  for (let index = 0; index < blockLimit; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(content, String(index))
    if (!descriptor || !isDataDescriptor(descriptor)) {
      truncated = true
      omittedChars += 1
      break
    }
    const block = descriptor.value as ToolContentBlock
    // renderToolResultText joins blocks with newlines. Charge that separator
    // here too so many empty blocks cannot exceed the advertised hard cap.
    const separatorChars = pieces.length === 0 ? 0 : 1
    const remainingBeforeBlock = payloadBudget - used - separatorChars
    if (remainingBeforeBlock < 0) {
      truncated = true
      omittedChars += 1
      break
    }
    const remaining = remainingBeforeBlock
    const rendered = renderedBlockWithinBudget(block, remaining)
    if (rendered === undefined) {
      const text = textBlockValue(block)
      if (text !== undefined) {
        pieces.push(text.slice(0, remaining))
        omittedChars += text.length - remaining
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
    used += separatorChars + rendered.length
  }
  if (!truncated && content.length > blockLimit) {
    truncated = true
    omittedChars += content.length - blockLimit
  }

  // Structured data is another unbounded downstream serialization surface.
  // Retain it only after proving an intentionally conservative upper bound.
  const structuredDescriptor = Object.getOwnPropertyDescriptor(sanitized, "structured")
  if (
    !truncated &&
    structuredDescriptor !== undefined &&
    (!isDataDescriptor(structuredDescriptor) ||
      !valueFitsWithin(structuredDescriptor.value, safeMax))
  ) {
    truncated = true
  }
  if (!truncated) return sanitized

  const rawPreview = pieces.join("\n")
  const preview = rawPreview.slice(0, payloadBudget)
  return cappedResult(safeMax, preview, omittedChars, notice)
}

/** Builds a host-owned result from descriptors only. This is intentionally
 * narrower than TypeScript's structural ToolResult type: fields not consumed
 * by Synapse are not carried across the untrusted boundary. */
function cloneToolResult(value: unknown): ToolResult | undefined {
  try {
    if (!value || typeof value !== "object" || !isPlainJsonContainer(value)) return undefined
    const contentValue = dataProperty(value, "content")
    if (
      contentValue === INVALID_DATA ||
      !Array.isArray(contentValue) ||
      !isPlainJsonContainer(contentValue)
    ) {
      return undefined
    }
    const length = dataProperty(contentValue, "length")
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_NON_STREAMING_CONTENT_BLOCKS
    ) {
      return undefined
    }
    const content: ToolContentBlock[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(contentValue, String(index))
      if (!descriptor || !isDataDescriptor(descriptor)) return undefined
      const block = cloneContentBlock(descriptor.value)
      if (!block) return undefined
      content.push(block)
    }

    const result: ToolResult = { content }
    const isError = Object.getOwnPropertyDescriptor(value, "isError")
    if (isError !== undefined) {
      if (!isDataDescriptor(isError) || typeof isError.value !== "boolean") return undefined
      result.isError = isError.value
    }
    const structured = Object.getOwnPropertyDescriptor(value, "structured")
    if (structured !== undefined) {
      if (!isDataDescriptor(structured)) return undefined
      const cloned = cloneJsonValue(structured.value)
      if (!cloned.ok) return undefined
      result.structured = cloned.value
    }
    return result
  } catch {
    return undefined
  }
}

function cloneContentBlock(value: unknown): ToolContentBlock | undefined {
  if (!value || typeof value !== "object" || !isPlainJsonContainer(value)) return undefined
  const type = dataProperty(value, "type")
  if (typeof type !== "string") return undefined
  if (type === "text") {
    const text = dataProperty(value, "text")
    return typeof text === "string" ? { type, text } : undefined
  }
  if (type === "image") {
    const path = dataProperty(value, "path")
    const mimeType = dataProperty(value, "mimeType")
    return typeof path === "string" && typeof mimeType === "string"
      ? { type, path, mimeType }
      : undefined
  }
  if (type !== "json") return undefined
  const json = dataProperty(value, "json")
  if (json === INVALID_DATA) return undefined
  const cloned = cloneJsonValue(json)
  return cloned.ok ? { type, json: cloned.value } : undefined
}

type JsonClone = { ok: true; value: unknown } | { ok: false }

/** Descriptor-only JSON clone. It rejects cycles, hooks, accessors and
 * inherited enumerable fields rather than evaluating any of them. */
function cloneJsonValue(value: unknown): JsonClone {
  const seen = new WeakSet<object>()
  let nodes = 0
  const clone = (current: unknown, depth: number): JsonClone => {
    nodes += 1
    if (depth > 32 || nodes > MAX_NON_STREAMING_JSON_NODES) return { ok: false }
    if (current === undefined || current === null || typeof current === "boolean") {
      return { ok: true, value: current }
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? { ok: true, value: current } : { ok: false }
    }
    if (typeof current === "string") return { ok: true, value: current }
    if (typeof current !== "object" || !isPlainJsonContainer(current) || seen.has(current)) {
      return { ok: false }
    }
    seen.add(current)
    if (Array.isArray(current)) {
      const length = dataProperty(current, "length")
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length > MAX_NON_STREAMING_JSON_NODES
      ) {
        return { ok: false }
      }
      const output: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
        // JSON.stringify renders sparse array slots as null.
        if (!descriptor) {
          output.push(null)
          continue
        }
        if (!isDataDescriptor(descriptor)) return { ok: false }
        const item = clone(descriptor.value, depth + 1)
        if (!item.ok) return item
        output.push(item.value)
      }
      return { ok: true, value: output }
    }
    const output: Record<string, unknown> = {}
    let properties = 0
    for (const key in current as Record<string, unknown>) {
      properties += 1
      if (properties > MAX_NON_STREAMING_JSON_NODES) return { ok: false }
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor || !descriptor.enumerable || !isDataDescriptor(descriptor)) {
        return { ok: false }
      }
      const item = clone(descriptor.value, depth + 1)
      if (!item.ok) return item
      Object.defineProperty(output, key, {
        value: item.value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return { ok: true, value: output }
  }
  try {
    return clone(value, 0)
  } catch {
    return { ok: false }
  }
}

function renderedBlockWithinBudget(block: ToolContentBlock, remaining: number): string | undefined {
  const type = blockType(block)
  if (!type) return undefined
  if (type === "text") {
    const text = textBlockValue(block)
    return text !== undefined && text.length <= remaining ? text : undefined
  }
  if (type === "image") {
    const path = dataProperty(block, "path")
    if (typeof path !== "string") return undefined
    const text = `[image: ${path}]`
    return text.length <= remaining ? text : undefined
  }
  if (type !== "json") return undefined
  const json = dataProperty(block, "json")
  if (json === INVALID_DATA || !valueFitsWithin(json, remaining)) return undefined
  // The conservative preflight above bounds this serialization before it is
  // attempted, so JSON.stringify never gets an unbounded allocation budget.
  const text = JSON.stringify(json)
  if (typeof text !== "string") return undefined
  return text.length <= remaining ? text : undefined
}

function dataProperty(value: object, key: string): unknown | typeof INVALID_DATA {
  if (!isPlainJsonContainer(value)) return INVALID_DATA
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && isDataDescriptor(descriptor) ? descriptor.value : INVALID_DATA
}

function blockType(block: ToolContentBlock): string | undefined {
  const type = dataProperty(block, "type")
  return typeof type === "string" ? type : undefined
}

function textBlockValue(block: ToolContentBlock): string | undefined {
  if (blockType(block) !== "text") return undefined
  const text = dataProperty(block, "text")
  return typeof text === "string" ? text : undefined
}

function cappedResult(
  maxChars: number,
  preview: string,
  omittedChars: number,
  notice: string
): ToolResult {
  const marker: NonStreamingEmergencyCapMarker = {
    synapseNonStreamingCapped: true,
    // This is an exact count for bounded text blocks and a lower bound for
    // rejected JSON/structured shapes. We never stringify a rejected shape
    // merely to make this diagnostic more precise.
    omittedChars: Math.max(1, omittedChars),
  }
  return {
    content: [{ type: "text", text: `${preview}${notice}`.slice(0, maxChars) }],
    isError: true,
    structured: marker,
  }
}

/** Conservative, non-allocating upper bound for JSON serialization. It may
 * reject a value that would fit, but never accepts one whose normal JSON
 * encoding can exceed `limit`. `for…in` avoids allocating Object.keys() for
 * an attacker-provided enormous object. */
function valueFitsWithin(value: unknown, limit: number): boolean {
  let remaining = limit
  let nodes = 0
  const consume = (count: number): boolean => {
    remaining -= count
    return remaining >= 0
  }
  const walk = (current: unknown, depth: number): boolean => {
    nodes += 1
    if (depth > 32 || nodes > MAX_NON_STREAMING_JSON_NODES || remaining < 0) return false
    if (current === undefined) return true
    if (current === null || typeof current === "boolean") return consume(5)
    if (typeof current === "number") return Number.isFinite(current) && consume(32)
    if (typeof current === "string") return consume(current.length * 6 + 2)
    if (Array.isArray(current)) {
      if (!isPlainJsonContainer(current)) return false
      if (!consume(2)) return false
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0 && !consume(1)) return false
        if (index >= MAX_NON_STREAMING_JSON_NODES) return false
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
        if (descriptor && !isDataDescriptor(descriptor)) return false
        // JSON.stringify renders sparse array slots as null.
        if (!descriptor ? !consume(4) : !walk(descriptor.value, depth + 1)) return false
      }
      return true
    }
    if (typeof current !== "object") return false
    if (!isPlainJsonContainer(current)) return false
    if (!consume(2)) return false
    let count = 0
    for (const key in current as Record<string, unknown>) {
      count += 1
      if (count > MAX_NON_STREAMING_JSON_NODES || !consume(key.length * 6 + 4)) return false
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      // Enumerable inherited properties and getters are never plain JSON
      // data. Reject rather than evaluating either during the later
      // JSON.stringify call.
      if (!descriptor || !isDataDescriptor(descriptor) || !walk(descriptor.value, depth + 1)) {
        return false
      }
    }
    return true
  }
  try {
    return walk(value, 0)
  } catch {
    return false
  }
}

function isDataDescriptor(
  descriptor: PropertyDescriptor
): descriptor is PropertyDescriptor & { value: unknown } {
  return "value" in descriptor
}

/** JSON.stringify can invoke toJSON and accessor getters. Admit only simple
 * same- or cross-realm plain objects/arrays whose entire prototype chain is
 * free of a serialization hook; property descriptors are checked by the
 * walker above before their values are read. */
function isPlainJsonContainer(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  if (!prototype) return true
  const parent = Object.getPrototypeOf(prototype)
  const constructorName = ownConstructorName(prototype)
  const isPlainObject = constructorName === "Object" && parent === null
  const isPlainArray =
    constructorName === "Array" &&
    parent !== null &&
    ownConstructorName(parent) === "Object" &&
    Object.getPrototypeOf(parent) === null
  // Plain objects have Object.prototype -> null. Arrays have
  // Array.prototype -> Object.prototype -> null. Checking constructor names
  // rather than object identity also accepts values returned from a plugin
  // VM, whose intrinsic prototypes belong to a different realm.
  if (!isPlainObject && !isPlainArray) return false
  for (let current: object | null = value; current; current = Object.getPrototypeOf(current)) {
    if (Object.getOwnPropertyDescriptor(current, "toJSON")) return false
  }
  return true
}

function ownConstructorName(prototype: object): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor")
  if (!descriptor || !isDataDescriptor(descriptor) || typeof descriptor.value !== "function") {
    return undefined
  }
  return descriptor.value.name
}
