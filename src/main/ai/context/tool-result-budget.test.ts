import { describe, expect, it } from "vitest"
import { truncateToolResultText } from "./tool-result-budget"

describe("truncateToolResultText", () => {
  it("returns text under budget unchanged", () => {
    expect(truncateToolResultText("hello")).toBe("hello")
  })

  it("truncates oversized tool output with an omission notice", () => {
    const result = truncateToolResultText("x".repeat(100), { maxChars: 12 })

    expect(result).toBe(`${"x".repeat(12)}\n\n[Synapse truncated tool output: 88 chars omitted]`)
  })
})
