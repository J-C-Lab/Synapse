import type { ApprovalDecision } from "../approval-gate"
import type { ExecutionLogStore } from "./execution-log-store"
import { classifyCommand } from "./command-policy"

export interface ExecutionApprovalRequest {
  conversationId?: string
  fqName: string
  input: unknown
}

export interface ExecutionApprovalResolverOptions {
  log: ExecutionLogStore
  now?: () => number
}

export class ExecutionApprovalResolver {
  constructor(private readonly options: ExecutionApprovalResolverOptions) {}

  async decide(request: ExecutionApprovalRequest): Promise<ApprovalDecision | undefined> {
    const input = isRecord(request.input) ? request.input : {}
    if (input.userDenied === true) {
      if (!request.fqName.startsWith("execution:")) return undefined
      const original = isRecord(input.originalInput) ? input.originalInput : {}
      await this.audit(request, original, "user denied approval")
      return "deny"
    }
    if (request.fqName !== "execution:core/run_command") return undefined
    const command = typeof input.command === "string" ? input.command : ""
    const decision = classifyCommand(command)
    if (decision.decision === "deny") {
      await this.audit(request, input, decision.reason)
    }
    return decision.decision
  }

  private async audit(
    request: ExecutionApprovalRequest,
    input: Record<string, unknown>,
    reason: string
  ): Promise<void> {
    const now = this.options.now?.() ?? Date.now()
    const command = typeof input.command === "string" ? input.command : ""
    const patch = typeof input.patch === "string" ? input.patch : ""
    const preview = command || patch || JSON.stringify(input)
    await this.options.log.append({
      id: crypto.randomUUID(),
      conversationId: request.conversationId,
      toolName: request.fqName,
      workspaceId: typeof input.workspaceId === "string" ? input.workspaceId : undefined,
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      normalizedPaths: [],
      decision: "deny",
      startedAt: now,
      endedAt: now,
      inputPreview: preview.slice(0, 2000),
      outputPreview: "",
      errorPreview: reason,
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
