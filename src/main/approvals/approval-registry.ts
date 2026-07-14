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
  onSettled?: (
    id: string,
    kind: ApprovalKind,
    outcome: ApprovalResult,
    recipients: readonly WebContents[]
  ) => void
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

interface SettledForEntry {
  kind: ApprovalKind
  outcome: ApprovalResult
  settledAt: number
}

// A call site is not required to ever call markDelivered() — e.g. the
// send itself can fail, in which case cancel() settles the registration
// with no delivery info coming, ever. Without a bound, that leaves a
// settledFor entry with nothing left to consume it, forever. Same
// tombstone-with-TTL shape as the renderer's SETTLED_TOMBSTONE_MS
// (capability-prompt-host.tsx) for the mirror-image problem.
const SETTLED_FOR_TTL_MS = 30_000

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingEntry>()
  // Bridges finish() → markDelivered()'s post-settle path when settlement
  // races ahead of delivery: finish() removes the pending entry before
  // markDelivered() ever learns the recipients, so the kind and the real
  // outcome are parked here just long enough for that one callback — the
  // late notification must report what actually happened (allowed/denied/
  // cancelled/etc.), not a guess. Pruned by age, not just by consumption,
  // since consumption (markDelivered) is not guaranteed to happen.
  private readonly settledFor = new Map<string, SettledForEntry>()

  constructor(private readonly options: ApprovalRegistryOptions = {}) {}

  register(kind: ApprovalKind, options: RegisterOptions): RegisterOutcome {
    this.pruneSettledFor()
    const id = options.id ?? randomUUID()
    if (options.id !== undefined && (this.pending.has(id) || this.settledFor.has(id))) {
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
        this.options.onSettled?.(id, entry.kind, outcome, [...entry.deliveredTo])
      } else {
        this.settledFor.set(id, { kind: entry.kind, outcome, settledAt: Date.now() })
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
    this.pruneSettledFor()
    const entry = this.pending.get(id)
    if (entry) {
      for (const wc of deliveredTo) entry.deliveredTo.add(wc)
      return
    }
    // Already settled before any recipient was recorded — finish() skipped
    // onSettled; notify now with the recipients just learned about, using
    // the real outcome finish() parked here (never a guessed one). No
    // entry means either an unknown id or a second markDelivered() call
    // for the same id — either way there is nothing truthful left to
    // report, so this stays silent rather than re-notifying or guessing.
    const settled = this.settledFor.get(id)
    if (!settled) return
    this.settledFor.delete(id)
    this.options.onSettled?.(id, settled.kind, settled.outcome, deliveredTo)
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

  private pruneSettledFor(): void {
    const now = Date.now()
    for (const [id, entry] of this.settledFor) {
      if (now - entry.settledAt > SETTLED_FOR_TTL_MS) this.settledFor.delete(id)
    }
  }
}
