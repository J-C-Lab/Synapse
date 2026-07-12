import { describe, expect, it } from "vitest"
import {
  coerceApprove,
  coerceBudget,
  coerceChat,
  coerceCreateConversation,
  coerceCreateWorkspace,
  coerceCreateWorkspaceRoot,
  coerceListWorkspaces,
  coerceMcpServer,
  coerceRenameWorkspace,
  coerceWorkspaceId,
} from "./ai"

describe("coerceBudget", () => {
  it("accepts a non-negative integer and floors it", () => {
    expect(coerceBudget(5000)).toBe(5000)
    expect(coerceBudget(0)).toBe(0)
    expect(coerceBudget(12.9)).toBe(12)
  })

  it("rejects negative values and non-numbers", () => {
    expect(() => coerceBudget(-1)).toThrow(/budget/)
    expect(() => coerceBudget("x")).toThrow(/budget/)
    expect(() => coerceBudget(Number.NaN)).toThrow(/budget/)
  })
})

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

describe("coerceCreateWorkspace", () => {
  it("accepts a trimmed name and rejects blank/missing", () => {
    expect(coerceCreateWorkspace({ name: "Work" })).toEqual({ name: "Work" })
    expect(() => coerceCreateWorkspace({ name: "  " })).toThrow(/name/)
    expect(() => coerceCreateWorkspace({})).toThrow()
  })
})

describe("coerceListWorkspaces", () => {
  it("defaults to {} for undefined or an object without includeArchived", () => {
    expect(coerceListWorkspaces(undefined)).toEqual({})
    expect(coerceListWorkspaces({})).toEqual({})
    expect(coerceListWorkspaces({ includeArchived: false })).toEqual({})
  })

  it("passes through includeArchived: true", () => {
    expect(coerceListWorkspaces({ includeArchived: true })).toEqual({ includeArchived: true })
  })
})

describe("coerceRenameWorkspace", () => {
  it("accepts id and a trimmed name", () => {
    expect(coerceRenameWorkspace({ id: "w1", name: "  New Name  " })).toEqual({
      id: "w1",
      name: "New Name",
    })
  })

  it("rejects a blank name or missing id", () => {
    expect(() => coerceRenameWorkspace({ id: "w1", name: "   " })).toThrow(/name/)
    expect(() => coerceRenameWorkspace({ name: "New Name" })).toThrow(/id must be a string/)
  })
})

describe("coerceWorkspaceId", () => {
  it("accepts an id", () => {
    expect(coerceWorkspaceId({ id: "w1" })).toEqual({ id: "w1" })
  })

  it("rejects a missing id", () => {
    expect(() => coerceWorkspaceId({})).toThrow(/id must be a string/)
    expect(() => coerceWorkspaceId(null)).toThrow(/must be an object/)
  })
})

describe("coerceCreateConversation", () => {
  it("requires a workspaceId string", () => {
    expect(coerceCreateConversation({ workspaceId: "work" })).toEqual({ workspaceId: "work" })
    expect(() => coerceCreateConversation({})).toThrow(/workspaceId/)
  })
})

describe("coerceCreateWorkspaceRoot", () => {
  it("accepts a well-formed payload and defaults role to additional", () => {
    expect(coerceCreateWorkspaceRoot({ workspaceId: "w1", name: "Proj", root: "/p" })).toEqual({
      workspaceId: "w1",
      name: "Proj",
      root: "/p",
      role: "additional",
    })
  })

  it("accepts an explicit primary role", () => {
    expect(
      coerceCreateWorkspaceRoot({ workspaceId: "w1", name: "Proj", root: "/p", role: "primary" })
    ).toMatchObject({ role: "primary" })
  })

  it("rejects missing required fields", () => {
    expect(() => coerceCreateWorkspaceRoot({ workspaceId: "w1" })).toThrow(/name must be a string/)
  })
})
