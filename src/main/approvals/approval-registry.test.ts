// src/main/approvals/approval-registry.test.ts
import { describe, expect, it } from "vitest"
import { ApprovalRegistry } from "./approval-registry"

describe("approvalRegistry — register / resolveByHuman", () => {
  it("registers a new pending request and resolves it when resolveByHuman is called", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-grant", {})
    expect(outcome.status).toBe("registered")
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "capability-grant", true)

    await expect(outcome.handle.result).resolves.toEqual({ allow: true })
  })

  it("resolveByHuman with allow:false and no reason resolves a plain deny (no outcomeReason)", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("host-resource", {})
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "host-resource", false)

    await expect(outcome.handle.result).resolves.toEqual({ allow: false })
  })

  it("resolveByHuman no-ops on an unknown id", () => {
    const registry = new ApprovalRegistry()
    expect(() => registry.resolveByHuman("nonexistent", "capability-grant", true)).not.toThrow()
  })

  it("resolveByHuman no-ops when the kind does not match the registered kind", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-approval", {})
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "host-resource", true)

    // Still pending — the mismatched-kind resolve was ignored.
    let settled = false
    void outcome.handle.result.then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it("a second resolveByHuman for the same id is a no-op (first-settle-wins)", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-grant", {})
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "capability-grant", true)
    registry.resolveByHuman(outcome.handle.id, "capability-grant", false)

    await expect(outcome.handle.result).resolves.toEqual({ allow: true })
  })

  it("register defaults to a fresh id (UUID-shaped) when none is supplied", () => {
    const registry = new ApprovalRegistry()
    const a = registry.register("capability-grant", {})
    const b = registry.register("capability-grant", {})
    if (a.status !== "registered" || b.status !== "registered") throw new Error("unreachable")
    expect(a.handle.id).not.toBe(b.handle.id)
    expect(a.handle.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("register accepts a caller-supplied id and uses it verbatim", () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("host-resource", { id: "explicit-id-123" })
    if (outcome.status !== "registered") throw new Error("unreachable")
    expect(outcome.handle.id).toBe("explicit-id-123")
  })

  it("a duplicate caller-supplied id is rejected without touching the live entry", async () => {
    const registry = new ApprovalRegistry()
    const first = registry.register("host-resource", { id: "dup" })
    if (first.status !== "registered") throw new Error("unreachable")

    const second = registry.register("host-resource", { id: "dup" })

    expect(second.status).toBe("duplicate-id")
    registry.resolveByHuman("dup", "host-resource", true)
    await expect(first.handle.result).resolves.toEqual({ allow: true })
  })

  it("registering with an already-aborted signal returns already-aborted and never creates a live entry", () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    controller.abort()

    const outcome = registry.register("capability-approval", { signal: controller.signal })

    expect(outcome.status).toBe("already-aborted")
  })

  it("aborting the signal after registration resolves with outcomeReason 'cancelled' by default (no typed reason)", async () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    const outcome = registry.register("capability-grant", { signal: controller.signal })
    if (outcome.status !== "registered") throw new Error("unreachable")

    controller.abort()

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "cancelled",
    })
  })

  it("aborting with a typed reason ('timed-out' or 'client-disconnected') maps directly", async () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    const outcome = registry.register("capability-grant", { signal: controller.signal })
    if (outcome.status !== "registered") throw new Error("unreachable")

    controller.abort("timed-out")

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "timed-out",
    })
  })

  it("an unrecognized abort reason falls back to 'cancelled'", async () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    const outcome = registry.register("capability-grant", { signal: controller.signal })
    if (outcome.status !== "registered") throw new Error("unreachable")

    controller.abort(new Error("some unrelated DOMException"))

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "cancelled",
    })
  })

  it("first-settle-wins under a synthetic race: resolve and abort in the same tick", async () => {
    const registry = new ApprovalRegistry()
    const controller = new AbortController()
    const outcome = registry.register("capability-grant", { signal: controller.signal })
    if (outcome.status !== "registered") throw new Error("unreachable")

    registry.resolveByHuman(outcome.handle.id, "capability-grant", true)
    controller.abort()

    await expect(outcome.handle.result).resolves.toEqual({ allow: true })
  })
})

