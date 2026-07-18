import { afterEach, describe, expect, it, vi } from "vitest"
import { boundedMcpFetch, MCP_MAX_INBOUND_FRAME_BYTES } from "./bounded-mcp-transport"

afterEach(() => {
  vi.unstubAllGlobals()
})

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++]
      if (!chunk) controller.close()
      else controller.enqueue(chunk)
    },
  })
}

async function consume(response: Response): Promise<number> {
  const reader = response.body!.getReader()
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) return total
    total += next.value.byteLength
  }
}

describe("boundedMcpFetch", () => {
  it("allows a long-lived SSE response with many individually bounded events", async () => {
    const encoder = new TextEncoder()
    const event = encoder.encode(`data: ${"x".repeat(900_000)}\n\n`)
    const total = event.byteLength * 3
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(byteStream([event, event, event]), {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              // A legitimate EventSource can exceed the ordinary response cap
              // over its lifetime; this declared total must not reject it.
              "content-length": String(total),
            },
          })
      )
    )

    expect(await consume(await boundedMcpFetch("https://mcp.example/sse"))).toBe(total)
  })

  it("rejects one oversized fragmented SSE event before delivering it", async () => {
    const encoder = new TextEncoder()
    const first = encoder.encode(`data: ${"x".repeat(MCP_MAX_INBOUND_FRAME_BYTES - 10)}`)
    const second = encoder.encode("xxxxxxxxxxxx\n\n")
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(byteStream([first, second]), {
            headers: { "content-type": "text/event-stream" },
          })
      )
    )

    const response = await boundedMcpFetch("https://mcp.example/sse")
    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toMatchObject({ done: false })
    await expect(reader.read()).rejects.toThrow(/SSE event exceeded/)
  })
})
