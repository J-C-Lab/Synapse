import { describe, expect, it } from "vitest"
import { redactFields } from "./redact"

describe("redactFields", () => {
  it("redacts top-level secret-named keys, case-insensitively", () => {
    expect(redactFields({ apiKey: "sk-1", api_key: "sk-2", Token: "t", note: "ok" })).toEqual({
      apiKey: "[redacted]",
      api_key: "[redacted]",
      Token: "[redacted]",
      note: "ok",
    })
  })

  it("covers password, secret, authorization, cookie", () => {
    expect(
      redactFields({ password: "p", secretValue: "s", authorization: "Bearer x", cookie: "c" })
    ).toEqual({
      password: "[redacted]",
      secretValue: "[redacted]",
      authorization: "[redacted]",
      cookie: "[redacted]",
    })
  })

  it("recurses into nested objects and arrays", () => {
    expect(
      redactFields({ outer: { token: "t", keep: 1 }, list: [{ secret: "s" }, { ok: 2 }] })
    ).toEqual({
      outer: { token: "[redacted]", keep: 1 },
      list: [{ secret: "[redacted]" }, { ok: 2 }],
    })
  })

  it("leaves non-secret keys and primitive values untouched", () => {
    expect(redactFields({ count: 3, name: "lan", flag: true })).toEqual({
      count: 3,
      name: "lan",
      flag: true,
    })
  })

  it("returns primitives as-is", () => {
    expect(redactFields("hello")).toBe("hello")
    expect(redactFields(42)).toBe(42)
    expect(redactFields(null)).toBe(null)
  })

  it("caps recursion depth to avoid runaway nesting", () => {
    const deep: Record<string, unknown> = {}
    let cur = deep
    for (let i = 0; i < 10; i++) {
      cur.child = {}
      cur = cur.child as Record<string, unknown>
    }
    // Should not throw and should terminate with a depth-capped marker somewhere.
    expect(() => redactFields(deep)).not.toThrow()
    expect(JSON.stringify(redactFields(deep))).toContain("[depth-capped]")
  })
})
