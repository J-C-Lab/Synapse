// src/main/approvals/types.ts
export type ApprovalOutcomeReason =
  | "cancelled" // caller's own signal aborted (in-process, or via a cross-process cancel frame)
  | "gui-disposed" // the owning window(s) all went away before a human answered
  | "send-failed" // the headless side couldn't deliver the request at all
  | "timed-out" // the headless side gave up waiting for a GUI response
  | "client-disconnected" // the socket closed/errored with no cancel frame and no response

export type ApprovalResult =
  | { allow: true }
  | { allow: false } // a human explicitly clicked Deny
  | { allow: false; outcomeReason: ApprovalOutcomeReason }
