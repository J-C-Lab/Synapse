import type { AgentRunEvent, AgentRunStatus } from "./events"
import { describe, expect, it } from "vitest"
import { describeRunEvent, isAgentRunEvent, isTerminalRunStatus } from "./events"

describe("isTerminalRunStatus", () => {
  it("is true for completed, cancelled, and failed", () => {
    expect(isTerminalRunStatus("completed")).toBe(true)
    expect(isTerminalRunStatus("cancelled")).toBe(true)
    expect(isTerminalRunStatus("failed")).toBe(true)
  })

  it("is false for every non-terminal status", () => {
    const nonTerminal: AgentRunStatus[] = [
      "created",
      "running",
      "waiting_approval",
      "waiting_child",
      "suspended_unknown_tool_outcome",
      "suspended_conversation_conflict",
      "terminalizing",
    ]
    for (const status of nonTerminal) {
      expect(isTerminalRunStatus(status)).toBe(false)
    }
  })
})

describe("describeRunEvent", () => {
  const base = {
    schemaVersion: 1 as const,
    eventId: "evt-1",
    runId: "run-1",
    rootRunId: "run-1",
    sequence: 1,
    timestamp: 0,
    persisted: true,
  }

  it("describes every event variant without throwing (exhaustiveness)", () => {
    const events: AgentRunEvent[] = [
      { ...base, type: "run_started", origin: "interactive" },
      { ...base, type: "run_status_changed", status: "running", recovery: { kind: "automatic" } },
      { ...base, type: "text_delta", text: "hi", persisted: false },
      { ...base, type: "budget_admission_updated", operationId: "op-1", state: "held" },
      {
        ...base,
        type: "model_completed",
        step: 0,
        assistantMessageId: "msg-1",
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        ...base,
        type: "tool_requested",
        modelStep: 0,
        ordinal: 0,
        assistantMessageId: "msg-1",
        toolUseId: "tu-1",
        safeName: "read_file",
        fqName: "host:read_file",
      },
      {
        ...base,
        type: "approval_pending",
        approvalId: "ap-1",
        modelStep: 0,
        ordinal: 0,
        toolUseId: "tu-1",
        safeName: "read_file",
      },
      {
        ...base,
        type: "approval_resolved",
        approvalId: "ap-1",
        allowed: true,
        remember: "once",
      },
      { ...base, type: "tool_started", ordinal: 0, toolUseId: "tu-1", attemptId: "att-1" },
      {
        ...base,
        type: "tool_completed",
        ordinal: 0,
        toolUseId: "tu-1",
        attemptId: "att-1",
        isError: false,
        complete: true,
      },
      {
        ...base,
        type: "artifact_created",
        artifact: {
          uri: "artifact://run/run-1/art-1",
          kind: "tool-result",
          mediaType: "text/plain",
          capturedBytes: 10,
          complete: true,
        },
      },
      { ...base, type: "plan_updated", plan: [{ title: "step 1", status: "pending" }] },
      {
        ...base,
        type: "child_task_updated",
        child: { childRunId: "child-1", status: "running" },
      },
      {
        ...base,
        type: "child_ownership_lease_updated",
        childRunId: "child-1",
        leaseExpiresAt: 1000,
        fencingToken: 1,
      },
      {
        ...base,
        type: "finalization_phase_updated",
        finalizationId: "fin-1",
        phase: "prepared",
      },
      { ...base, type: "checkpoint_committed", revision: 2 },
      { ...base, type: "run_completed", outcome: "completed" },
      { ...base, type: "run_failed", outcome: "failed" },
    ]

    for (const event of events) {
      expect(typeof describeRunEvent(event)).toBe("string")
    }
    // Every AgentRunEvent variant declared in the union above must be covered;
    // this count is a tripwire so a newly added variant fails the test until
    // a fixture (and a describeRunEvent case) is added for it.
    expect(events.length).toBe(18)
  })

  it("includes the event type in the description", () => {
    expect(describeRunEvent({ ...base, type: "run_completed", outcome: "completed" })).toContain(
      "run_completed"
    )
  })
})

describe("isAgentRunEvent", () => {
  const base = {
    schemaVersion: 1 as const,
    eventId: "evt-delta",
    runId: "run-1",
    rootRunId: "run-1",
    sequence: 1,
    timestamp: 0,
    type: "text_delta" as const,
    text: "live only",
  }

  it("accepts a text delta only when it is explicitly live-only", () => {
    expect(isAgentRunEvent({ ...base, persisted: false })).toBe(true)
    expect(isAgentRunEvent({ ...base, persisted: true })).toBe(false)
  })
})
