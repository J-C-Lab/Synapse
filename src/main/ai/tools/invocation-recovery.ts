// Invocation recovery port for host/plugin/MCP tools (design §"Introduce
// explicit invocation recovery contracts"). An invocation id alone proves
// nothing about whether a call actually ran — only an adapter that both
// deduplicates the invocation AND can return its previously-committed result
// may claim "dedupe-and-result-replay". Every adapter today declares
// "none" and reports every recovery attempt "unknown".

export type InvocationProvenance = "host" | "plugin" | "mcp"

export type InvocationReplayGuarantee = "none" | "dedupe-and-result-replay"

export type InvocationRecoveryResult =
  | { status: "prior-result"; result: unknown }
  /** Authoritative: the adapter proves this invocation never ran. */
  | { status: "not-found" }
  /** The honest default — cannot prove either way. */
  | { status: "unknown" }

export interface InvocationRecoveryAdapter {
  provenance: InvocationProvenance
  replayGuarantee: InvocationReplayGuarantee
  recoverInvocation: (
    invocationId: string,
    invocationFingerprint: string
  ) => Promise<InvocationRecoveryResult>
}

/** The honest adapter every current host/plugin/MCP tool source declares —
 *  accepting an invocation id is not the same as being able to recover it. */
export function noneRecoveryAdapter(provenance: InvocationProvenance): InvocationRecoveryAdapter {
  return {
    provenance,
    replayGuarantee: "none",
    recoverInvocation: async () => ({ status: "unknown" }),
  }
}
