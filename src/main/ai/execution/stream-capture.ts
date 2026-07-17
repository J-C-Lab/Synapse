// Pure head/tail live-preview tee for a byte stream (design §"Recoverable
// artifact backend" / Task 18). Wraps any AsyncIterable<Uint8Array> (a Node
// Readable satisfies this) and re-yields the exact same bytes unchanged —
// so the wrapped iterable can be handed straight to
// AgentArtifactStore.capture() as its `input` — while accumulating a
// bounded "head" buffer (the first N bytes ever seen) and a bounded "tail"
// ring buffer (the last N bytes seen so far), each readable at any time —
// including mid-iteration — as a UTF-8 decoded preview string.
//
// This module intentionally knows nothing about artifacts, child
// processes, or quotas: it is a small, independently testable transform
// that command-runner.ts wires into whichever producer needs a bounded
// live preview alongside a full durable capture.
//
// UTF-8 decoding note: a preview may end (head) or begin (tail) mid a
// multi-byte UTF-8 sequence when the boundary happens to land inside one.
// Both previews are decoded with `TextDecoder`'s default non-fatal mode,
// which renders a truncated/incomplete sequence as the U+FFFD replacement
// character rather than throwing. This is a deliberate, simple choice:
// previews are informational only and are never round-tripped back into
// bytes, so an occasional replacement character at a preview boundary is
// an acceptable, documented trade-off.

export interface StreamCaptureOptions {
  /** Max bytes retained from the START of the stream. */
  headBytes: number
  /** Max bytes retained from the END of the stream (whatever has been seen
   *  so far, if the stream is still in flight). */
  tailBytes: number
}

export interface StreamCapture {
  /** Re-yields the source's bytes completely unchanged; consuming this is
   *  what drives both the head and tail accumulation below. */
  bytes: AsyncIterable<Uint8Array>
  /** Decoded preview of the first `headBytes` bytes seen so far. Safe to
   *  call at any point, including mid-iteration or before iteration starts
   *  (returns an empty string). */
  headPreview: () => string
  /** Decoded preview of the last `tailBytes` bytes seen so far. Safe to
   *  call at any point, including mid-iteration or before iteration starts
   *  (returns an empty string). */
  tailPreview: () => string
}

/** Accumulates up to `capacity` bytes from the start of a stream, then
 *  silently drops everything after. */
class HeadBuffer {
  private readonly chunks: Uint8Array[] = []
  private length = 0

  constructor(private readonly capacity: number) {}

  push(chunk: Uint8Array): void {
    if (this.length >= this.capacity || chunk.length === 0) return
    const remaining = this.capacity - this.length
    const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
    // Copy rather than retain the original view: the caller may reuse the
    // chunk's backing buffer for the next read (Node's Buffer pooling does
    // exactly this), so holding a reference into it would be unsafe.
    this.chunks.push(Uint8Array.from(slice))
    this.length += slice.length
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

/** Ring buffer retaining only the last `capacity` bytes seen. */
class TailBuffer {
  private readonly buffer: Uint8Array
  private length = 0

  constructor(private readonly capacity: number) {
    this.buffer = new Uint8Array(capacity)
  }

  push(chunk: Uint8Array): void {
    if (this.capacity === 0 || chunk.length === 0) return
    if (chunk.length >= this.capacity) {
      this.buffer.set(chunk.subarray(chunk.length - this.capacity))
      this.length = this.capacity
      return
    }
    const overflow = this.length + chunk.length - this.capacity
    if (overflow > 0) {
      this.buffer.copyWithin(0, overflow, this.length)
      this.length -= overflow
    }
    this.buffer.set(chunk, this.length)
    this.length += chunk.length
  }

  bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length)
  }
}

function decode(bytes: Uint8Array): string {
  // A fresh TextDecoder per call: decode() is non-streaming (no internal
  // state carried across calls), so head/tail previews never interfere
  // with each other and each call always reflects the buffer's current
  // contents exactly.
  return new TextDecoder("utf-8").decode(bytes)
}

/** Wraps `source`, re-yielding its bytes unchanged while accumulating
 *  bounded head/tail previews as a side effect of iteration. */
export function captureHeadTail(
  source: AsyncIterable<Uint8Array>,
  options: StreamCaptureOptions
): StreamCapture {
  const head = new HeadBuffer(Math.max(0, options.headBytes))
  const tail = new TailBuffer(Math.max(0, options.tailBytes))

  async function* tee(): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      head.push(chunk)
      tail.push(chunk)
      yield chunk
    }
  }

  return {
    bytes: tee(),
    headPreview: () => decode(head.bytes()),
    tailPreview: () => decode(tail.bytes()),
  }
}
