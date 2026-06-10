import { describe, expect, it } from "vitest"
import { extractLanguage } from "./code-lang"

describe("extractLanguage", () => {
  it("reads the language from a language-* class", () => {
    expect(extractLanguage("language-ts")).toBe("ts")
    expect(extractLanguage("language-python hljs")).toBe("python")
  })

  it("returns an empty string when no language class is present", () => {
    expect(extractLanguage(undefined)).toBe("")
    expect(extractLanguage("hljs")).toBe("")
  })
})
