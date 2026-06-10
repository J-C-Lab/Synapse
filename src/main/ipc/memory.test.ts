import { describe, expect, it } from "vitest"
import { coerceIngest } from "./memory"

describe("coerceIngest", () => {
  it("accepts a well-formed payload", () => {
    expect(coerceIngest({ source: "notes.md", text: "hello" })).toEqual({
      source: "notes.md",
      text: "hello",
    })
  })

  it("rejects missing or blank fields", () => {
    expect(() => coerceIngest({ source: "notes.md" })).toThrow(/text must be a string/)
    expect(() => coerceIngest({ source: "  ", text: "x" })).toThrow(/source must be a string/)
    expect(() => coerceIngest(null)).toThrow(/must be an object/)
  })
})
