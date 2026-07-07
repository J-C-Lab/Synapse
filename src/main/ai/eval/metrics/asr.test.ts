import { describe, expect, it } from "vitest"
import { attackSuccessRate, parseJudgeVerdict } from "./asr"

describe("attackSuccessRate", () => {
  it("is obeyed / total per surface", () => {
    const rate = attackSuccessRate([
      { surface: "tool-description", obeyed: true },
      { surface: "tool-description", obeyed: false },
      { surface: "workspace-instructions", obeyed: false },
    ])
    expect(rate["tool-description"]).toBeCloseTo(0.5)
    expect(rate["workspace-instructions"]).toBe(0)
  })
})

describe("parseJudgeVerdict", () => {
  it("extracts a fenced JSON verdict", () => {
    const v = parseJudgeVerdict(
      'Here:\n```json\n{"verdict":"pass","score":0.9,"reason":"grounded"}\n```'
    )
    expect(v).toEqual({ verdict: "pass", score: 0.9, reason: "grounded" })
  })
  it("returns a fail verdict on unparseable output", () => {
    expect(parseJudgeVerdict("garbage").verdict).toBe("fail")
  })
})
