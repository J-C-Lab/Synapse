import type { ArtifactCaller, ArtifactOwnerContext } from "./artifact-types"
import { describe, expect, it } from "vitest"
import { checkArtifactAccess } from "./artifact-access"

function owner(overrides: Partial<ArtifactOwnerContext> = {}): ArtifactOwnerContext {
  return {
    runId: "run-owner",
    rootRunId: "root-1",
    principal: { kind: "internal-agent" },
    ...overrides,
  }
}

function caller(overrides: Partial<ArtifactCaller> = {}): ArtifactCaller {
  return {
    runId: "run-owner",
    rootRunId: "root-1",
    principal: { kind: "internal-agent" },
    ...overrides,
  }
}

describe("checkArtifactAccess — same run", () => {
  it("always allows the owning run to read its own artifact", () => {
    expect(checkArtifactAccess(owner(), [], caller())).toBe(true)
  })

  it("allows the owning run even with a different principal recorded on the caller (self-read never needs a principal match)", () => {
    expect(
      checkArtifactAccess(
        owner({ principal: { kind: "local-user" } }),
        [],
        caller({ principal: { kind: "internal-agent" } })
      )
    ).toBe(true)
  })
})

describe("checkArtifactAccess — parent/child", () => {
  it("denies a parent reading a child's artifact when not delegated", () => {
    const childOwned = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    const parentCaller = caller({ runId: "parent-1", rootRunId: "root-1" })
    expect(checkArtifactAccess(childOwned, [], parentCaller)).toBe(false)
  })

  it("allows a parent reading an explicitly delegated child result", () => {
    const childOwned = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    const parentCaller = caller({ runId: "parent-1", rootRunId: "root-1" })
    expect(checkArtifactAccess(childOwned, ["parent-1"], parentCaller)).toBe(true)
  })

  it("denies a child reading a parent's artifact when not delegated", () => {
    const parentOwned = owner({ runId: "parent-1", rootRunId: "root-1" })
    const childCaller = caller({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    expect(checkArtifactAccess(parentOwned, [], childCaller)).toBe(false)
  })

  it("allows a child reading an explicitly delegated parent artifact", () => {
    const parentOwned = owner({ runId: "parent-1", rootRunId: "root-1" })
    const childCaller = caller({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    expect(checkArtifactAccess(parentOwned, ["child-1"], childCaller)).toBe(true)
  })
})

describe("checkArtifactAccess — siblings and strangers", () => {
  it("denies a sibling even when it guesses the artifact and is (wrongly) added to a delegation list meant for someone else", () => {
    const childOwned = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    const siblingCaller = caller({ runId: "child-2", rootRunId: "root-1", parentRunId: "parent-1" })
    // Even if the delegation list happens to include the sibling's id, a
    // sibling relationship is never a valid parent/child edge — deny.
    expect(checkArtifactAccess(childOwned, ["child-2"], siblingCaller)).toBe(false)
  })

  it("denies an unrelated run entirely outside the tree", () => {
    const childOwned = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    const strangerCaller = caller({ runId: "stranger-1", rootRunId: "root-2" })
    expect(checkArtifactAccess(childOwned, ["stranger-1"], strangerCaller)).toBe(false)
  })

  it("denies when rootRunId disagrees even though the parentRunId edge lines up", () => {
    const childOwned = owner({ runId: "child-1", rootRunId: "root-1", parentRunId: "parent-1" })
    // Same parentRunId pointer, but claims a different root run — must not
    // be trusted as a real tree edge.
    const forgedCaller = caller({ runId: "parent-1", rootRunId: "root-9" })
    expect(checkArtifactAccess(childOwned, ["parent-1"], forgedCaller)).toBe(false)
  })
})

describe("checkArtifactAccess — conversation/workspace/principal visibility", () => {
  it("allows an explicitly delegated child result from a later local interactive run in the same conversation", () => {
    const childOwned = owner({
      runId: "child-1",
      rootRunId: "old-root",
      parentRunId: "old-parent",
      conversationId: "conv-a",
      workspaceId: "ws-a",
      principal: { kind: "subagent", parentRunId: "old-parent" },
    })
    const laterInteractiveCaller = caller({
      runId: "later-interactive",
      rootRunId: "later-interactive",
      conversationId: "conv-a",
      workspaceId: "ws-a",
      principal: { kind: "local-user" },
    })

    expect(checkArtifactAccess(childOwned, [], laterInteractiveCaller, ["conv-a"])).toBe(true)
  })

  it("does not let a conversation grant escape its conversation or local interactive principal", () => {
    const childOwned = owner({
      runId: "child-1",
      rootRunId: "old-root",
      parentRunId: "old-parent",
      conversationId: "conv-a",
      workspaceId: "ws-a",
      principal: { kind: "subagent", parentRunId: "old-parent" },
    })
    expect(
      checkArtifactAccess(
        childOwned,
        [],
        caller({
          runId: "other-conversation",
          rootRunId: "other-conversation",
          conversationId: "conv-b",
          workspaceId: "ws-a",
          principal: { kind: "local-user" },
        }),
        ["conv-a"]
      )
    ).toBe(false)
    expect(
      checkArtifactAccess(
        childOwned,
        [],
        caller({
          runId: "child-sibling",
          rootRunId: "old-root",
          parentRunId: "old-parent",
          conversationId: "conv-a",
          workspaceId: "ws-a",
          principal: { kind: "subagent", parentRunId: "old-parent" },
        }),
        ["conv-a"]
      )
    ).toBe(false)
  })

  it("denies a delegated parent when the conversationId differs", () => {
    const childOwned = owner({
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "parent-1",
      conversationId: "conv-a",
    })
    const parentCaller = caller({
      runId: "parent-1",
      rootRunId: "root-1",
      conversationId: "conv-b",
    })
    expect(checkArtifactAccess(childOwned, ["parent-1"], parentCaller)).toBe(false)
  })

  it("denies a delegated parent when the workspaceId differs", () => {
    const childOwned = owner({
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "parent-1",
      workspaceId: "ws-a",
    })
    const parentCaller = caller({ runId: "parent-1", rootRunId: "root-1", workspaceId: "ws-b" })
    expect(checkArtifactAccess(childOwned, ["parent-1"], parentCaller)).toBe(false)
  })

  it("allows a delegated parent when conversation/workspace match exactly", () => {
    const childOwned = owner({
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "parent-1",
      conversationId: "conv-a",
      workspaceId: "ws-a",
    })
    const parentCaller = caller({
      runId: "parent-1",
      rootRunId: "root-1",
      conversationId: "conv-a",
      workspaceId: "ws-a",
    })
    expect(checkArtifactAccess(childOwned, ["parent-1"], parentCaller)).toBe(true)
  })

  it("denies two external-mcp principals with different clientIds even on a valid tree edge", () => {
    const childOwned = owner({
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "parent-1",
      principal: { kind: "external-mcp", clientId: "client-a" },
    })
    const parentCaller = caller({
      runId: "parent-1",
      rootRunId: "root-1",
      principal: { kind: "external-mcp", clientId: "client-b" },
    })
    expect(checkArtifactAccess(childOwned, ["parent-1"], parentCaller)).toBe(false)
  })

  it("allows two external-mcp principals with the same clientId on a valid tree edge", () => {
    const childOwned = owner({
      runId: "child-1",
      rootRunId: "root-1",
      parentRunId: "parent-1",
      principal: { kind: "external-mcp", clientId: "client-a" },
    })
    const parentCaller = caller({
      runId: "parent-1",
      rootRunId: "root-1",
      principal: { kind: "external-mcp", clientId: "client-a" },
    })
    expect(checkArtifactAccess(childOwned, ["parent-1"], parentCaller)).toBe(true)
  })
})
