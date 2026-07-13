/** Only the two reasons the headless side ever chooses to send — the rest
 *  of ApprovalOutcomeReason ("gui-disposed", "send-failed",
 *  "client-disconnected") are GUI-local or headless-local outcomes that
 *  never need to cross the wire as a value. */
export type CancelWireReason = "cancelled" | "timed-out"

export interface CancelFrame {
  type: "cancel"
  requestId: string
  reason: CancelWireReason
}

const WIRE_REASONS: readonly CancelWireReason[] = ["cancelled", "timed-out"]

/** Parses and strictly validates an incoming line as a cancel frame for
 *  `expectedRequestId` — the id established by this connection's own
 *  first (request) frame. Anything else — wrong shape, wrong id, invalid
 *  reason — is treated as untrusted and returns undefined; callers must
 *  handle that the same way as any other malformed input on this
 *  transport (tear the connection down), never guess at intent. */
export function parseCancelFrame(
  value: unknown,
  expectedRequestId: string
): CancelFrame | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (v.type !== "cancel") return undefined
  if (v.requestId !== expectedRequestId) return undefined
  if (typeof v.reason !== "string" || !(WIRE_REASONS as readonly string[]).includes(v.reason)) {
    return undefined
  }
  return { type: "cancel", requestId: expectedRequestId, reason: v.reason as CancelWireReason }
}
