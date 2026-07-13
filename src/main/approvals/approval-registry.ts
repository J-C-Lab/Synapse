import type { WebContents } from "electron"
import type { ApprovalOutcomeReason, ApprovalResult } from "./types"
import { randomUUID } from "node:crypto"

export type ApprovalKind = "capability-grant" | "capability-approval" | "host-resource"

export type RegisterOutcome =
  | { status: "registered"; handle: ApprovalHandle }
  | { status: "already-aborted" }
  | { status: "duplicate-id" }

export interface ApprovalHandle {
  readonly id: string
  readonly result: Promise<ApprovalResult>
  markDelivered: (deliveredTo: readonly WebContents[]) => void
  cancel: (reason: ApprovalOutcomeReason) => void
}

export interface RegisterOptions {
  id?: string
  signal?: AbortSignal
}

export interface ApprovalRegistryOptions {
  /** Called after a pending entry is removed when at least one recipient was
   *  already recorded via markDelivered(). If settlement races ahead of
   *  delivery, finish() skips this callback and markDelivered()'s post-settle
   *  path notifies instead (so prompt hosts still learn about the race). */
  onSettled?: (id: string, outcome: ApprovalResult, recipients: readonly WebContents[]) => void
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
  deliveredTo: Set<WebContents>
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(private readonly options: ApprovalRegistryOptions = {}) {}

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
      const entry = this.pending.get(id)
      if (!entry || !this.pending.delete(id)) return
      settle(outcome)
      if (entry.deliveredTo.size > 0) {
        this.options.onSettled?.(id, outcome, [...entry.deliveredTo])
      }
    }

    this.pending.set(id, { kind, resolve: finish, deliveredTo: new Set() })

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => finish({ allow: false, outcomeReason: reasonFromAbortSignal(options.signal!) }),
        { once: true }
      )
    }

    const handle: ApprovalHandle = {
      id,
      result,
      markDelivered: (deliveredTo) => this.markDelivered(id, deliveredTo),
      cancel: (reason) => this.cancel(id, reason),
    }
    return { status: "registered", handle }
  }

  resolveByHuman(id: string, expectedKind: ApprovalKind, allow: boolean): void {
    const entry = this.pending.get(id)
    if (!entry || entry.kind !== expectedKind) return
    entry.resolve(allow ? { allow: true } : { allow: false })
  }

  /** Backfills which webContents a still-pending (or just-settled)
   *  registration was actually sent to. If it already settled in the
   *  narrow race between register() and this call, immediately notifies
   *  onSettled for the recipients just learned about, so nothing shows a
   *  stale prompt with no one ever telling it to remove it. */
  markDelivered(id: string, deliveredTo: readonly WebContents[]): void {
    const entry = this.pending.get(id)
    if (entry) {
      for (const wc of deliveredTo) entry.deliveredTo.add(wc)
      return
    }
    // Already settled before any recipient was recorded — finish() skipped
    // onSettled; notify now with the recipients just learned about.
    this.options.onSettled?.(id, { allow: false, outcomeReason: "cancelled" }, deliveredTo)
  }

  /** Settles exactly the one registration `id` refers to. */
  cancel(id: string, reason: ApprovalOutcomeReason): void {
    const entry = this.pending.get(id)
    if (!entry) return
    entry.resolve({ allow: false, outcomeReason: reason })
  }

  /** Removes `webContents` from every pending entry's delivered set. An
   *  entry left with zero remaining recipients settles "gui-disposed". */
  retireRecipient(webContents: WebContents): void {
    for (const [id, entry] of [...this.pending]) {
      if (!entry.deliveredTo.delete(webContents)) continue
      if (entry.deliveredTo.size === 0) this.cancel(id, "gui-disposed")
    }
  }

  /** Cancels every pending request unconditionally — app-quit teardown only. */
  disposeAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id, "gui-disposed")
  }
}
