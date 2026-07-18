import type { InvocationRecoveryResult } from "../tools/invocation-recovery"
import type { CommandArtifactCapture, CommandRunResult } from "./command-runner"
import type { WorkspacePolicy } from "./workspace-policy"
import { COMMAND_RUNNER_ISOLATION, runCommand } from "./command-runner"

// Explicit execution backend contract (design §"Introduce explicit
// invocation recovery contracts"). Today's local command path is registered
// honestly: isolation "none", full host filesystem/network access, and
// replayGuarantee "none" — recoverInvocation() always answers "unknown".
// UI/audit surfaces must render this as non-isolated, never as a sandbox.

export type ExecutionIsolationLevel = "none" | "process" | "container" | "vm"

export interface ExecutionBackendDescriptor {
  backendId: string
  backendVersion: string
  isolation: ExecutionIsolationLevel
  hostFilesystemAccess: "full" | "workspace-scoped" | "none"
  hostNetworkAccess: "full" | "scoped" | "none"
  replayGuarantee: "none" | "dedupe-and-result-replay"
}

export interface ExecutionInvocationRequest {
  invocationId: string
  rootId: string
  command: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** When present, the local backend captures stdout/stderr as durable
   *  artifacts instead of the legacy in-memory preview (Task 18). Absent
   *  when the caller has no run context to scope an artifact under. */
  artifacts?: CommandArtifactCapture
}

export interface ExecutionBackend {
  readonly descriptor: ExecutionBackendDescriptor
  invoke: (
    request: ExecutionInvocationRequest,
    policy: WorkspacePolicy
  ) => Promise<CommandRunResult>
  recoverInvocation: (invocationId: string) => Promise<InvocationRecoveryResult>
}

/** Human-readable isolation label for UI/audit surfaces. Never says
 *  "sandbox" for a non-isolated backend. */
export function describeIsolation(descriptor: ExecutionBackendDescriptor): string {
  if (descriptor.isolation === "none") {
    return "non-isolated (runs directly in the host process/user account)"
  }
  return `isolated (${descriptor.isolation})`
}

export const LOCAL_POLICY_BACKEND_DESCRIPTOR: ExecutionBackendDescriptor = {
  backendId: "local-policy",
  backendVersion: "1",
  isolation: COMMAND_RUNNER_ISOLATION,
  hostFilesystemAccess: "full",
  hostNetworkAccess: "full",
  replayGuarantee: "none",
}

/** Today's only backend: the existing policy-gated local command path,
 *  wrapped behind the explicit ExecutionBackend port. Command policy,
 *  workspace containment, approval, and audit all sit in front of this in
 *  execution-tool-host.ts — this seam only owns dispatch + recovery. */
export function createLocalPolicyExecutionBackend(): ExecutionBackend {
  return {
    descriptor: LOCAL_POLICY_BACKEND_DESCRIPTOR,
    invoke: (request, policy) =>
      runCommand(
        policy,
        {
          rootId: request.rootId,
          command: request.command,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          artifacts: request.artifacts,
        },
        request.signal
      ),
    // No adapter today accepts an invocation id alone as proof of anything —
    // this backend cannot dedupe or replay a result, so it always declines.
    recoverInvocation: async () => ({ status: "unknown" }),
  }
}
