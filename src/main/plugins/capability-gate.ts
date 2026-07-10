import type { NormalizedCapability } from "@synapse/plugin-manifest"
import type { ToolPrincipal } from "@synapse/plugin-sdk"
import type { GrantIdentity, GrantStore } from "./grant-store"
import { createHash } from "node:crypto"
import { getCapability } from "@synapse/plugin-manifest"

// The runtime decision engine. A grant is not a one-time pass — it is a
// context-bearing capability-call decision. Non-trigger calls JIT-prompt for
// ungranted consent/elevated capabilities and re-approve elevated agent/background
// work. Trigger-origin calls (host-minted invocationId) require enable-time grants
// and debit per-trigger `uses` budgets — no JIT prompt and no per-call approve.

export type CapabilityActor =
  | "user"
  | "agent"
  | "background"
  | "background-agent"
  | "external-mcp"
  | "subagent"

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
  /** Set by the host for trigger-origin background calls; resolves the budget path. */
  invocationId?: string
  /** The agent run this call belongs to; copied through to the audit entry. */
  runId?: string
  /** Who initiated the call — the finer identity behind the coarse `actor`. */
  principal?: ToolPrincipal
  /** The workspace this call is bound to; copied through to the audit entry. */
  workspaceId?: string
  /** Host-computed: whether this concrete write operation can be reversed. */
  reversible?: boolean
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
  /** The agent run this decision belongs to; absent for out-of-run decisions. */
  runId?: string
  principal?: ToolPrincipal
  workspaceId?: string
}

export type BudgetDebitOutcome = "debited" | "not-in-uses" | "exhausted"

export interface BudgetBreakerPort {
  isTriggerOrigin: (invocationId: string | undefined) => boolean
  /** Debits the trigger's declared use budget, or reports why the call is refused. */
  tryDebit: (request: CapabilityRequest) => BudgetDebitOutcome
}

export interface CapabilityGateOptions {
  identity: GrantIdentity
  declared: readonly NormalizedCapability[]
  grants: Pick<GrantStore, "isGranted" | "grant" | "isExternalMcpPreauthorized">
  prompt: GrantPromptPort
  approve: CapabilityApprover
  audit: (entry: CapabilityAuditEntry) => void
  budgetBreaker?: BudgetBreakerPort
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

    const isTriggerOrigin =
      request.invocationId !== undefined &&
      this.options.budgetBreaker?.isTriggerOrigin(request.invocationId) === true

    if (isTriggerOrigin) {
      if (!this.options.budgetBreaker) deny("trigger origin not configured")

      if (cap.tier !== "auto") {
        const granted = await this.options.grants.isGranted(
          this.options.identity,
          request.capability,
          request.requestedScope
        )
        if (!granted) deny("not granted at enable time")
      }

      const debit = this.options.budgetBreaker!.tryDebit(request)
      if (debit === "not-in-uses") deny("capability not in trigger uses")
      if (debit === "exhausted") deny("budget exhausted")

      if (cap.tier === "elevated" && request.reversible === false) {
        const ok = await this.options.approve({ identity: this.options.identity, request })
        if (!ok) deny("irreversible operation: per-call approval refused")
      }

      this.emit(request, "allow", false, "permitted", cap.tier)
      return
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

    // Fail-safe by default: every actor except the user sitting right in front
    // of the prompt re-approves an elevated capability per call, even once
    // granted. Expressed as a deny-list of "user" (not an allow-list of the
    // non-user actors) so a future CapabilityActor addition is scrutinized by
    // default instead of silently skipping approval until someone remembers
    // to add it here.
    // external-mcp callers can be pre-authorized (Settings) to skip the
    // per-call prompt — but an irreversible call always re-prompts
    // regardless, mirroring the trigger-origin branch's own
    // reversible-escalation rule above. Every other non-user actor
    // (agent/background/background-agent/subagent) is unaffected — this
    // flag has no meaning for them.
    if (cap.tier === "elevated" && request.actor !== "user") {
      const preauthorized =
        request.actor === "external-mcp" &&
        request.reversible !== false &&
        (await this.options.grants.isExternalMcpPreauthorized(
          this.options.identity,
          request.capability
        ))
      if (!preauthorized) {
        const ok = await this.options.approve({ identity: this.options.identity, request })
        if (!ok) deny("per-call approval refused", grantedNow)
      }
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
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      ...(request.principal !== undefined ? { principal: request.principal } : {}),
      ...(request.workspaceId !== undefined ? { workspaceId: request.workspaceId } : {}),
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
