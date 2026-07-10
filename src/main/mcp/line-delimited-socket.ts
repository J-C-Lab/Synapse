import type { Buffer } from "node:buffer"
import type { Socket } from "node:net"

// Wire framing shared by headless-approval-server.ts (main process) and
// gui-approval-client.ts (headless process): one JSON value per line,
// newline-terminated. Deliberately not a general-purpose protocol —
// forwarding one approval request and getting back one boolean is the only
// thing this needs to do (see the spec's non-goal: "not a general
// headless<->GUI message bus").

export function writeJsonLine(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`)
}

const DEFAULT_MAX_BYTES = 64 * 1024

export function readJsonLine(
  socket: Socket,
  timeoutMs: number,
  maxBytes = DEFAULT_MAX_BYTES
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    let timer: ReturnType<typeof setTimeout>

    function cleanup(): void {
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    function onData(chunk: Buffer): void {
      buffer += chunk.toString("utf-8")
      if (buffer.length > maxBytes) {
        cleanup()
        socket.destroy()
        reject(new Error(`line exceeded ${maxBytes} bytes`))
        return
      }
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      cleanup()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    function onError(err: Error): void {
      cleanup()
      reject(err)
    }
    function onClose(): void {
      cleanup()
      reject(new Error("socket closed before a response arrived"))
    }

    timer = setTimeout(() => {
      cleanup()
      reject(new Error("timed out waiting for a response"))
    }, timeoutMs)

    socket.on("data", onData)
    socket.on("error", onError)
    socket.on("close", onClose)
  })
}
