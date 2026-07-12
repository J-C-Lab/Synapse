// Neutral module: imports nothing from capability-gate.ts or
// capability-governance.ts, so those two (and network-fetcher.ts,
// credential-broker.ts) can import from here without a cycle. See
// "InvocationContext becomes a discriminated union, in a neutral file" in
// docs/superpowers/specs/2026-07-12-run-provenance-consolidation-design.md.

import type { ToolCaller, ToolPrincipal } from "@synapse/plugin-sdk"

export type CapabilityActor =
  | "user"
  | "agent"
  | "background"
  | "background-agent"
  | "external-mcp"
  | "subagent"

export type InvocationContext =
  | { source: "tool"; caller: ToolCaller; trigger: string; signal?: AbortSignal }
  | {
      source: "runless"
      actor: "user" | "background"
      trigger: string
      signal?: AbortSignal
      invocationId?: string
    }

/**
 * Maps tool invocation origin to the capability actor used by `ensure()`.
 *
 * `kind` drives the two actors with their own trigger/budget semantics
 * (`user`, `background-agent`); everything else defers to the finer-grained
 * `principal` so an external MCP client or a subagent isn't silently
 * flattened into the same "agent" actor as Synapse's own chat loop.
 *
 * Moved here from capability-governance.ts:56-62, verbatim, to break a
 * circular dependency (invocation-context → capability-governance →
 * capability-gate → invocation-context) that existed when this stayed
 * there. capability-governance.ts no longer defines or exports it.
 */
export function callerToActor(caller: ToolCaller): CapabilityActor {
  if (caller.kind === "user") return "user"
  if (caller.kind === "background-agent") return "background-agent"
  if (caller.principal?.kind === "external-mcp") return "external-mcp"
  if (caller.principal?.kind === "subagent") return "subagent"
  return "agent"
}

export function actorOf(invocation: InvocationContext): CapabilityActor {
  return invocation.source === "tool" ? callerToActor(invocation.caller) : invocation.actor
}

export function principalOf(invocation: InvocationContext): ToolPrincipal | undefined {
  return invocation.source === "tool" ? invocation.caller.principal : undefined
}

export function invocationIdOf(invocation: InvocationContext): string | undefined {
  return invocation.source === "tool" ? invocation.caller.invocationId : invocation.invocationId
}

/** Bundles the four fields CapabilityGate.emit() copies onto a persisted
 *  CapabilityAuditEntry — undefined across the board for "runless" (no
 *  run exists to have any of these). */
export function auditIdentityOf(invocation: InvocationContext): {
  runId?: string
  principal?: ToolPrincipal
  workspaceId?: string
  triggerInstanceId?: string
} {
  if (invocation.source !== "tool") {
    return {
      runId: undefined,
      principal: undefined,
      workspaceId: undefined,
      triggerInstanceId: undefined,
    }
  }
  return {
    runId: invocation.caller.runId,
    principal: invocation.caller.principal,
    workspaceId: invocation.caller.workspaceId,
    triggerInstanceId: invocation.caller.triggerInstanceId,
  }
}