function fakeWebContents(): { id: number; isDestroyed: () => boolean; destroy: () => void } {
  let destroyed = false
  return {
    id: Math.random(),
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
  }
}

describe("approvalRegistry — deliveredTo / markDelivered / retireRecipient", () => {
  it("markDelivered backfills the recipients a still-pending registration was sent to", () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-grant", {})
    if (outcome.status !== "registered") throw new Error("unreachable")
    const wc = fakeWebContents()

    expect(() => registry.markDelivered(outcome.handle.id, [wc as never])).not.toThrow()
  })

  it("markDelivered on an already-settled registration immediately pushes a settled callback for the just-learned recipients", async () => {
    const settled: Array<{ id: string; recipients: readonly unknown[] }> = []
    const registry = new ApprovalRegistry({
      onSettled: (id, _outcome, recipients) => settled.push({ id, recipients }),
    })
    const outcome = registry.register("capability-grant", {})
    if (outcome.status !== "registered") throw new Error("unreachable")
    registry.resolveByHuman(outcome.handle.id, "capability-grant", true)
    const wc = fakeWebContents()

    registry.markDelivered(outcome.handle.id, [wc as never])

    expect(settled).toEqual([{ id: outcome.handle.id, recipients: [wc] }])
  })

  it("cancel() settles only the one registration it targets", async () => {
    const registry = new ApprovalRegistry()
    const a = registry.register("host-resource", {})
    const b = registry.register("host-resource", {})
    if (a.status !== "registered" || b.status !== "registered") throw new Error("unreachable")

    registry.cancel(a.handle.id, "send-failed")

    await expect(a.handle.result).resolves.toEqual({ allow: false, outcomeReason: "send-failed" })
    registry.resolveByHuman(b.handle.id, "host-resource", true)
    await expect(b.handle.result).resolves.toEqual({ allow: true })
  })

  it("retireRecipient leaves an entry pending while at least one other recipient survives", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-approval", {})
    if (outcome.status !== "registered") throw new Error("unreachable")
    const wcA = fakeWebContents()
    const wcB = fakeWebContents()
    registry.markDelivered(outcome.handle.id, [wcA as never, wcB as never])

    registry.retireRecipient(wcA as never)

    let settled = false
    void outcome.handle.result.then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it("retireRecipient settles 'gui-disposed' once every delivered recipient has been retired", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("capability-approval", {})
    if (outcome.status !== "registered") throw new Error("unreachable")
    const wcA = fakeWebContents()
    const wcB = fakeWebContents()
    registry.markDelivered(outcome.handle.id, [wcA as never, wcB as never])

    registry.retireRecipient(wcA as never)
    registry.retireRecipient(wcB as never)

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "gui-disposed",
    })
  })

  it("retireRecipient on a webContents not in any deliveredTo set is a harmless no-op", () => {
    const registry = new ApprovalRegistry()
    registry.register("capability-grant", {})
    const unrelated = fakeWebContents()

    expect(() => registry.retireRecipient(unrelated as never)).not.toThrow()
  })

  it("disposeAll cancels every pending entry as 'gui-disposed' regardless of deliveredTo", async () => {
    const registry = new ApprovalRegistry()
    const a = registry.register("capability-grant", {})
    const b = registry.register("host-resource", {})
    if (a.status !== "registered" || b.status !== "registered") throw new Error("unreachable")
    registry.markDelivered(a.handle.id, [fakeWebContents() as never])

    registry.disposeAll()

    await expect(a.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "gui-disposed",
    })
    await expect(b.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "gui-disposed",
    })
  })
})

describe("approvalRegistry — handle-bound markDelivered/cancel", () => {
  it("handle.markDelivered and handle.cancel delegate to the same registry-level behavior", async () => {
    const registry = new ApprovalRegistry()
    const outcome = registry.register("host-resource", {})
    if (outcome.status !== "registered") throw new Error("unreachable")

    outcome.handle.cancel("send-failed")

    await expect(outcome.handle.result).resolves.toEqual({
      allow: false,
      outcomeReason: "send-failed",
    })
  })
})
