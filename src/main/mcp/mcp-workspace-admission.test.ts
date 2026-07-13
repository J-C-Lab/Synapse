import { describe, expect, it } from "vitest"
import {
  assertWorkspaceAdmitted,
  McpUnboundError,
  McpWorkspaceArchivedError,
  McpWorkspaceNotFoundError,
} from "./mcp-workspace-admission"

describe("assertWorkspaceAdmitted", () => {
  it("throws McpUnboundError for an unbound binding", async () => {
    await expect(
      assertWorkspaceAdmitted({ kind: "unbound" }, { get: async () => undefined })
    ).rejects.toBeInstanceOf(McpUnboundError)
  })

  it("throws McpWorkspaceNotFoundError for a bound but unknown workspace", async () => {
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "ghost" },
        { get: async () => undefined }
      )
    ).rejects.toBeInstanceOf(McpWorkspaceNotFoundError)
  })

  it("throws McpWorkspaceArchivedError for a bound, archived workspace", async () => {
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "work" },
        { get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }) }
      )
    ).rejects.toBeInstanceOf(McpWorkspaceArchivedError)
  })

  it("resolves without throwing for a bound, active workspace", async () => {
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "work" },
        { get: async () => ({ id: "work", name: "Work", createdAt: 0 }) }
      )
    ).resolves.toBeUndefined()
  })

  it("error messages are actionable", async () => {
    await expect(
      assertWorkspaceAdmitted({ kind: "unbound" }, { get: async () => undefined })
    ).rejects.toThrow(/SYNAPSE_MCP_WORKSPACE/)
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "ghost" },
        { get: async () => undefined }
      )
    ).rejects.toThrow(/was not found/)
    await expect(
      assertWorkspaceAdmitted(
        { kind: "bound", workspaceId: "work" },
        { get: async () => ({ id: "work", name: "Work", createdAt: 0, archived: true }) }
      )
    ).rejects.toThrow(/is archived/)
  })
})
