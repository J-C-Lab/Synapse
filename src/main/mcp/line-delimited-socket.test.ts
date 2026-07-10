import type { Buffer } from "node:buffer"
import type { AddressInfo } from "node:net"
import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

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
