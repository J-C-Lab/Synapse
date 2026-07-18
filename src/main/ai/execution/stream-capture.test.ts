import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { captureHeadTail } from "./stream-capture"

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function* gen(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk
}

async function drain(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

describe("captureHeadTail — passthrough", () => {
  it("yields the exact same bytes unchanged, chunk for chunk", async () => {
    const chunks = [bytesOf("alpha "), bytesOf("beta "), bytesOf("gamma")]
    const tee = captureHeadTail(gen(chunks), { headBytes: 1000, tailBytes: 1000 })
    const collected = await drain(tee.bytes)
    expect(collected).toEqual(chunks)
    expect(Buffer.concat(collected.map((c) => Buffer.from(c))).toString("utf-8")).toBe(
      "alpha beta gamma"
    )
  })

  it("works with a plain async generator — no real process or stream involved", async () => {
    const tee = captureHeadTail(gen([bytesOf("x")]), { headBytes: 10, tailBytes: 10 })
    await drain(tee.bytes)
    expect(tee.headPreview()).toBe("x")
    expect(tee.tailPreview()).toBe("x")
  })
})

describe("captureHeadTail — head preview", () => {
  it("retains only the first N bytes across multiple chunks", async () => {
    const chunks = [bytesOf("0123456789"), bytesOf("abcdefghij")]
    const tee = captureHeadTail(gen(chunks), { headBytes: 12, tailBytes: 1000 })
    await drain(tee.bytes)
    expect(tee.headPreview()).toBe("0123456789ab")
  })

  it("stops accumulating once the head cap is reached, ignoring later chunks entirely", async () => {
    const chunks = [bytesOf("aaaaa"), bytesOf("bbbbb"), bytesOf("ccccc")]
    const tee = captureHeadTail(gen(chunks), { headBytes: 5, tailBytes: 1000 })
    await drain(tee.bytes)
    expect(tee.headPreview()).toBe("aaaaa")
  })

  it("is empty before any bytes are consumed", () => {
    const tee = captureHeadTail(gen([bytesOf("hello")]), { headBytes: 10, tailBytes: 10 })
    expect(tee.headPreview()).toBe("")
  })

  it("is available mid-iteration, reflecting only what's been consumed so far", async () => {
    const chunks = [bytesOf("first-"), bytesOf("second-"), bytesOf("third")]
    const tee = captureHeadTail(gen(chunks), { headBytes: 1000, tailBytes: 1000 })
    const iterator = tee.bytes[Symbol.asyncIterator]()
    await iterator.next()
    expect(tee.headPreview()).toBe("first-")
    await iterator.next()
    expect(tee.headPreview()).toBe("first-second-")
  })

  it("handles headBytes: 0 without accumulating anything", async () => {
    const tee = captureHeadTail(gen([bytesOf("hello")]), { headBytes: 0, tailBytes: 10 })
    await drain(tee.bytes)
    expect(tee.headPreview()).toBe("")
  })

  it("truncates a single oversized chunk to the head cap in one shot", async () => {
    const tee = captureHeadTail(gen([bytesOf("0123456789")]), { headBytes: 4, tailBytes: 1000 })
    await drain(tee.bytes)
    expect(tee.headPreview()).toBe("0123")
  })
})

describe("captureHeadTail — tail preview", () => {
  it("retains only the last N bytes across multiple chunks", async () => {
    const chunks = [bytesOf("0123456789"), bytesOf("abcdefghij")]
    const tee = captureHeadTail(gen(chunks), { headBytes: 1000, tailBytes: 12 })
    await drain(tee.bytes)
    expect(tee.tailPreview()).toBe("89abcdefghij")
  })

  it("keeps sliding as more chunks arrive, always reflecting only the most recent bytes", async () => {
    const chunks = [bytesOf("aaaaa"), bytesOf("bbbbb"), bytesOf("ccccc")]
    const tee = captureHeadTail(gen(chunks), { headBytes: 1000, tailBytes: 5 })
    await drain(tee.bytes)
    expect(tee.tailPreview()).toBe("ccccc")
  })

  it("a single chunk larger than the tail cap keeps only its own trailing slice", async () => {
    const tee = captureHeadTail(gen([bytesOf("0123456789")]), { headBytes: 1000, tailBytes: 4 })
    await drain(tee.bytes)
    expect(tee.tailPreview()).toBe("6789")
  })

  it("is empty before any bytes are consumed", () => {
    const tee = captureHeadTail(gen([bytesOf("hello")]), { headBytes: 10, tailBytes: 10 })
    expect(tee.tailPreview()).toBe("")
  })

  it("handles tailBytes: 0 without accumulating anything", async () => {
    const tee = captureHeadTail(gen([bytesOf("hello")]), { headBytes: 10, tailBytes: 0 })
    await drain(tee.bytes)
    expect(tee.tailPreview()).toBe("")
  })

  it("updates progressively mid-iteration as more chunks slide the window", async () => {
    const chunks = [bytesOf("aaaaa"), bytesOf("bbbbb"), bytesOf("ccccc")]
    const tee = captureHeadTail(gen(chunks), { headBytes: 1000, tailBytes: 5 })
    const iterator = tee.bytes[Symbol.asyncIterator]()
    await iterator.next()
    expect(tee.tailPreview()).toBe("aaaaa")
    await iterator.next()
    expect(tee.tailPreview()).toBe("bbbbb")
    await iterator.next()
    expect(tee.tailPreview()).toBe("ccccc")
  })
})

describe("captureHeadTail — head and tail overlap on short content", () => {
  it("both previews may contain the full content when it's shorter than either cap", async () => {
    const tee = captureHeadTail(gen([bytesOf("short")]), { headBytes: 100, tailBytes: 100 })
    await drain(tee.bytes)
    expect(tee.headPreview()).toBe("short")
    expect(tee.tailPreview()).toBe("short")
  })
})

describe("captureHeadTail — multi-byte UTF-8 boundaries", () => {
  it("decodes a head preview that ends mid a multi-byte sequence without throwing", async () => {
    // "é" is 2 bytes (0xC3 0xA9) in UTF-8; a 2-byte head cap lands exactly
    // between "h" and the complete "é", so nothing is actually split here —
    // use a 3-byte cap against "h" + 2-byte "é" + "l" to land the cut mid
    // multi-byte content instead (byte 2 splits "é").
    const text = "héllo" // "héllo"
    const tee = captureHeadTail(gen([bytesOf(text)]), { headBytes: 2, tailBytes: 1000 })
    await drain(tee.bytes)
    expect(() => tee.headPreview()).not.toThrow()
    const preview = tee.headPreview()
    expect(preview.startsWith("h")).toBe(true)
    expect(preview).toContain("�")
  })

  it("decodes a tail preview that begins mid a multi-byte sequence without throwing", async () => {
    const text = "héllo" // "héllo" — é (2 bytes) + l + l + o = 5 bytes after "h"
    const tee = captureHeadTail(gen([bytesOf(text)]), { headBytes: 1000, tailBytes: 4 })
    await drain(tee.bytes)
    expect(() => tee.tailPreview()).not.toThrow()
    const preview = tee.tailPreview()
    expect(preview.endsWith("llo")).toBe(true)
  })

  it("round-trips cleanly when a multi-byte character is fully contained on both boundaries", async () => {
    const text = "héllo wörld 你好 🎉"
    const tee = captureHeadTail(gen([bytesOf(text)]), { headBytes: 1000, tailBytes: 1000 })
    await drain(tee.bytes)
    expect(tee.headPreview()).toBe(text)
    expect(tee.tailPreview()).toBe(text)
  })
})
