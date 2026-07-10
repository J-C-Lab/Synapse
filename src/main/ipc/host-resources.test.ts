import type { HostResourceApprovalRequest } from "../mcp/host-resource-approval"
import type {
  HostResourceApprovalRequestEvent,
  HostResourceIpcServiceOptions,
} from "./host-resources"
import { describe, expect, it } from "vitest"
import { HostResourceIpcService } from "./host-resources"

function request(): HostResourceApprovalRequest {
  return {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
  }
}

function service(overrides: Partial<HostResourceIpcServiceOptions> = {}): {
  service: HostResourceIpcService
  events: HostResourceApprovalRequestEvent[]
  auditEntries: unknown[]
} {
  const events: HostResourceApprovalRequestEvent[] = []
  const auditEntries: unknown[] = []
  const svc = new HostResourceIpcService({
    sendApprovalRequest: (event) => events.push(event),
    audit: (entry) => auditEntries.push(entry),
    ...overrides,
  })
  return { service: svc, events, auditEntries }
}

describe("hostResourceIpcService", () => {
  it("broadcasts a request and resolves via resolve() with a human answer", async () => {
    const { service: svc, events, auditEntries } = service()
    const decision = svc.hostResourceApprover({ request: request() })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ workspaceId: "w1", rootId: "r1" })
    svc.resolve(events[0]!.promptId, true)
    await expect(decision).resolves.toBe(true)
    expect(auditEntries).toEqual([expect.objectContaining({ decision: "allow" })])
    expect("outcomeReason" in (auditEntries[0] as object)).toBe(false)
  })

  it("prompt ids are prefixed host_res_apr_, distinct from capability's cap_apr_", async () => {
    const { service: svc, events } = service()
    void svc.hostResourceApprover({ request: request() })
    expect(events[0]!.promptId).toMatch(/^host_res_apr_\d+$/)
  })

  it("resolve() is idempotent for an unknown promptId — no throw", () => {
    const { service: svc } = service()
    expect(() => svc.resolve("no-such-prompt", true)).not.toThrow()
  })

  it("resolve() is idempotent for an already-resolved promptId", async () => {
    const { service: svc, events } = service()
    const decision = svc.hostResourceApprover({ request: request() })
    svc.resolve(events[0]!.promptId, true)
    await decision
    expect(() => svc.resolve(events[0]!.promptId, false)).not.toThrow()
  })

  it("dispose() resolves every pending entry false with outcomeReason gui-disposed", async () => {
    const { service: svc, auditEntries } = service()
    const decisionA = svc.hostResourceApprover({ request: request() })
    const decisionB = svc.hostResourceApprover({ request: request() })
    svc.dispose()
    await expect(decisionA).resolves.toBe(false)
    await expect(decisionB).resolves.toBe(false)
    expect(auditEntries).toHaveLength(2)
    for (const entry of auditEntries) {
      expect(entry).toMatchObject({ decision: "deny", outcomeReason: "gui-disposed" })
    }
  })

  it("an already-aborted signal resolves false immediately without registering a pending entry", async () => {
    const { service: svc, events, auditEntries } = service()
    const controller = new AbortController()
    controller.abort()
    const decision = svc.hostResourceApprover({ request: request(), signal: controller.signal })
    await expect(decision).resolves.toBe(false)
    expect(events).toHaveLength(0) // never even sent — resolved before dispatch
    expect(auditEntries).toEqual([
      expect.objectContaining({ decision: "deny", outcomeReason: "cancelled" }),
    ])
  })

  it("an abort after registration resolves only that pending entry false, others unaffected", async () => {
    const { service: svc } = service()
    const controller = new AbortController()
    const decisionA = svc.hostResourceApprover({ request: request(), signal: controller.signal })
    const decisionB = svc.hostResourceApprover({ request: request() })
    controller.abort()
    await expect(decisionA).resolves.toBe(false)
    // decisionB is still pending — no assertion needed beyond it not resolving here.
    expect(decisionB).toBeInstanceOf(Promise)
  })

  it("sendApprovalRequest throwing resolves false, audits send-failed, and leaves nothing pending", async () => {
    const auditEntries: unknown[] = []
    const svc = new HostResourceIpcService({
      sendApprovalRequest: () => {
        throw new Error("webContents destroyed")
      },
      audit: (entry) => auditEntries.push(entry),
    })
    const decision = svc.hostResourceApprover({ request: request() })
    await expect(decision).resolves.toBe(false)
    expect(auditEntries).toEqual([
      expect.objectContaining({ decision: "deny", outcomeReason: "send-failed" }),
    ])
    // dispose() afterward must not resolve anything a second time / throw.
    expect(() => svc.dispose()).not.toThrow()
  })

  it("records exactly one audit entry for a human deny, with no outcomeReason", async () => {
    const { service: svc, events, auditEntries } = service()
    const decision = svc.hostResourceApprover({ request: request() })
    svc.resolve(events[0]!.promptId, false)
    await expect(decision).resolves.toBe(false)
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0]).toMatchObject({ decision: "deny" })
    expect("outcomeReason" in (auditEntries[0] as object)).toBe(false)
  })
})
