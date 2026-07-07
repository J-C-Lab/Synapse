import type { CapabilityAuditEntry, CapabilityRequest } from "./capability-gate"
import type { GrantIdentity } from "./grant-store"
import { rootIdForPattern } from "@synapse/plugin-manifest"
import { describe, expect, it, vi } from "vitest"
import { BackgroundInvoker } from "./background-invoker"
import { CapabilityDenied, CapabilityGate } from "./capability-gate"
import { BudgetLedger } from "./trigger-budget"
import { createBudgetBreakerPort } from "./trigger-budget-breaker"

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
  /** Pre-shaped declared entries with scopes, for scope-enforced capabilities. */
  declaredEntries?: { id: string; scope?: unknown }[]
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
  const declared = opts.declaredEntries ?? (opts.declared ?? []).map((id) => ({ id }))
  const gate = new CapabilityGate({
    identity: identity(),
    declared,
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

  it("allows a scoped network:https call contained by the declared scope", async () => {
    const { gate } = makeGate({
      declaredEntries: [
        {
          id: "network:https",
          scope: { hosts: ["api.github.com"], methods: ["GET"], paths: ["/repos/**"] },
        },
      ],
      granted: ["network:https"],
    })
    // actor "user" (req default) skips per-call approval, so the scope decision
    // is what's asserted here — not the elevated approval flow.
    await expect(
      gate.ensure(
        req({
          capability: "network:https",
          operation: "GET",
          requestedScope: { host: "api.github.com", method: "GET", path: "/repos/x" },
        })
      )
    ).resolves.toBeUndefined()
  })

  it("denies a scoped network:https call to a host outside the declared scope", async () => {
    const { gate } = makeGate({
      declaredEntries: [
        {
          id: "network:https",
          scope: { hosts: ["api.github.com"], methods: ["GET"], paths: ["/repos/**"] },
        },
      ],
      granted: ["network:https"],
    })
    await expect(
      gate.ensure(
        req({
          capability: "network:https",
          operation: "GET",
          requestedScope: { host: "evil.com", method: "GET", path: "/repos/x" },
        })
      )
    ).rejects.toThrow(/scope not allowed/)
  })

  it("copies runId onto the audited entry", async () => {
    const { gate, audit } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
    await gate.ensure(req({ runId: "run-123" }))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ runId: "run-123" })
  })

  it("omits runId from the audited entry when the request has none", async () => {
    const { gate, audit } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
    await gate.ensure(req())
    expect(audit[0].runId).toBeUndefined()
  })

  it("attributes a capability decision to the subagent's child runId", async () => {
    const { gate, audit } = makeGate({ declared: ["clipboard:read"], granted: ["clipboard:read"] })
    await gate.ensure(req({ runId: "child-run", actor: "agent" }))
    expect(audit[0]).toMatchObject({ runId: "child-run" })
  })

  it("copies principal and workspaceId onto the audited entry", async () => {
    const audited: CapabilityAuditEntry[] = []
    const gate = new CapabilityGate({
      identity: {
        pluginId: "com.x",
        publisherId: "pub",
        signingKeyFingerprint: "fp",
        capabilityDeclarationHash: "hash",
      },
      declared: [{ id: "storage:plugin" }],
      grants: { isGranted: async () => true, grant: async () => {} },
      prompt: async () => true,
      approve: async () => true,
      audit: (entry) => audited.push(entry),
    })

    await gate.ensure({
      capability: "storage:plugin",
      actor: "agent",
      trigger: "tool:read_probe",
      operation: "read",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-external",
    })

    expect(audited).toHaveLength(1)
    expect(audited[0]).toMatchObject({
      decision: "allow",
      principal: { kind: "external-mcp", clientId: "claude-desktop" },
      workspaceId: "ws-external",
    })
  })
})

