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

export interface JsonLineReader {
  /** Resolves with the next complete line's parsed JSON. Rejects on
   *  timeout (if `timeoutMs` is given — omit it to wait indefinitely,
   *  bounded only by the socket's own error/close), socket error, socket
   *  close, or dispose(). Safe to await sequentially. */
  next: (timeoutMs?: number) => Promise<unknown>
  /** Removes all listeners this reader installed and rejects every
   *  currently-pending next() call. Idempotent. */
  dispose: () => void
}

export function createJsonLineReader(socket: Socket, maxBytes = DEFAULT_MAX_BYTES): JsonLineReader {
  let buffer = ""
  let disposed = false
  const waiters: Array<{
    resolve: (value: unknown) => void
    reject: (err: Error) => void
    timer?: ReturnType<typeof setTimeout>
  }> = []

  function settleNextWaiter(): void {
    const newline = buffer.indexOf("\n")
    if (newline === -1) return
    const waiter = waiters.shift()
    if (!waiter) return
    if (waiter.timer) clearTimeout(waiter.timer)
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    try {
      waiter.resolve(JSON.parse(line))
    } catch (err) {
      waiter.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  function rejectAll(err: Error): void {
    const pending = waiters.splice(0, waiters.length)
    for (const waiter of pending) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(err)
    }
  }

  function onData(chunk: Buffer): void {
    buffer += chunk.toString("utf-8")
    if (buffer.length > maxBytes) {
      const err = new Error(`line exceeded ${maxBytes} bytes`)
      socket.destroy()
      rejectAll(err)
      return
    }
    while (buffer.includes("\n") && waiters.length > 0) settleNextWaiter()
  }

  function onError(err: Error): void {
    rejectAll(err)
  }

  function onClose(): void {
    rejectAll(new Error("socket closed before a response arrived"))
  }

  socket.on("data", onData)
  socket.on("error", onError)
  socket.on("close", onClose)

  return {
    next(timeoutMs?: number): Promise<unknown> {
      if (disposed) return Promise.reject(new Error("reader disposed"))
      return new Promise((resolve, reject) => {
        const waiter: (typeof waiters)[number] = { resolve, reject }
        if (timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index !== -1) waiters.splice(index, 1)
            reject(new Error("timed out waiting for a response"))
          }, timeoutMs)
        }
        waiters.push(waiter)
        settleNextWaiter()
      })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
      rejectAll(new Error("reader disposed"))
    },
  }
}
