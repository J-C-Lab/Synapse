// Host-only. NOT exported from @synapse/plugin-sdk — never crosses the
// sandbox boundary. See docs/superpowers/specs/2026-07-12-run-provenance-consolidation-design.md
// for the full rationale behind every constraint below.

import type { ToolCaller } from "@synapse/plugin-sdk"
import type { PlanStep } from "./plan/plan-types"
import type { RunTrace, RunTraceToolCall } from "./run-trace-store"

export type RunProvenance =
  | {
      origin: "interactive"
      runId: string
      conversationId: string
      invocationId?: never
      principal: { kind: "internal-agent" }
      workspaceId?: string
      parentRunId?: never
      triggerInstanceId?: never
    }
  | {
      origin: "background-agent"
      runId: string
      invocationId: string
      conversationId?: never
      principal: { kind: "internal-agent" }
      workspaceId: string
      triggerInstanceId: string
      parentRunId?: never
    }
  | {
      origin: "subagent"
      runId: string
      conversationId: string
      invocationId?: never
      principal: { kind: "subagent"; parentRunId: string }
      parentRunId: string
      workspaceId?: string
      triggerInstanceId?: never
    }
  | {
      origin: "mcp"
      runId: string
      conversationId?: never
      invocationId?: never
      principal: { kind: "external-mcp"; clientId?: string }
      workspaceId?: string
      parentRunId?: never
      triggerInstanceId?: never
    }

export function buildInteractiveRun(input: {
  runId: string
  conversationId: string
  workspaceId?: string
}): RunProvenance {
  return {
    origin: "interactive",
    runId: input.runId,
    conversationId: input.conversationId,
    principal: { kind: "internal-agent" },
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  }
}

export function buildBackgroundAgentRun(input: {
  runId: string
  invocationId: string
  workspaceId: string
  triggerInstanceId: string
}): RunProvenance {
  return {
    origin: "background-agent",
    runId: input.runId,
    invocationId: input.invocationId,
    principal: { kind: "internal-agent" },
    workspaceId: input.workspaceId,
    triggerInstanceId: input.triggerInstanceId,
  }
}

export function buildSubagentRun(input: {
  runId: string
  conversationId: string
  parentRunId: string
  workspaceId?: string
}): RunProvenance {
  return {
    origin: "subagent",
    runId: input.runId,
    conversationId: input.conversationId,
    parentRunId: input.parentRunId,
    principal: { kind: "subagent", parentRunId: input.parentRunId },
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  }
}

export function buildMcpRun(input: {
  runId: string
  workspaceId?: string
  clientId?: string
}): Extract<RunProvenance, { origin: "mcp" }> {
  return {
    origin: "mcp",
    runId: input.runId,
    principal: {
      kind: "external-mcp",
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    },
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  }
}

const KIND_OF_ORIGIN: Record<RunProvenance["origin"], ToolCaller["kind"]> = {
  interactive: "agent",
  "background-agent": "background-agent",
  subagent: "subagent",
  mcp: "mcp",
}

export function toToolCaller(p: RunProvenance): ToolCaller {
  const caller: ToolCaller = {
    kind: KIND_OF_ORIGIN[p.origin],
    runId: p.runId,
    principal: p.principal,
  }
  if (p.conversationId !== undefined) caller.conversationId = p.conversationId
  if (p.invocationId !== undefined) caller.invocationId = p.invocationId
  if (p.workspaceId !== undefined) caller.workspaceId = p.workspaceId
  if (p.parentRunId !== undefined) caller.parentRunId = p.parentRunId
  if (p.triggerInstanceId !== undefined) caller.triggerInstanceId = p.triggerInstanceId
  return caller
}

export function buildRunTrace(
  p: RunProvenance,
  exec: {
    startedAt: number
    endedAt: number
    outcome: RunTrace["outcome"]
    toolCalls: RunTraceToolCall[]
    plan?: PlanStep[]
  }
): RunTrace {
  const trace: RunTrace = {
    runId: p.runId,
    origin: p.origin,
    principal: p.principal,
    startedAt: exec.startedAt,
    endedAt: exec.endedAt,
    outcome: exec.outcome,
    toolCalls: exec.toolCalls,
  }
  if (p.conversationId !== undefined) trace.conversationId = p.conversationId
  if (p.invocationId !== undefined) trace.invocationId = p.invocationId
  if (p.workspaceId !== undefined) trace.workspaceId = p.workspaceId
  if (p.parentRunId !== undefined) trace.parentRunId = p.parentRunId
  if (p.triggerInstanceId !== undefined) trace.triggerInstanceId = p.triggerInstanceId
  if (exec.plan !== undefined && exec.plan.length > 0) trace.plan = exec.plan
  return trace
}
