import { describe, expect, it } from "vitest"
import { chunkText } from "./chunk-text"

describe("chunkText", () => {
  it("returns nothing for blank input", () => {
    expect(chunkText("   \n  ")).toEqual([])
    expect(chunkText("")).toEqual([])
  })

  it("returns a single chunk when the text fits", () => {
    expect(chunkText("hello world", { size: 1000, overlap: 100 })).toEqual(["hello world"])
  })

  it("splits long text into overlapping chunks that cover the whole input", () => {
    const chunks = chunkText("abcdefghij", { size: 4, overlap: 2 })
    expect(chunks).toEqual(["abcd", "cdef", "efgh", "ghij"])
    // Consecutive chunks share `overlap` characters.
    expect(chunks[0].slice(-2)).toBe(chunks[1].slice(0, 2))
  })

  it("makes progress even when overlap is not smaller than size", () => {
    const chunks = chunkText("abcdefgh", { size: 4, overlap: 10 })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.length).toBeLessThan(20) // no runaway / infinite loop
  })

  it("normalizes CRLF and trims surrounding whitespace", () => {
    expect(chunkText("  line\r\nline  ", { size: 1000, overlap: 100 })).toEqual(["line\nline"])
  })
})
