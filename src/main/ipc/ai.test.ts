import { describe, expect, it } from "vitest"
import { coerceApprove, coerceChat, coerceMcpServer } from "./ai"

describe("coerceChat", () => {
  it("accepts a well-formed payload", () => {
    expect(coerceChat({ conversationId: "c1", text: "hello" })).toEqual({
      conversationId: "c1",
      text: "hello",
    })
  })

  it("rejects missing fields", () => {
    expect(() => coerceChat({ conversationId: "c1" })).toThrow(/text must be a string/)
    expect(() => coerceChat(null)).toThrow(/must be an object/)
  })
})

describe("coerceApprove", () => {
  it("defaults remember to once", () => {
    expect(coerceApprove({ approvalId: "a1", allow: true })).toEqual({
      approvalId: "a1",
      allow: true,
      remember: "once",
    })
  })

  it("accepts a valid remember scope", () => {
    expect(coerceApprove({ approvalId: "a1", allow: false, remember: "always" }).remember).toBe(
      "always"
    )
  })

  it("rejects a bad remember scope and non-boolean allow", () => {
    expect(() => coerceApprove({ approvalId: "a1", allow: true, remember: "forever" })).toThrow(
      /remember must be/
    )
    expect(() => coerceApprove({ approvalId: "a1", allow: "yes" })).toThrow(
      /allow must be a boolean/
    )
  })
})

describe("coerceMcpServer", () => {
  it("keeps a full config and filters non-string args/env", () => {
    expect(
      coerceMcpServer({
        id: "fs",
        name: "Files",
        command: "npx",
        args: ["-y", 3, "pkg"],
        env: { TOKEN: "x", BAD: 5 },
        cwd: "/tmp",
        enabled: false,
      })
    ).toEqual({
      id: "fs",
      name: "Files",
      command: "npx",
      args: ["-y", "pkg"],
      env: { TOKEN: "x" },
      cwd: "/tmp",
      enabled: false,
    })
  })

  it("passes through an http config (command/url validation lives in the store)", () => {
    expect(
      coerceMcpServer({
        id: "r",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer t", BAD: 5 },
      })
    ).toEqual({
      id: "r",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t" },
    })
  })

  it("requires only id at the coerce layer", () => {
    expect(() => coerceMcpServer({ command: "npx" })).toThrow(/id must be a string/)
    expect(() => coerceMcpServer(null)).toThrow(/must be an object/)
    // command/url are optional here; the config store enforces them per transport.
    expect(coerceMcpServer({ id: "fs" })).toEqual({ id: "fs" })
  })
})
