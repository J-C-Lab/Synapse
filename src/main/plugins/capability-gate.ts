import type { NormalizedCapability } from "@synapse/plugin-manifest"
import type { GrantIdentity, GrantStore } from "./grant-store"
import { createHash } from "node:crypto"
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
  /** When aborted (tool timeout, capability revoke, renderer reload), pending prompts deny. */
  signal?: AbortSignal
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
  identityFingerprint: string
  capabilityId: string
  tier: string
  actor: CapabilityActor
  trigger: string
  operation: string
  requestedScope?: unknown
  declaredScope?: unknown
  grantScope?: unknown
  reason?: string
  decision: "allow" | "deny"
  grantedNow: boolean
  why: string
}

export interface CapabilityGateOptions {
  identity: GrantIdentity
  declared: readonly NormalizedCapability[]
  grants: Pick<GrantStore, "isGranted" | "grant">
  prompt: GrantPromptPort
  approve: CapabilityApprover
  audit: (entry: CapabilityAuditEntry) => void
}

/** Minimal gate surface used by {@link PluginBridge} (and tests). */
export interface CapabilityGatePort {
  assertDeclared: (capability: string) => void
  ensure: (request: CapabilityRequest) => Promise<void>
}

export class CapabilityGate implements CapabilityGatePort {
  private readonly declaredById: Map<string, NormalizedCapability>

  constructor(private readonly options: CapabilityGateOptions) {
    this.declaredById = new Map(options.declared.map((c) => [c.id, c]))
  }

  /** Synchronous declaration check (load/manifest time + defense in depth). */
  assertDeclared(capability: string): void {
    if (!this.declaredById.has(capability)) {
      throw new CapabilityDenied(this.options.identity.pluginId, capability, "not declared")
    }
  }

  async ensure(request: CapabilityRequest): Promise<void> {
    const cap = getCapability(request.capability)
    const declared = this.declaredById.get(request.capability)
    if (!cap || !declared) {
      this.emit(request, "deny", false, "not declared", cap?.tier)
      throw new CapabilityDenied(this.options.identity.pluginId, request.capability, "not declared")
    }

    const deny = (why: string, grantedNow = false): never => {
      this.emit(request, "deny", grantedNow, why, cap.tier)
      throw new CapabilityDenied(this.options.identity.pluginId, request.capability, why)
    }

    // Scope decisions are owned by the capability's adapter — the gate only
    // routes the call to it. Three outcomes for a scoped call: an unscoped
    // capability carrying a scope is denied outright; a scope-enforced capability
    // whose adapter is not yet registered is denied (fail closed); otherwise the
    // adapter decides whether the declared scope contains what this call requests.
    if (request.requestedScope !== undefined) {
      if (!cap.scopeEnforced) deny("scope not allowed on unscoped capability")
      else if (!cap.scopeAdapter) deny("scope adapter not registered")
      else if (!cap.scopeAdapter.contains(declared.scope, request.requestedScope)) {
        deny("scope not allowed")
      }
    }

    let grantedNow = false
    if (cap.tier !== "auto") {
      const granted = await this.options.grants.isGranted(
        this.options.identity,
        request.capability,
        request.requestedScope
      )
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
          declared.scope
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
      identityFingerprint: identityFingerprint(this.options.identity),
      capabilityId: request.capability,
      tier,
      actor: request.actor,
      trigger: request.trigger,
      operation: request.operation,
      requestedScope: request.requestedScope,
      declaredScope: this.declaredById.get(request.capability)?.scope,
      reason: request.reason,
      decision,
      grantedNow,
      why,
    })
  }
}

function identityFingerprint(identity: GrantIdentity): string {
  return createHash("sha256")
    .update(
      [
        identity.pluginId,
        identity.publisherId,
        identity.signingKeyFingerprint,
        identity.capabilityDeclarationHash,
      ].join("\n")
    )
    .digest("hex")
    .slice(0, 12)
}
