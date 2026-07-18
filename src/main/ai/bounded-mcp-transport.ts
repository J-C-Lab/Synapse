import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { ChildProcess } from "node:child_process"
import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"

/** A hard byte limit before external MCP JSON is parsed into JS objects. */
export const MCP_MAX_INBOUND_FRAME_BYTES = 2 * 1024 * 1024

export class McpFrameLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpFrameLimitError"
  }
}

/** Fetch wrapper for HTTP/SSE MCP transports. It rejects a declared oversized
 * ordinary response before reading it and counts streamed bytes before the
 * SDK can buffer/JSON-parse them. SSE is deliberately bounded per event,
 * rather than across its long-lived connection: many individually-safe
 * server events must not eventually disconnect a healthy MCP session. */
export async function boundedMcpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  const isEventStream = /^text\/event-stream(?:\s*;|$)/i.test(
    response.headers.get("content-type") ?? ""
  )
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (!isEventStream && Number.isFinite(declared) && declared > MCP_MAX_INBOUND_FRAME_BYTES) {
    await response.body?.cancel()
    throw new McpFrameLimitError("MCP HTTP response exceeds configured maximum")
  }
  if (!response.body) return response
  const reader = response.body.getReader()
  let received = 0
  const sseFrames = isEventStream ? new SseFrameCounter(MCP_MAX_INBOUND_FRAME_BYTES) : undefined
  const boundedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) {
        controller.close()
        return
      }
      try {
        if (sseFrames) {
          sseFrames.consume(next.value)
        } else {
          received += next.value.byteLength
          if (received > MCP_MAX_INBOUND_FRAME_BYTES) {
            throw new McpFrameLimitError("MCP HTTP response exceeded configured maximum")
          }
        }
      } catch (err) {
        await reader.cancel()
        controller.error(err)
        return
      }
      controller.enqueue(next.value)
    },
    async cancel() {
      await reader.cancel()
    },
  })
  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** Counts complete SSE events including all field lines. A blank line ends an
 * event; the counter resets only then, so one oversized fragmented event is
 * rejected while any number of separately bounded events can share the same
 * long-lived HTTP response. */
class SseFrameCounter {
  private eventBytes = 0
  private lineHasContent = false
  /** A CR may be a standalone terminator or the first half of CRLF. Keep it
   * across stream chunks so the following LF does not become a second empty
   * line/event boundary. */
  private pendingCarriageReturn = false
  private pendingCarriageReturnEndedEvent = false

  constructor(private readonly maxBytes: number) {}

  consume(chunk: Uint8Array): void {
    for (const byte of chunk) {
      this.eventBytes += 1
      if (this.eventBytes > this.maxBytes) {
        throw new McpFrameLimitError("MCP SSE event exceeded configured maximum")
      }
      if (this.pendingCarriageReturn) {
        const endedEvent = this.pendingCarriageReturnEndedEvent
        this.pendingCarriageReturn = false
        this.pendingCarriageReturnEndedEvent = false
        if (byte === 0x0a) {
          // The CR already reset a completed event; LF is its other line
          // ending byte, not the first byte of the following event.
          if (endedEvent) this.eventBytes = 0
          continue
        }
      }
      if (byte === 0x0d) {
        this.pendingCarriageReturnEndedEvent = this.finishLine()
        this.pendingCarriageReturn = true
      } else if (byte === 0x0a) {
        this.finishLine()
      } else {
        this.lineHasContent = true
      }
    }
  }

  private finishLine(): boolean {
    // An empty line terminates the current event. SSE permits CR, LF, and
    // CRLF line endings, so this must not be coupled to LF alone.
    const endedEvent = !this.lineHasContent
    if (endedEvent) this.eventBytes = 0
    this.lineHasContent = false
    return endedEvent
  }
}

/** Minimal stdio MCP transport with bounded line framing. The SDK's stock
 * ReadBuffer concatenates arbitrary stdout until a newline, which lets an
 * external server force unbounded memory before JSON.parse. This checks the
 * byte length while streaming and terminates the offending child before a
 * frame can be parsed or copied into a ToolResult. */
export class BoundedStdioMcpTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  private child?: ChildProcess
  private buffer = Buffer.alloc(0)

  constructor(
    private readonly options: {
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      maxFrameBytes?: number
    }
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new Error("bounded MCP stdio transport already started")
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        env: this.options.env,
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "inherit"],
        shell: false,
        windowsHide: true,
      })
      this.child = child
      child.once("error", (err) => {
        reject(err)
        this.onerror?.(err)
      })
      child.once("spawn", resolve)
      child.once("close", () => {
        if (this.child === child) this.child = undefined
        this.buffer = Buffer.alloc(0)
        this.onclose?.()
      })
      child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk))
      child.stdout?.on("error", (err) => this.onerror?.(err))
      child.stdin?.on("error", (err) => this.onerror?.(err))
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child
    if (!child?.stdin) throw new Error("MCP transport is not connected")
    const encoded = Buffer.from(`${JSON.stringify(message)}\n`, "utf8")
    if (encoded.length > this.maxFrameBytes) {
      throw new McpFrameLimitError("outgoing MCP frame exceeds configured maximum")
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin!.write(encoded, (err) => (err ? reject(err) : resolve()))
    })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = undefined
    this.buffer = Buffer.alloc(0)
    child.stdin?.end()
    if (!child.killed) child.kill()
  }

  private get maxFrameBytes(): number {
    return this.options.maxFrameBytes ?? MCP_MAX_INBOUND_FRAME_BYTES
  }

  private onData(chunk: Buffer): void {
    if (this.buffer.length + chunk.length > this.maxFrameBytes) {
      this.failFrameLimit("MCP stdio frame exceeded configured maximum before newline")
      return
    }
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) return
      if (newline > this.maxFrameBytes) {
        this.failFrameLimit("MCP stdio frame exceeded configured maximum")
        return
      }
      const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "")
      this.buffer = this.buffer.subarray(newline + 1)
      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)))
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  private failFrameLimit(message: string): void {
    const error = new McpFrameLimitError(message)
    this.buffer = Buffer.alloc(0)
    const child = this.child
    this.child = undefined
    if (child && !child.killed) child.kill()
    this.onerror?.(error)
  }
}
