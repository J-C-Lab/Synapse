import type { GrantIdentity, GrantStore } from "./grant-store"
import { getCapability } from "@synapse/plugin-manifest"

// The runtime decision engine. A grant is not a one-time pass — it is a
// context-bearing capability-call decision. `ensure` evaluates each call with
// full context (who triggered it, what operation, what scope, why), JIT-prompts
// for ungranted consent/elevated capabilities, and ALWAYS re-approves elevated
// capabilities driven by the agent or by background activity, even with a
// standing grant. The synchronous `assertDeclared` mirrors the manifest/load
// declaration check.

export type CapabilityActor = "user" | "agent" | "background"

export interface CapabilityRequest {
  capability: string
  actor: CapabilityActor
  /** What initiated the call, e.g. "command:hello.world" | "tool:greet" | "clipboard:change". */
  trigger: string
  /** The concrete operation, e.g. "read" | "POST api.github.com/repos" | "write ~/Documents/x". */
  operation: string
  /** The scope THIS call needs; matched against the capability's scopeSchema when enforced. */
  requestedScope?: unknown
  /** Human-readable justification — shown in the prompt and audited. */
  reason?: string
}

export class CapabilityDenied extends Error {
  constructor(
    readonly pluginId: string,
    readonly capability: string,
    readonly why: string
  ) {
    super(`Capability denied for ${pluginId}: ${capability} (${why})`)
    this.name = "CapabilityDenied"
  }
}

export interface GrantPromptPort {
  (input: { identity: GrantIdentity; request: CapabilityRequest; tier: string }): Promise<boolean>
}

export interface CapabilityApprover {
  (input: { identity: GrantIdentity; request: CapabilityRequest }): Promise<boolean>
}

export interface CapabilityAuditEntry {
  pluginId: string
  capability: string
  tier: string
  actor: CapabilityActor
  trigger: string
  operation: string
  requestedScope?: unknown
  reason?: string
  decision: "allow" | "deny"
  grantedNow: boolean
  why: string
}

export interface CapabilityGateOptions {
  identity: GrantIdentity
  declared: ReadonlySet<string>
  grants: Pick<GrantStore, "isGranted" | "grant">
  prompt: GrantPromptPort
  approve: CapabilityApprover
  audit: (entry: CapabilityAuditEntry) => void
}

export class CapabilityGate {
  constructor(private readonly options: CapabilityGateOptions) {}

  /** Synchronous declaration check (load/manifest time + defense in depth). */
  assertDeclared(capability: string): void {
    if (!this.options.declared.has(capability)) {
      throw new CapabilityDenied(this.options.identity.pluginId, capability, "not declared")
    }
  }

  async ensure(request: CapabilityRequest): Promise<void> {
    const cap = getCapability(request.capability)
    const deny = (why: string, grantedNow = false): never => {
      this.emit(request, "deny", grantedNow, why, cap?.tier)
      throw new CapabilityDenied(this.options.identity.pluginId, request.capability, why)
    }

    if (!cap || !this.options.declared.has(request.capability)) deny("not declared")

    let grantedNow = false
    if (cap.tier !== "auto") {
      const granted = await this.options.grants.isGranted(this.options.identity, request.capability)
      if (!granted) {
        const ok = await this.options.prompt({
          identity: this.options.identity,
          request,
          tier: cap.tier,
        })
        if (!ok) deny("grant refused")
        await this.options.grants.grant(
          this.options.identity,
          request.capability,
          "user",
          request.requestedScope
        )
        grantedNow = true
      }
    }

    // A standing grant is necessary, not sufficient: an elevated capability
    // driven by the agent or by background activity is re-approved per call.
    if (cap.tier === "elevated" && (request.actor === "agent" || request.actor === "background")) {
      const ok = await this.options.approve({ identity: this.options.identity, request })
      if (!ok) deny("per-call approval refused", grantedNow)
    }

    this.emit(request, "allow", grantedNow, "permitted", cap.tier)
  }

  private emit(
    request: CapabilityRequest,
    decision: "allow" | "deny",
    grantedNow: boolean,
    why: string,
    tier = "unknown"
  ): void {
    this.options.audit({
      pluginId: this.options.identity.pluginId,
      capability: request.capability,
      tier,
      actor: request.actor,
      trigger: request.trigger,
      operation: request.operation,
      requestedScope: request.requestedScope,
      reason: request.reason,
      decision,
      grantedNow,
      why,
    })
  }
}
