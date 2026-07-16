import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  CANONICAL_JSON_ALGORITHM_VERSION,
  canonicalHash,
  CanonicalJsonError,
  canonicalStringify,
} from "./canonical-json"

describe("canonicalStringify", () => {
  it("sorts object keys so insertion order does not affect the encoding", () => {
    const a = canonicalStringify({ b: 1, a: 2 })
    const b = canonicalStringify({ a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  it("preserves array order — reordering an array changes the encoding", () => {
    const a = canonicalStringify([1, 2, 3])
    const b = canonicalStringify([3, 2, 1])
    expect(a).not.toBe(b)
  })

  it("sorts keys at every nesting level", () => {
    const value = canonicalStringify({
      z: { d: 1, c: 2 },
      a: [{ y: 1, x: 2 }],
    })
    expect(value).toBe('{"a":[{"x":2,"y":1}],"z":{"c":2,"d":1}}')
  })

  it("throws CanonicalJsonError on NaN", () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow(CanonicalJsonError)
  })

  it("throws CanonicalJsonError on Infinity and -Infinity", () => {
    expect(() => canonicalStringify(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError)
    expect(() => canonicalStringify(Number.NEGATIVE_INFINITY)).toThrow(CanonicalJsonError)
  })

  it("throws CanonicalJsonError on a non-finite number nested inside an object", () => {
    expect(() => canonicalStringify({ a: [1, Number.NaN] })).toThrow(CanonicalJsonError)
  })

  it("omits undefined object properties, matching JSON.stringify's optional-field behavior", () => {
    expect(canonicalStringify({ a: 1, b: undefined as unknown as number })).toBe('{"a":1}')
  })

  it("still throws on undefined found as an array element or top-level value", () => {
    expect(() => canonicalStringify([1, undefined as unknown as number])).toThrow(
      CanonicalJsonError
    )
    expect(() => canonicalStringify(undefined as unknown as null)).toThrow(CanonicalJsonError)
  })

  it("encodes null, booleans, and finite numbers normally", () => {
    expect(canonicalStringify(null)).toBe("null")
    expect(canonicalStringify(true)).toBe("true")
    expect(canonicalStringify(false)).toBe("false")
    expect(canonicalStringify(0)).toBe("0")
    expect(canonicalStringify(-1.5)).toBe("-1.5")
  })
})

describe("canonicalHash", () => {
  it("is deterministic for equal values regardless of key order", () => {
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }))
  })

  it("differs for structurally different values", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }))
  })

  it("is a lowercase hex sha256-shaped digest", () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it("bakes the algorithm version into the hash, not just the JSON string", () => {
    const value = { a: 1 }
    const rawSha256 = createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex")
    expect(canonicalHash(value)).not.toBe(rawSha256)
    expect(CANONICAL_JSON_ALGORITHM_VERSION).toBe(1)
  })
})