describe("capabilityGate.assertDeclared", () => {
  it("throws synchronously for an undeclared capability and passes a declared one", () => {
    const { gate } = makeGate({ declared: ["clipboard:read"] })
    expect(() => gate.assertDeclared("network:http")).toThrow(CapabilityDenied)
    expect(() => gate.assertDeclared("clipboard:read")).not.toThrow()
  })
})

function gateWithBudget(
  tryDebit: () => "debited" | "not-in-uses" | "exhausted",
  opts: {
    declared?: { id: string; scope?: unknown }[]
    granted?: boolean
    prompt?: () => Promise<boolean>
    approve?: () => Promise<boolean>
  } = {}
) {
  const audit: CapabilityAuditEntry[] = []
  const gate = new CapabilityGate({
    identity: identity(),
    declared: opts.declared ?? [
      {
        id: "network:https",
        scope: { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] },
      },
    ],
    grants: { isGranted: async () => opts.granted ?? true, grant: async () => {} },
    prompt: opts.prompt ?? (async () => true),
    approve:
      opts.approve ??
      (async () => {
        throw new Error("approve() must NOT be called for trigger origin")
      }),
    audit: (entry) => audit.push(entry),
    budgetBreaker: {
      isTriggerOrigin: (id) => id === "inv-1",
      tryDebit: () => tryDebit(),
    },
  })
  return { gate, audit }
}

