import { describe, expect, it } from "vitest"
import { scrubText } from "./audit-sanitize"

describe("scrubText", () => {
  it("redacts key=value secret-looking text", () => {
    expect(scrubText("token=sk-abc123 and more text")).toBe("token=[redacted] and more text")
  })

  it("redacts bare secret-shaped tokens", () => {
    expect(scrubText("here is sk-abcdefghijklmnop for you")).toBe("here is [redacted] for you")
  })

  it("leaves ordinary text untouched", () => {
    expect(scrubText("nothing sensitive here")).toBe("nothing sensitive here")
  })
})
