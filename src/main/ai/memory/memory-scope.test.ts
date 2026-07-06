import { describe, expect, it } from "vitest"
import { entryMatchesQuery, scopeForCaller } from "./memory-scope"

describe("memoryScope", () => {
  it("defaults saves to workspace scope when caller has a workspaceId", () => {
    expect(scopeForCaller({ kind: "agent", conversationId: "c1", workspaceId: "repo" })).toEqual({
      visibility: "workspace",
      workspaceId: "repo",
      conversationId: "c1",
    })
  })

  it("filters workspace-scoped entries by workspaceId", () => {
    const entryA = {
      id: "a",
      text: "alpha deploy",
      tags: [],
      createdAt: 1,
      scope: { visibility: "workspace" as const, workspaceId: "repo-a" },
    }
    const entryB = {
      id: "b",
      text: "beta deploy",
      tags: [],
      createdAt: 2,
      scope: { visibility: "workspace" as const, workspaceId: "repo-b" },
    }

    expect(entryMatchesQuery(entryA, { workspaceId: "repo-a", includeGlobal: true })).toBe(true)
    expect(entryMatchesQuery(entryB, { workspaceId: "repo-a", includeGlobal: true })).toBe(false)
  })
})
