import type { ApprovalOutcomeReason, ApprovalResult } from "./types"
// src/main/approvals/approval-registry.ts
import { randomUUID } from "node:crypto"

export type ApprovalKind = "capability-grant" | "capability-approval" | "host-resource"

export type RegisterOutcome =
  | { status: "registered"; handle: ApprovalHandle }
  | { status: "already-aborted" }
  | { status: "duplicate-id" }

export interface ApprovalHandle {
  readonly id: string
  readonly result: Promise<ApprovalResult>
}

export interface RegisterOptions {
  id?: string
  signal?: AbortSignal
}

const WIRE_REASONS: readonly ApprovalOutcomeReason[] = [
  "cancelled",
  "gui-disposed",
  "send-failed",
  "timed-out",
  "client-disconnected",
]

function reasonFromAbortSignal(signal: AbortSignal): ApprovalOutcomeReason {
  const reason = signal.reason
  if (typeof reason === "string" && (WIRE_REASONS as readonly string[]).includes(reason)) {
    return reason as ApprovalOutcomeReason
  }
  return "cancelled"
}

interface PendingEntry {
  kind: ApprovalKind
  resolve: (result: ApprovalResult) => void
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingEntry>()

  register(kind: ApprovalKind, options: RegisterOptions): RegisterOutcome {
    const id = options.id ?? randomUUID()
    if (options.id !== undefined && this.pending.has(id)) {
      return { status: "duplicate-id" }
    }
    if (options.signal?.aborted) {
      return { status: "already-aborted" }
    }

    let settle: (result: ApprovalResult) => void
    const result = new Promise<ApprovalResult>((resolve) => {
      settle = resolve
    })

    const finish = (outcome: ApprovalResult): void => {
      if (!this.pending.delete(id)) return
      settle(outcome)
    }

    this.pending.set(id, { kind, resolve: finish })

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => finish({ allow: false, outcomeReason: reasonFromAbortSignal(options.signal!) }),
        { once: true }
      )
    }

    return { status: "registered", handle: { id, result } }
  }

  resolveByHuman(id: string, expectedKind: ApprovalKind, allow: boolean): void {
    const entry = this.pending.get(id)
    if (!entry || entry.kind !== expectedKind) return
    entry.resolve(allow ? { allow: true } : { allow: false })
  }
}
