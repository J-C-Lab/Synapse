import { describe, expect, it } from "vitest"
import { highlightToHtml } from "./shiki"

// These exercise the real shiki highlighter with the JavaScript RegExp engine
// (no WASM), which is what the strict production CSP (script-src 'self') allows.

describe("highlightToHtml", () => {
  it("highlights a supported language into shiki markup", async () => {
    const html = await highlightToHtml("const a = 1", "ts")
    expect(html).not.toBeNull()
    expect(html).toContain("shiki")
    expect(html).toContain("const")
  })

  it("resolves common aliases to a grammar", async () => {
    expect(await highlightToHtml("print('hi')", "py")).toContain("shiki")
  })

  it("returns null for an unknown language", async () => {
    expect(await highlightToHtml("x", "not-a-real-language")).toBeNull()
  })

  it("returns null for empty code", async () => {
    expect(await highlightToHtml("   ", "ts")).toBeNull()
  })
})
