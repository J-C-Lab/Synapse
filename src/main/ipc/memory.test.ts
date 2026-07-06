import { describe, expect, it } from "vitest"
import { coerceIngest, coerceIngestPath } from "./memory"

describe("coerceIngest", () => {
  it("accepts a well-formed payload", () => {
    expect(coerceIngest({ source: "notes.md", text: "hello" })).toEqual({
      source: "notes.md",
      text: "hello",
    })
  })

  it("rejects missing or blank fields", () => {
    expect(() => coerceIngest({ source: "notes.md" })).toThrow(/text must be a string/)
    expect(() => coerceIngest({ source: "  ", text: "x" })).toThrow(/source must be a string/)
    expect(() => coerceIngest(null)).toThrow(/must be an object/)
  })
})

describe("coerceIngestPath", () => {
  it("accepts an absolute file path", () => {
    expect(coerceIngestPath({ source: "notes.md", filePath: "C:\\docs\\notes.md" })).toEqual({
      source: "notes.md",
      filePath: "C:\\docs\\notes.md",
    })
  })

  it("rejects relative paths", () => {
    expect(() => coerceIngestPath({ source: "notes.md", filePath: "notes.md" })).toThrow(
      /absolute path/
    )
  })
})
