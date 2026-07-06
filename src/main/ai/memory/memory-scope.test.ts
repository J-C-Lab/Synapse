import { describe, expect, it } from "vitest"
import {
  entryMatchesQuery,
  normalizeMemoryScope,
  queryScopeForCaller,
  scopeForCaller,
} from "./memory-scope"

describe("memory scope", () => {
  it("normalizes missing or invalid legacy scope to global", () => {
    expect(normalizeMemoryScope(undefined)).toEqual({ visibility: "global" })
    expect(normalizeMemoryScope({ visibility: "bad" })).toEqual({ visibility: "global" })
  })

  it("derives global scope when callers have no workspace binding", () => {
    expect(scopeForCaller({ kind: "agent", conversationId: "c1" })).toEqual({
      visibility: "global",
    })
    expect(queryScopeForCaller({ kind: "agent", conversationId: "c1" })).toEqual({
      conversationId: "c1",
      includeGlobal: true,
    })
  })

  it("matches entries by workspace, conversation, and global visibility", () => {
    expect(
      entryMatchesQuery(
        { id: "g", text: "global", tags: [], createdAt: 1, scope: { visibility: "global" } },
        { workspaceId: "repo", includeGlobal: true }
      )
    ).toBe(true)
    expect(
      entryMatchesQuery(
        {
          id: "w",
          text: "workspace",
          tags: [],
          createdAt: 1,
          scope: { visibility: "workspace", workspaceId: "repo" },
        },
        { workspaceId: "repo", includeGlobal: false }
      )
    ).toBe(true)
    expect(
      entryMatchesQuery(
        {
          id: "w",
          text: "workspace",
          tags: [],
          createdAt: 1,
          scope: { visibility: "workspace", workspaceId: "repo" },
        },
        { workspaceId: "other", includeGlobal: true }
      )
    ).toBe(false)
    expect(
      entryMatchesQuery(
        {
          id: "c",
          text: "conversation",
          tags: [],
          createdAt: 1,
          scope: { visibility: "conversation", conversationId: "c1" },
        },
        { conversationId: "c1", includeGlobal: false }
      )
    ).toBe(true)
  })
})
