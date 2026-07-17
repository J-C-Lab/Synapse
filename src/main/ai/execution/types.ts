export interface WorkspaceRoot {
  id: string
  root: string
}

export interface WorkspaceRootRecord {
  /** Host-generated (crypto.randomUUID()), stable for the record's lifetime —
   *  never re-derived from the path. */
  id: string
  workspaceId: string
  /** User-facing label — defaults to the folder's basename at creation time
   *  but is NOT re-derived afterward. */
  name: string
  root: string
  role: "primary" | "additional"
  createdAt: number
}

export interface ResolvedWorkspacePath {
  rootId: string
  root: string
  absolutePath: string
  relativePath: string
}

export interface ExecutionAuditEvent {
  id: string
  conversationId?: string
  toolName: string
  /** The conversation's bound product-level Workspace, from caller.workspaceId. */
  workspaceId?: string
  /** Which WorkspaceRootRecord the tool actually resolved to (after
   *  primary-defaulting). Replaces the old workspaceId-as-root-id field. */
  rootId?: string
  cwd?: string
  normalizedPaths?: string[]
  /** `approved` = user confirmed an ask-classified tool; `allow` = auto or policy allow. */
  decision: "allow" | "ask" | "deny" | "approved"
  startedAt: number
  endedAt: number
  inputPreview: string
  outputPreview: string
  errorPreview: string
  /** Which ExecutionBackend actually served this call (Task 18) — only
   *  populated for tools that dispatch through one (run_command today).
   *  Never inferred/guessed; always read from the backend's own descriptor
   *  so it can never silently drift from what really executed the
   *  command. */
  backendId?: string
  backendIsolation?: "none" | "process" | "container" | "vm"
  backendReplayGuarantee?: "none" | "dedupe-and-result-replay"
  /** Artifact ids for stdout/stderr when run_command captured output as
   *  durable artifacts (the caller had a run context to scope them under).
   *  Never the raw output itself — outputPreview above stays a bounded
   *  preview string, exactly as before. */
  stdoutArtifactId?: string
  stderrArtifactId?: string
}
