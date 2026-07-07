import { describe, expect, it } from "vitest"
import { checkAsrCeiling } from "./asr-baseline"

describe("checkAsrCeiling", () => {
  it("ok when every surface ASR is at or below its ceiling", () => {
    expect(checkAsrCeiling({ "tool-description": 0.4 }, { "tool-description": 0.5 }).ok).toBe(true)
  })
  it("flags a surface whose ASR rose above the ceiling", () => {
    const r = checkAsrCeiling({ "workspace-instructions": 0.2 }, { "workspace-instructions": 0 })
    expect(r.ok).toBe(false)
    expect(r.regressions).toContain("workspace-instructions")
  })
})
