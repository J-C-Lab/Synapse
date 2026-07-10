export interface HostResourceApprovalRequest {
  /** String union so a second resource type is additive, not breaking.
   *  Only "workspace-instructions" exists today. */
  resourceType: "workspace-instructions"
  workspaceId: string
  /** The specific WorkspaceRootRecord.id already resolved (e.g. the
   *  workspace's primary root) at the moment the request was built — not
   *  re-derived from workspaceId after approval. The consumer of this
   *  type must re-verify this root still belongs to workspaceId
   *  immediately before reading, not just trust the approval. */
  rootId: string
  workspaceName: string
  rootName: string
  /** The resource's MCP URI, e.g. "workspace://<id>/instructions".
   *  Display only — never used as, or substituted for, an authorization
   *  check. */
  uri: string
  /** Self-reported by the external MCP client, display/audit only — never
   *  a verified identity. */
  clientId?: string
  reason?: string
}

export type HostResourceApprover = (input: {
  request: HostResourceApprovalRequest
  /** In-process only — does not propagate cancellation across the
   *  headless<->GUI socket (a pre-existing gap shared with plugin-
   *  capability approval, not solved by this type). */
  signal?: AbortSignal
}) => Promise<boolean>
