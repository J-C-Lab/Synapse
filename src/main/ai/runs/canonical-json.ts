import { createHash } from "node:crypto"

// Deterministic JSON encoding for authority/context freezing. Two deep-equal
// values always encode to the same string (object keys sorted at every
// level; arrays keep their order since order is meaningful there), and the
// hash mixes in an explicit algorithm version so a future change to this
// encoding can never be silently reinterpreted against an old hash.

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson }

export class CanonicalJsonError extends Error {}

export const CANONICAL_JSON_ALGORITHM_VERSION = 1

export function canonicalStringify(value: CanonicalJson): string {
  return encode(value)
}

function encode(value: CanonicalJson): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    // JSON.stringify silently turns NaN/±Infinity into "null", which would
    // make a genuinely-null field and a corrupt non-finite number hash
    // identically. Reject them instead of encoding a lossy sentinel.
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(`canonical JSON requires finite numbers, got: ${value}`)
    }
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`
  if (typeof value === "object") {
    // Optional domain fields (`field?: T`) are `undefined` at runtime even
    // though CanonicalJson has no explicit undefined member. Omit them, same
    // as JSON.stringify does for object properties — only an array element
    // or a bare top-level undefined is a genuine encoding error below.
    const record = value as Record<string, CanonicalJson | undefined>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key]!)}`).join(",")}}`
  }
  throw new CanonicalJsonError(`unsupported value in canonical JSON: ${typeof value}`)
}

/** SHA-256 of the canonical UTF-8 encoding, prefixed with the algorithm
 *  version so a future encoding change invalidates every prior hash instead
 *  of silently colliding with it. */
export function canonicalHash(value: CanonicalJson): string {
  return createHash("sha256")
    .update(`v${CANONICAL_JSON_ALGORITHM_VERSION}:${canonicalStringify(value)}`, "utf8")
    .digest("hex")
}
