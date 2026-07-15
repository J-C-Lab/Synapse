import type { ToolAnnotations } from "@synapse/plugin-manifest"
import type { ApprovalDecision, ApprovalSettings } from "../approval-gate"
import { decideApproval } from "../approval-gate"

// Durable approval policy (design §"Persist policy decision and a stable
// approval id before emitting an approval request"). Reuses the existing
// annotation-based heuristic (approval-gate.ts) unchanged; the only new
// piece is letting an optional hard policy resolver (e.g. command
// classification) short-circuit to "allow"/"deny" ahead of it — the same
// two-layer shape agent-service.ts's approve() already has, made reusable
// for the durable tool-batch ledger.

export type RememberScope = "once" | "conversation" | "always"

export interface DurableApprovalPolicyInput {
  fqName: string
  safeName: string
  input: unknown
  annotations: ToolAnnotations | undefined
  settings?: ApprovalSettings
}

/** A hard policy hook that may force "allow"/"deny" ahead of the
 *  annotation-based heuristic. Returning undefined (or "ask") defers to
 *  decideApproval. */
export type DurableApprovalResolver = (
  input: DurableApprovalPolicyInput
) => ApprovalDecision | undefined | Promise<ApprovalDecision | undefined>

export async function decideDurableApproval(
  input: DurableApprovalPolicyInput,
  resolver?: DurableApprovalResolver
): Promise<ApprovalDecision> {
  const resolved = await resolver?.(input)
  if (resolved === "allow" || resolved === "deny") return resolved
  return decideApproval(input.annotations, input.settings)
}
