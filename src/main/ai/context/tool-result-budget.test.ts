import { describe, expect, it } from "vitest"
import { truncateToolResultText } from "./tool-result-budget"

describe("truncateToolResultText", () => {
  it("returns the original text when under the budget", () => {
    expect(truncateToolResultText("hello")).toBe("hello")
  })

  it("truncates oversized tool output with a notice", () => {
    const text = "x".repeat(100_000)
    const result = truncateToolResultText(text, { maxChars: 24_000 })
    expect(result.length).toBeLessThan(text.length)
    expect(result).toContain("[Synapse truncated tool output: 76000 chars omitted]")
    expect(result.startsWith("x".repeat(24_000))).toBe(true)
  })
})
