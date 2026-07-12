import type { ToolCaller } from "@synapse/plugin-sdk"
import { describe, expect, it } from "vitest"
import {
  actorOf,
  auditIdentityOf,
  callerToActor,
  invocationIdOf,
  principalOf,
} from "./invocation-context"

describe("callerToActor", () => {
  it("maps kind 'user' to actor 'user'", () => {
    expect(callerToActor({ kind: "user" })).toBe("user")
  })
  it("maps kind 'background-agent' to actor 'background-agent'", () => {
    expect(callerToActor({ kind: "background-agent" })).toBe("background-agent")
  })
  it("maps external-mcp principal to actor 'external-mcp'", () => {
    expect(callerToActor({ kind: "mcp", principal: { kind: "external-mcp" } })).toBe("external-mcp")
  })
  it("maps subagent principal to actor 'subagent'", () => {
    expect(
      callerToActor({ kind: "subagent", principal: { kind: "subagent", parentRunId: "p1" } })
    ).toBe("subagent")
  })
  it("defaults everything else to actor 'agent'", () => {
    expect(callerToActor({ kind: "agent", principal: { kind: "internal-agent" } })).toBe("agent")
  })
})

describe("actorOf", () => {
  it("derives actor from the caller for source: tool", () => {
    const caller: ToolCaller = { kind: "mcp", principal: { kind: "external-mcp" } }
    expect(actorOf({ source: "tool", caller, trigger: "tool:x" })).toBe("external-mcp")
  })
  it("reads actor directly for source: runless", () => {
    expect(actorOf({ source: "runless", actor: "background", trigger: "clipboard:change" })).toBe(
      "background"
    )
  })
})

describe("principalOf", () => {
  it("reads principal off the caller for source: tool", () => {
    const invocation = {
      source: "tool" as const,
      caller: {
        kind: "mcp" as const,
        principal: { kind: "external-mcp" as const, clientId: "cd" },
      },
      trigger: "tool:x",
    }
    expect(principalOf(invocation)).toEqual({ kind: "external-mcp", clientId: "cd" })
  })
  it("returns undefined for source: runless — there is no ToolCaller to derive a principal from", () => {
    expect(
      principalOf({ source: "runless", actor: "background", trigger: "clipboard:change" })
    ).toBeUndefined()
  })
})

describe("invocationIdOf", () => {
  it("reads invocationId off the caller for source: tool", () => {
    const invocation = {
      source: "tool" as const,
      caller: { kind: "background-agent" as const, invocationId: "inv-1" },
      trigger: "tool:x",
    }
    expect(invocationIdOf(invocation)).toBe("inv-1")
  })
  it("reads the top-level invocationId for source: runless", () => {
    expect(
      invocationIdOf({
        source: "runless",
        actor: "background",
        trigger: "timer:t",
        invocationId: "inv-2",
      })
    ).toBe("inv-2")
  })
})

describe("auditIdentityOf", () => {
  it("bundles runId/principal/workspaceId/triggerInstanceId off the caller for source: tool", () => {
    const invocation = {
      source: "tool" as const,
      caller: {
        kind: "background-agent" as const,
        runId: "r1",
        principal: { kind: "internal-agent" as const },
        workspaceId: "ws-1",
        triggerInstanceId: "inst-1",
      },
      trigger: "tool:x",
    }
    expect(auditIdentityOf(invocation)).toEqual({
      runId: "r1",
      principal: { kind: "internal-agent" },
      workspaceId: "ws-1",
      triggerInstanceId: "inst-1",
    })
  })
  it("returns all four fields undefined for source: runless — no run exists", () => {
    expect(
      auditIdentityOf({ source: "runless", actor: "background", trigger: "clipboard:change" })
    ).toEqual({
      runId: undefined,
      principal: undefined,
      workspaceId: undefined,
      triggerInstanceId: undefined,
    })
  })
})
