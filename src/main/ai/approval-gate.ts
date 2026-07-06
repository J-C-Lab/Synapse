import type { ToolAnnotations } from "@synapse/plugin-manifest"

// Decides whether a tool call may run without a human in the loop (design §5).
// Pure and unit-testable; the AgentService layers remembered "allow" decisions
// on top before consulting this.

export type ApprovalDecision = "allow" | "ask" | "deny"

export interface ApprovalSettings {
  /** When true, even read-only tools require confirmation. */
  alwaysAsk?: boolean
}

/**
 * - `destructiveHint` / `requiresConfirmation` → always ask.
 * - `readOnlyHint` → auto-allow (unless the user opted into always-ask).
 * - Anything else (unannotated, possible side effects) → ask, to be safe.
 */
export function decideApproval(
  annotations: ToolAnnotations | undefined,
  settings: ApprovalSettings = {}
): ApprovalDecision {
  if (annotations?.destructiveHint || annotations?.requiresConfirmation) return "ask"
  if (settings.alwaysAsk) return "ask"
  if (annotations?.readOnlyHint) return "allow"
  return "ask"
}
