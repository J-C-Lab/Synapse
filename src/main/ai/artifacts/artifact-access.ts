import type { ToolPrincipal } from "@synapse/plugin-sdk"
import type { ArtifactCaller, ArtifactOwnerContext } from "./artifact-types"

// Visibility enforcement for stat()/read() (design §"Recoverable artifact
// backend"): "`caller` must match the run tree, conversation/workspace
// visibility, and principal. A child can read explicitly delegated parent
// artifacts; a parent may read child results. Siblings cannot read each
// other by guessing a URI."
//
// Deliberately conservative: every cross-run read requires BOTH a direct
// parent<->child edge (never mere rootRunId equality, which siblings also
// share) AND an explicit delegation entry. There is no implicit visibility
// based on artifact `kind` (e.g. "child-result") — a reviewer should confirm
// this matches intent versus auto-delegating certain kinds.

function principalsMatch(a: ToolPrincipal, b: ToolPrincipal): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "external-mcp" && b.kind === "external-mcp") return a.clientId === b.clientId
  if (a.kind === "subagent" && b.kind === "subagent") return a.parentRunId === b.parentRunId
  return true
}

/** Whether `caller` may stat/read an artifact owned by `owner`, given the
 *  artifact's explicit delegation list. Pure and synchronous — no I/O, no
 *  live AgentRunStore lookup; every fact needed is already in `owner` and
 *  `caller`. */
export function checkArtifactAccess(
  owner: ArtifactOwnerContext,
  delegateToRunIds: readonly string[],
  caller: ArtifactCaller,
  delegateToConversationIds: readonly string[] = []
): boolean {
  if (caller.runId === owner.runId) return true

  // A durable child result is intentionally readable by a later interactive
  // turn in the same conversation. This is an explicit manifest grant, not
  // an inference from kind or rootRunId: it never admits a sibling,
  // background job, subagent, or external MCP caller.
  if (
    owner.principal.kind === "subagent" &&
    caller.principal.kind === "local-user" &&
    owner.conversationId !== undefined &&
    owner.conversationId === caller.conversationId &&
    owner.workspaceId === caller.workspaceId &&
    delegateToConversationIds.includes(caller.conversationId)
  ) {
    return true
  }

  const isDirectParent = owner.parentRunId !== undefined && owner.parentRunId === caller.runId
  const isDirectChild = caller.parentRunId !== undefined && caller.parentRunId === owner.runId
  if (!isDirectParent && !isDirectChild) return false

  // A tree edge claim is only trustworthy if both sides agree on the root —
  // guards against a forged/stale caller context claiming a parentRunId
  // pointer into a tree it doesn't actually belong to.
  if (owner.rootRunId !== caller.rootRunId) return false

  if (!delegateToRunIds.includes(caller.runId)) return false

  if (owner.conversationId !== caller.conversationId) return false
  if (owner.workspaceId !== caller.workspaceId) return false
  if (!principalsMatch(owner.principal, caller.principal)) return false

  return true
}
