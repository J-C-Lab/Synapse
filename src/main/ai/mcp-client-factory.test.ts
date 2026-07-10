import { describe, expect, it } from "vitest"
import { createMcpClient } from "./mcp-client-factory"

// The transport factories build their SDK transport objects but do not spawn a
// process or open a connection until connect() is called, so constructing them
// here is side-effect-free.

describe("createMcpClient", () => {
  it("builds a stdio client from a command", () => {
    const client = createMcpClient(
      { id: "fs", transport: "stdio", command: "node" },
      async () => []
    )
    expect(typeof client.connect).toBe("function")
    expect(typeof client.callTool).toBe("function")
  })

  it("builds an http client from a url", () => {
    const client = createMcpClient(
      { id: "r", transport: "http", url: "https://example.com/mcp" },
      async () => []
    )
    expect(typeof client.connect).toBe("function")
    expect(typeof client.listTools).toBe("function")
  })

  it("throws when a stdio server has no command", () => {
    expect(() => createMcpClient({ id: "fs", transport: "stdio" }, async () => [])).toThrow(
      /command/
    )
  })

  it("throws when an http server has no url", () => {
    expect(() => createMcpClient({ id: "r", transport: "http" }, async () => [])).toThrow(/url/)
  })
})
