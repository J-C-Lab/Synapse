import { describe, expect, it } from "vitest"
import { requireString } from "./validation"

describe("requireString", () => {
  it("returns a non-blank string unchanged", () => {
    expect(requireString("hello", "field")).toBe("hello")
  })

  it("rejects a non-string, empty, or whitespace-only value", () => {
    expect(() => requireString(undefined, "field")).toThrow("field must be a string.")
    expect(() => requireString(123, "field")).toThrow("field must be a string.")
    expect(() => requireString("   ", "field")).toThrow("field must be a string.")
    expect(() => requireString("", "field")).toThrow("field must be a string.")
  })
})
