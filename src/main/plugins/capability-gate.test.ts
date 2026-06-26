import type { CapabilityAuditEntry, CapabilityRequest } from "./capability-gate"
import type { GrantIdentity } from "./grant-store"
import { describe, expect, it, vi } from "vitest"
import { CapabilityDenied, CapabilityGate } from "./capability-gate"

function identity(): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "h",
  }
}

function makeGate(opts: {
  declared?: string[]
  granted?: string[]
  prompt?: () => Promise<boolean>
  approve?: () => Promise<boolean>
}) {
  const granted = new Set(opts.granted ?? [])
  const grants = {
    isGranted: vi.fn(async (_id: GrantIdentity, cap: string) => granted.has(cap)),
    grant: vi.fn(async (_id: GrantIdentity, cap: string) => {
      granted.add(cap)
    }),
  }
  const prompt = vi.fn(opts.prompt ?? (async () => true))
  const approve = vi.fn(opts.approve ?? (async () => true))
  const audit: CapabilityAuditEntry[] = []
  const gate = new CapabilityGate({
    identity: identity(),
    declared: (opts.declared ?? []).map((id) => ({ id })),
    grants,
    prompt,
    approve,
    audit: (entry) => audit.push(entry),
  })
  return { gate, grants, prompt, approve, audit }
}

function req(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    capability: "clipboard:read",
    actor: "user",
    trigger: "command:x",
    operation: "read",
    ...overrides,
  }
}

describe("capabilityGate.ensure", () => {
  it("denies an undeclared capability", async () => {
    const { gate, audit } = makeGate({ declared: [] })
    await expect(gate.ensure(req())).rejects.toBeInstanceOf(CapabilityDenied)
    expect(audit.at(-1)?.decision).toBe("deny")
  })

  it("allows an auto-tier capability without prompting or approving", async () => {
    const { gate, prompt, approve } = makeGate({ declared: ["storage:plugin"] })
    await expect(gate.ensure(req({ capability: "storage:plugin" }))).resolves.toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
  })

  it("allows an already-granted consent capability without prompting", async () => {
    const { gate, prompt } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
    await gate.ensure(req())
    expect(prompt).not.toHaveBeenCalled()
  })

  it("adds a short identity fingerprint to audit records", async () => {
    const { gate, audit } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
    await gate.ensure(req())
    expect(audit.at(-1)?.identityFingerprint).toMatch(/^[a-f0-9]{12}$/)
  })

  it("prompts and persists when an ungranted consent capability is used", async () => {
    const { gate, prompt, grants } = makeGate({ declared: ["clipboard:read"] })
    await gate.ensure(req())
    expect(prompt).toHaveBeenCalledOnce()
    expect(grants.grant).toHaveBeenCalledWith(identity(), "clipboard:read", "user", undefined)
  })

  it("denies when the consent prompt is refused", async () => {
    const { gate } = makeGate({ declared: ["clipboard:read"], prompt: async () => false })
    await expect(gate.ensure(req())).rejects.toBeInstanceOf(CapabilityDenied)
  })

  it("prompts then per-call approves an ungranted elevated capability driven by the agent", async () => {
    const { gate, prompt, approve } = makeGate({ declared: ["clipboard:watch"] })
    await gate.ensure(req({ capability: "clipboard:watch", actor: "agent" }))
    expect(prompt).toHaveBeenCalledOnce()
    expect(approve).toHaveBeenCalledOnce()
  })

  it("still per-call approves an already-granted elevated capability for agent/background", async () => {
    const { gate, approve } = makeGate({
      declared: ["clipboard:watch"],
      granted: ["clipboard:watch"],
      approve: async () => false,
    })
    await expect(
      gate.ensure(req({ capability: "clipboard:watch", actor: "agent" }))
    ).rejects.toBeInstanceOf(CapabilityDenied)
    expect(approve).toHaveBeenCalledOnce()
  })

  it("does not per-call approve an elevated capability driven by the user", async () => {
    const { gate, approve } = makeGate({
      declared: ["clipboard:watch"],
      granted: ["clipboard:watch"],
    })
    await gate.ensure(req({ capability: "clipboard:watch", actor: "user" }))
    expect(approve).not.toHaveBeenCalled()
  })

  it("denies an unscoped capability call that carries a requestedScope", async () => {
    const { gate } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
    await expect(
      gate.ensure(req({ capability: "clipboard:read", requestedScope: { x: 1 } }))
    ).rejects.toThrow(/scope not allowed/)
  })

  it.todo("enforces scoped containment once network adapter is registered (Task 12)")
})

describe("capabilityGate.assertDeclared", () => {
  it("throws synchronously for an undeclared capability and passes a declared one", () => {
    const { gate } = makeGate({ declared: ["clipboard:read"] })
    expect(() => gate.assertDeclared("network:http")).toThrow(CapabilityDenied)
    expect(() => gate.assertDeclared("clipboard:read")).not.toThrow()
  })
})
