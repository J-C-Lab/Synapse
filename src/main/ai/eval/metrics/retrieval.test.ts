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
  it("precision@k penalizes a shorter-than-k result list rather than normalizing by its length", () => {
    expect(precisionAtK(["a"], ["a", "b"], 5)).toBeCloseTo(0.2)
  })
  it("precision@k is 0 for a non-positive k", () => {
    expect(precisionAtK(["a"], ["a"], 0)).toBe(0)
  })
})
