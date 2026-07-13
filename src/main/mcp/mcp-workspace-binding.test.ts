import { describe, expect, it } from "vitest"
import { resolveMcpWorkspaceBinding } from "./mcp-workspace-binding"

describe("resolveMcpWorkspaceBinding", () => {
  it("resolves unbound for an absent SYNAPSE_MCP_WORKSPACE", () => {
    expect(resolveMcpWorkspaceBinding({})).toEqual({ kind: "unbound" })
  })

  it("resolves unbound for an empty or whitespace-only value", () => {
    expect(resolveMcpWorkspaceBinding({ SYNAPSE_MCP_WORKSPACE: "" })).toEqual({ kind: "unbound" })
    expect(resolveMcpWorkspaceBinding({ SYNAPSE_MCP_WORKSPACE: "   " })).toEqual({
      kind: "unbound",
    })
  })

  it("resolves bound with the trimmed workspace id", () => {
    expect(resolveMcpWorkspaceBinding({ SYNAPSE_MCP_WORKSPACE: "  work  " })).toEqual({
      kind: "bound",
      workspaceId: "work",
    })
  })

  it("never resolves the literal string 'external'", () => {
    expect(resolveMcpWorkspaceBinding({ SYNAPSE_MCP_WORKSPACE: "external" })).toEqual({
      kind: "bound",
      workspaceId: "external",
    })
  })
})
