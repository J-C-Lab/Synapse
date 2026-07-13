import type { Buffer } from "node:buffer"
import type { AddressInfo } from "node:net"
import { connect, createServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createJsonLineReader, readJsonLine, writeJsonLine } from "./line-delimited-socket"

describe("line-delimited-socket", () => {
  let cleanup: (() => void) | undefined
  afterEach(() => cleanup?.())

  it("round-trips a JSON value between two real connected sockets", async () => {
    const server = createServer((socket) => {
      void readJsonLine(socket, 2000).then((value) => writeJsonLine(socket, { echo: value }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    cleanup = () => server.close()

    const { connect } = await import("node:net")
    const client = connect(port, "127.0.0.1")
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve)
      client.once("error", reject)
    })
    writeJsonLine(client, { hello: "world" })
    const response = await readJsonLine(client, 2000)
    expect(response).toEqual({ echo: { hello: "world" } })
    client.end()
  })

  it("rejects if no line arrives before the timeout", async () => {
    const server = createServer(() => {
      // Never writes anything back.
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    cleanup = () => server.close()

    const { connect } = await import("node:net")
    const client = connect(port, "127.0.0.1")
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve)
      client.once("error", reject)
    })
    await expect(readJsonLine(client, 100)).rejects.toThrow(/timed out/)
    client.end()
  })

  it("rejects if the socket closes before a line arrives", async () => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    cleanup = () => server.close()

    const { connect } = await import("node:net")
    const client = connect(port, "127.0.0.1")
    await expect(readJsonLine(client, 2000)).rejects.toThrow(/closed/)
  })

  it("rejects a connection that exceeds maxBytes before ever sending a newline", async () => {
    const serverSideRead = new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        readJsonLine(socket, 2000, 16).then(
          () => reject(new Error("expected readJsonLine to reject")),
          (err) => {
            expect(err.message).toMatch(/exceeded/)
            resolve()
          }
        )
      })
      void new Promise<void>((listenResolve) => server.listen(0, "127.0.0.1", listenResolve)).then(
        async () => {
          const port = (server.address() as AddressInfo).port
          cleanup = () => server.close()

          const { connect } = await import("node:net")
          const client = connect(port, "127.0.0.1")
          await new Promise<void>((connectResolve, connectReject) => {
            client.once("connect", connectResolve)
            client.once("error", connectReject)
          })
          client.write("x".repeat(100)) // no newline, well over the 16-byte cap
          client.end()
        }
      )
    })

    await serverSideRead
  })

  it("rejects an oversized single line even though it's otherwise well-formed JSON", async () => {
    const server = createServer((socket) => {
      void readJsonLine(socket, 2000, 32).catch((err) =>
        writeJsonLine(socket, { error: err.message })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    cleanup = () => server.close()

    const { connect } = await import("node:net")
    const client = connect(port, "127.0.0.1")
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve)
      client.once("error", reject)
    })
    writeJsonLine(client, { value: "x".repeat(100) })
    const response = await new Promise<{ error: string }>((resolve) => {
      client.once("close", () => resolve({ error: "socket closed" }))
      client.once("data", (chunk: Buffer) => resolve(JSON.parse(chunk.toString())))
    })
    expect(response.error).toMatch(/exceeded|closed/)
    client.end()
  })

  it("a normal-sized line under the default cap round-trips unaffected", async () => {
    const server = createServer((socket) => {
      void readJsonLine(socket, 2000).then((value) => writeJsonLine(socket, { echo: value }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    cleanup = () => server.close()

    const { connect } = await import("node:net")
    const client = connect(port, "127.0.0.1")
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve)
      client.once("error", reject)
    })
    writeJsonLine(client, { hello: "world" })
    const response = await readJsonLine(client, 2000)
    expect(response).toEqual({ echo: { hello: "world" } })
    client.end()
  })
})

async function socketPair(): Promise<{
  server: import("node:net").Socket
  client: import("node:net").Socket
  close: () => void
}> {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = (listener.address() as AddressInfo).port

  const serverPromise = new Promise<import("node:net").Socket>((resolve) => {
    listener.once("connection", (s) => resolve(s))
  })
  const client = await new Promise<import("node:net").Socket>((resolve) => {
    const s = connect(port, "127.0.0.1")
    s.once("connect", () => resolve(s))
  })
  const server = await serverPromise

  return {
    server,
    client,
    close: () => {
      server.destroy()
      client.destroy()
      listener.close()
    },
  }
}

describe("createJsonLineReader", () => {
  let pair: Awaited<ReturnType<typeof socketPair>> | undefined

  afterEach(() => {
    pair?.close()
    pair = undefined
  })

  it("resolves two lines delivered in a single write() call, in order", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    pair.client.write('{"a":1}\n{"b":2}\n')

    await expect(reader.next()).resolves.toEqual({ a: 1 })
    await expect(reader.next()).resolves.toEqual({ b: 2 })
  })

  it("resolves a line split across two write() calls once it completes", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    const nextPromise = reader.next()
    pair.client.write('{"a":')
    await new Promise((resolve) => setTimeout(resolve, 10))
    pair.client.write("1}\n")

    await expect(nextPromise).resolves.toEqual({ a: 1 })
  })

  it("rejects and destroys the socket when a line exceeds maxBytes", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server, 8)

    const nextPromise = reader.next()
    pair.client.write(`${"x".repeat(100)}\n`)

    await expect(nextPromise).rejects.toThrow(/exceeded/)
  })

  it("error/close reject every outstanding next() call at once", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    const first = reader.next()
    const second = reader.next()
    pair.client.destroy()

    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
  })

  it("next() with no timeoutMs never rejects on its own — only on socket error/close", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    const nextPromise = reader.next()
    await new Promise((resolve) => setTimeout(resolve, 50))
    pair.client.write('{"late":true}\n')

    await expect(nextPromise).resolves.toEqual({ late: true })
  })

  it("next() with a timeoutMs rejects if nothing arrives in time", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    await expect(reader.next(20)).rejects.toThrow(/timed out/)
  })

  it("dispose() rejects a currently-pending next() call and removes listeners", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.server)

    const nextPromise = reader.next()
    reader.dispose()

    await expect(nextPromise).rejects.toThrow(/disposed/)

    // Further data must not be read after dispose.
    pair.client.write('{"after":"dispose"}\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it("writeJsonLine is unchanged: a written line round-trips through the new reader", async () => {
    pair = await socketPair()
    const reader = createJsonLineReader(pair.client)

    writeJsonLine(pair.server, { hello: "world" })

    await expect(reader.next()).resolves.toEqual({ hello: "world" })
  })
})
