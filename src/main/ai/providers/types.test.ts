import { describe, expect, it } from "vitest"
import { totalTokens } from "./types"

describe("totalTokens", () => {
  it("sums input, output, and both cache token counts", () => {
    expect(
      totalTokens({
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 2,
      })
    ).toBe(20)
  })
})
