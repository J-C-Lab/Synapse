import type { AgentRunStatus } from "@synapse/agent-protocol"
import { isTerminalRunStatus } from "@synapse/agent-protocol"
import { describe, expect, it } from "vitest"
import { isValidRunStatusTransition, RUN_STATUS_TRANSITIONS } from "./run-types"

const ALL_STATUSES: AgentRunStatus[] = [
  "created",
  "running",
  "waiting_approval",
  "waiting_child",
  "suspended_unknown_tool_outcome",
  "suspended_conversation_conflict",
  "terminalizing",
  "completed",
  "cancelled",
  "failed",
]

describe("runStatusTransitions", () => {
  it("matches the documented transition table", () => {
    expect(RUN_STATUS_TRANSITIONS.created).toEqual(["running", "terminalizing"])
    expect(RUN_STATUS_TRANSITIONS.running).toEqual([
      "waiting_approval",
      "waiting_child",
      "suspended_unknown_tool_outcome",
      "suspended_conversation_conflict",
      "terminalizing",
    ])
    expect(RUN_STATUS_TRANSITIONS.waiting_approval).toEqual(["running", "terminalizing"])
    expect(RUN_STATUS_TRANSITIONS.waiting_child).toEqual(["running", "terminalizing"])
    expect(RUN_STATUS_TRANSITIONS.suspended_unknown_tool_outcome).toEqual([
      "running",
      "terminalizing",
    ])
    expect(RUN_STATUS_TRANSITIONS.suspended_conversation_conflict).toEqual(["terminalizing"])
    expect(RUN_STATUS_TRANSITIONS.terminalizing).toEqual(["completed", "cancelled", "failed"])
    expect(RUN_STATUS_TRANSITIONS.completed).toEqual([])
    expect(RUN_STATUS_TRANSITIONS.cancelled).toEqual([])
    expect(RUN_STATUS_TRANSITIONS.failed).toEqual([])
  })

  it("has an entry for every AgentRunStatus", () => {
    for (const status of ALL_STATUSES) {
      expect(RUN_STATUS_TRANSITIONS[status]).toBeDefined()
    }
  })
})

describe("isValidRunStatusTransition", () => {
  it("allows every edge declared in the transition table", () => {
    for (const from of ALL_STATUSES) {
      for (const to of RUN_STATUS_TRANSITIONS[from]) {
        const ctx = {
          childOwnershipResolved: true,
          hasRecoveryDecision: true,
          finalizationPhase: "complete" as const,
        }
        expect(isValidRunStatusTransition(from, to, ctx)).toBe(true)
      }
    }
  })

  it("rejects every edge not declared in the transition table", () => {
    for (const from of ALL_STATUSES) {
      const allowed = new Set(RUN_STATUS_TRANSITIONS[from])
      for (const to of ALL_STATUSES) {
        if (allowed.has(to)) continue
        expect(isValidRunStatusTransition(from, to)).toBe(false)
      }
    }
  })

  it("never allows skipping terminalizing to reach a terminal status directly", () => {
    for (const from of ALL_STATUSES) {
      if (from === "terminalizing") continue
      for (const to of ["completed", "cancelled", "failed"] as const) {
        expect(isValidRunStatusTransition(from, to, { finalizationPhase: "complete" })).toBe(false)
      }
    }
  })

  it("never allows suspended_conversation_conflict back to running", () => {
    expect(isValidRunStatusTransition("suspended_conversation_conflict", "running")).toBe(false)
  })

  it("requires childOwnershipResolved to leave waiting_child for terminalizing", () => {
    expect(isValidRunStatusTransition("waiting_child", "terminalizing")).toBe(false)
    expect(
      isValidRunStatusTransition("waiting_child", "terminalizing", {
        childOwnershipResolved: true,
      })
    ).toBe(true)
  })

  it("allows waiting_child back to running unconditionally", () => {
    expect(isValidRunStatusTransition("waiting_child", "running")).toBe(true)
  })

  it("requires a recorded recovery decision to leave suspended_unknown_tool_outcome for running", () => {
    expect(isValidRunStatusTransition("suspended_unknown_tool_outcome", "running")).toBe(false)
    expect(
      isValidRunStatusTransition("suspended_unknown_tool_outcome", "running", {
        hasRecoveryDecision: true,
      })
    ).toBe(true)
  })

  it("allows suspended_unknown_tool_outcome to terminalizing unconditionally", () => {
    expect(isValidRunStatusTransition("suspended_unknown_tool_outcome", "terminalizing")).toBe(true)
  })

  it("requires finalization phase complete to leave terminalizing", () => {
    expect(isValidRunStatusTransition("terminalizing", "completed")).toBe(false)
    expect(
      isValidRunStatusTransition("terminalizing", "completed", { finalizationPhase: "prepared" })
    ).toBe(false)
    expect(
      isValidRunStatusTransition("terminalizing", "completed", { finalizationPhase: "complete" })
    ).toBe(true)
    expect(
      isValidRunStatusTransition("terminalizing", "cancelled", { finalizationPhase: "complete" })
    ).toBe(true)
    expect(
      isValidRunStatusTransition("terminalizing", "failed", { finalizationPhase: "complete" })
    ).toBe(true)
  })

  it("terminal statuses accept no further transitions", () => {
    for (const from of ["completed", "cancelled", "failed"] as const) {
      for (const to of ALL_STATUSES) {
        expect(isValidRunStatusTransition(from, to)).toBe(false)
      }
    }
  })
})

describe("isTerminalRunStatus (re-exported)", () => {
  it("is available from the shared protocol package", () => {
    expect(isTerminalRunStatus("completed")).toBe(true)
    expect(isTerminalRunStatus("running")).toBe(false)
  })
})