describe("capabilityGate budget breaker", () => {
  it("permits a trigger-origin elevated call without prompting when budget remains", async () => {
    const { gate } = gateWithBudget(() => "debited")
    await expect(
      gate.ensure({
        capability: "network:https",
        actor: "background",
        trigger: "timer:t",
        operation: "GET",
        requestedScope: { host: "api.example.com", method: "GET", path: "/x" },
        invocationId: "inv-1",
      })
    ).resolves.toBeUndefined()
  })

  it("denies (no prompt) when the budget is exhausted", async () => {
    const { gate, audit } = gateWithBudget(() => "exhausted")
    await expect(
      gate.ensure({
        capability: "network:https",
        actor: "background",
        trigger: "timer:t",
        operation: "GET",
        requestedScope: { host: "api.example.com", method: "GET", path: "/x" },
        invocationId: "inv-1",
      })
    ).rejects.toBeInstanceOf(CapabilityDenied)
    expect(audit.at(-1)?.why).toMatch(/budget/)
  })

  it("denies with a distinct reason when the capability is not in trigger uses", async () => {
    const { gate, audit } = gateWithBudget(() => "not-in-uses")
    await expect(
      gate.ensure({
        capability: "network:https",
        actor: "background",
        trigger: "timer:t",
        operation: "GET",
        requestedScope: { host: "api.example.com", method: "GET", path: "/x" },
        invocationId: "inv-1",
      })
    ).rejects.toBeInstanceOf(CapabilityDenied)
    expect(audit.at(-1)?.why).toMatch(/not in trigger uses/)
  })

  it("denies trigger-origin consent calls without JIT prompt when not granted at enable", async () => {
    const prompt = vi.fn(async () => true)
    const { gate } = gateWithBudget(() => "debited", {
      declared: [{ id: "clipboard:read" }],
      granted: false,
      prompt,
    })
    await expect(
      gate.ensure({
        capability: "clipboard:read",
        actor: "background",
        trigger: "clipboard:clip",
        operation: "read",
        invocationId: "inv-1",
      })
    ).rejects.toThrow(/not granted at enable time/)
    expect(prompt).not.toHaveBeenCalled()
  })

  it("allows a reversible elevated fs:write trigger-origin call without per-call approval", async () => {
    const approve = vi.fn(async () => true)
    const { gate } = gateWithBudget(() => "debited", {
      declared: [{ id: "fs:write", scope: { paths: ["~/Downloads/**"] } }],
      approve,
    })

    await gate.ensure({
      capability: "fs:write",
      actor: "background",
      trigger: "fs.watch:downloads",
      operation: "move",
      requestedScope: { rootId: rootIdForPattern("~/Downloads/**"), relativePath: "a.txt" },
      invocationId: "inv-1",
      reversible: true,
    })

    expect(approve).not.toHaveBeenCalled()
  })

  it("allows a reversible elevated fs:write background-agent call without per-call approval", async () => {
    const approve = vi.fn(async () => true)
    const { gate } = gateWithBudget(() => "debited", {
      declared: [{ id: "fs:write", scope: { paths: ["~/Downloads/**"] } }],
      approve,
    })

    await gate.ensure({
      capability: "fs:write",
      actor: "background-agent",
      trigger: "fs.watch:downloads",
      operation: "move",
      requestedScope: { rootId: rootIdForPattern("~/Downloads/**"), relativePath: "a.txt" },
      invocationId: "inv-1",
      reversible: true,
    })

    expect(approve).not.toHaveBeenCalled()
  })

  it("escalates an irreversible elevated fs:write trigger-origin call to per-call approval", async () => {
    const approve = vi.fn(async () => true)
    const { gate } = gateWithBudget(() => "debited", {
      declared: [{ id: "fs:write", scope: { paths: ["~/Downloads/**"] } }],
      approve,
    })

    await gate.ensure({
      capability: "fs:write",
      actor: "background",
      trigger: "fs.watch:downloads",
      operation: "writeText",
      requestedScope: { rootId: rootIdForPattern("~/Downloads/**"), relativePath: "a.txt" },
      invocationId: "inv-1",
      reversible: false,
    })

    expect(approve).toHaveBeenCalledTimes(1)
  })

  it("denies an irreversible trigger-origin write when approval is refused", async () => {
    const approve = vi.fn(async () => false)
    const { gate } = gateWithBudget(() => "debited", {
      declared: [{ id: "fs:write", scope: { paths: ["~/Downloads/**"] } }],
      approve,
    })

    await expect(
      gate.ensure({
        capability: "fs:write",
        actor: "background",
        trigger: "fs.watch:downloads",
        operation: "writeText",
        requestedScope: { rootId: rootIdForPattern("~/Downloads/**"), relativePath: "a.txt" },
        invocationId: "inv-1",
        reversible: false,
      })
    ).rejects.toBeInstanceOf(CapabilityDenied)
  })

  it("enforces per-trigger budget for consent-tier clipboard:read", async () => {
    const invoker = new BackgroundInvoker(() => 0)
    const ledger = new BudgetLedger(() => 0)
    const decl = {
      id: "clip",
      type: "clipboard" as const,
      handler: "triggers.onClip",
      uses: [{ capability: "clipboard:read", budget: { maxCalls: 20, period: "1h" as const } }],
    }
    const breaker = createBudgetBreakerPort({
      invoker,
      ledger,
      manifestFor: () => ({ triggers: [decl] }) as never,
      registry: { getDeclaration: () => decl },
    })
    const { invocationId } = invoker.mint({
      pluginId: "p",
      triggerId: "clip",
      actor: "background",
      trigger: "clipboard:clip",
      signal: new AbortController().signal,
    })

    const gate = new CapabilityGate({
      identity: identity(),
      declared: [{ id: "clipboard:read" }],
      grants: { isGranted: async () => true, grant: async () => {} },
      prompt: async () => {
        throw new Error("prompt must not run")
      },
      approve: async () => {
        throw new Error("approve must not run")
      },
      audit: () => {},
      budgetBreaker: breaker,
    })

    for (let i = 0; i < 20; i++) {
      await gate.ensure({
        capability: "clipboard:read",
        actor: "background",
        trigger: "clipboard:clip",
        operation: "read",
        invocationId,
      })
    }
    await expect(
      gate.ensure({
        capability: "clipboard:read",
        actor: "background",
        trigger: "clipboard:clip",
        operation: "read",
        invocationId,
      })
    ).rejects.toThrow(/budget exhausted/)
  })
})
