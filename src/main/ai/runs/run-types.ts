import type { AgentRunStatus, RunFinalizationPhase } from "@synapse/agent-protocol"
import { isTerminalRunStatus } from "@synapse/agent-protocol"

// Host-only run lifecycle kernel: the fixed status transition table and its
// validator. The vocabulary itself (AgentRunIdentity, AgentRunStatus,
// RecoveryDisposition, ...) is re-exported from @synapse/agent-protocol so
// main, preload, and renderer share one declaration — see that package for
// the renderer-safe types. Re-export it here too so callers under
// src/main/ai/runs only need one import for run identity/status/recovery.
export type {
  AgentRunIdentity,
  AgentRunOrigin,
  AgentRunStatus,
  RecoveryBlockedReason,
  RecoveryDisposition,
  RecoveryReviewReason,
  RunFinalizationPhase,
} from "@synapse/agent-protocol"

/** The fixed status transition table (design §1). Every terminal status is
 *  reachable only through `terminalizing` — no status other than
 *  `terminalizing` lists a terminal status as an allowed next state. */
export const RUN_STATUS_TRANSITIONS: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  created: ["running", "terminalizing"],
  running: [
    "waiting_approval",
    "waiting_child",
    "suspended_unknown_tool_outcome",
    "suspended_conversation_conflict",
    "terminalizing",
  ],
  waiting_approval: ["running", "terminalizing"],
  waiting_child: ["running", "terminalizing"],
  suspended_unknown_tool_outcome: ["running", "terminalizing"],
  suspended_conversation_conflict: ["terminalizing"],
  // A fenced conversation commit can discover a concurrent overwrite only
  // after terminalization has begun. It must park for review rather than
  // leaving a permanently unresumable terminalizing checkpoint.
  terminalizing: ["suspended_conversation_conflict", "completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
}

export interface RunStatusTransitionContext {
  /** Required to leave `waiting_child` for `terminalizing` — abandoning a run
   *  that still owns a live child requires its ownership resolved first. */
  childOwnershipResolved?: boolean
  /** Required to leave `suspended_unknown_tool_outcome` for `running` — an
   *  explicit durable recovery decision (retry/mark-failed) must exist first. */
  hasRecoveryDecision?: boolean
  /** Required to leave `terminalizing` for any terminal status. */
  finalizationPhase?: RunFinalizationPhase
}

/**
 * Whether `from -> to` is a legal run status transition. Checks the fixed
 * table first, then the extra durability preconditions the table alone can't
 * express (child ownership, recovery decisions, finalization completion).
 */
export function isValidRunStatusTransition(
  from: AgentRunStatus,
  to: AgentRunStatus,
  ctx: RunStatusTransitionContext = {}
): boolean {
  if (!RUN_STATUS_TRANSITIONS[from].includes(to)) return false

  if (from === "waiting_child" && to === "terminalizing" && !ctx.childOwnershipResolved) {
    return false
  }
  if (from === "suspended_unknown_tool_outcome" && to === "running" && !ctx.hasRecoveryDecision) {
    return false
  }
  if (from === "terminalizing" && isTerminalRunStatus(to) && ctx.finalizationPhase !== "complete") {
    return false
  }

  return true
}
