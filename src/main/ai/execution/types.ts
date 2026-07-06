export interface WorkspaceRoot {
  id: string
  root: string
}

export interface ResolvedWorkspacePath {
  workspaceId: string
  root: string
  absolutePath: string
  relativePath: string
}

export interface ExecutionAuditEvent {
  id: string
  conversationId?: string
  toolName: string
  workspaceId?: string
  cwd?: string
  normalizedPaths?: string[]
  /** `approved` = user confirmed an ask-classified tool; `allow` = auto or policy allow. */
  decision: "allow" | "ask" | "deny" | "approved"
  startedAt: number
  endedAt: number
  inputPreview: string
  outputPreview: string
  errorPreview: string
}
