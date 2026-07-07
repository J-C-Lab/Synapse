import { describe, expect, it } from "vitest"
import { buildJudgePrompt } from "./judge"

describe("buildJudgePrompt", () => {
  it("embeds context and answer and asks for a JSON verdict", () => {
    const p = buildJudgePrompt({ rubric: "grounded?", context: "the sky is blue", answer: "blue" })
    expect(p).toContain("grounded?")
    expect(p).toContain("the sky is blue")
    expect(p).toContain("verdict")
  })
})
