import { describe, expect, it } from "vitest"
import { precisionAtK, recall } from "./retrieval"

describe("retrieval metrics", () => {
  it("precision@k = relevant retrieved / k", () => {
    expect(precisionAtK(["a", "x", "b"], ["a", "b", "c"], 3)).toBeCloseTo(2 / 3)
  })
  it("recall = relevant retrieved / relevant total", () => {
    expect(recall(["a", "x"], ["a", "b"])).toBeCloseTo(1 / 2)
  })
  it("recall is 1 when there is nothing relevant to find", () => {
    expect(recall([], [])).toBe(1)
  })
})
