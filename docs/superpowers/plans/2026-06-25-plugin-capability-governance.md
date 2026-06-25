# Plugin Capability Governance (Foundation) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (or subagent-driven-development). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the capability-agnostic governance container — tiered capability taxonomy with red lines, a context-bound grant store, two-phase enforcement (sync declaration + async context-bearing `ensure()`), per-call approval for elevated/agent/background calls, redacted audit, and revocation that tears down in-flight use.

**Architecture:** A capability is `{ id, tier, scopeSchema?, scopeEnforced }` in one registry (manifest package). A call passes three gates: declaration (sync, load-time), grant (persisted, keyed by a composite plugin identity), and a per-call `ensure()` decision (async) that JIT-prompts for ungranted consent/elevated caps and always re-approves elevated calls driven by agent/background. Every decision is audited (redacted). Revoke tears down watchers/timers.

**Tech Stack:** TypeScript (strict), Node, zod (manifest schema), Vitest, the structured logger from `src/main/logging`, `atomic-json-store`.

**Spec:** `docs/superpowers/specs/2026-06-25-plugin-capability-governance-design.md`

**Guiding principle (encode everywhere):** a grant is not a one-time pass; it is a context-bearing capability-call decision.

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/plugin-manifest/src/capabilities.ts` (new) | Capability registry, tiers, `capabilityDeclarationHash`. |
| `packages/plugin-manifest/src/schema.ts` (modify) | Build the permission/capability enum from the registry; split `clipboard:watch`; activation rule. |
| `src/main/plugins/grant-store.ts` (new) | Composite-identity grant persistence + invalidation. |
| `src/main/plugins/capability-gate.ts` (new) | Sync `assertDeclared` + async `ensure(request)`; `CapabilityDenied`. |
| `src/main/plugins/capability-audit.ts` (new) | Redacted audit records → dedicated `audit.log` sink. |
| `src/main/plugins/plugin-bridge.ts` (modify) | Capability APIs call `await ensure({...context})`; `clipboard.watch` uses `clipboard:watch`. |
| `src/main/plugins/grant-migration.ts` (new) | Grandfather installed plugins' declared permissions into grants. |
| `src/main/plugins/plugin-host.ts` (modify) | Own the gate/store/audit; `revokeCapability` teardown; grant-prompt routing. |
| `src/main/ipc/capabilities.ts` (new) | IPC: list a plugin's capabilities + grant state, revoke, grant-prompt resolve. |
| `src/main/index.ts` + renderer Plugins page (modify) | Assemble; minimal capability list + revoke UI + JIT prompt. |

---

## Task 1: Capability registry + tiers + declaration hash

**Files:** Create `packages/plugin-manifest/src/capabilities.ts`, Test `packages/plugin-manifest/src/capabilities.test.ts`

- [ ] Write failing tests: registry contains the 8 capabilities with expected tiers; `clipboard:watch` is `elevated` and distinct from `clipboard:read`; `capture-screen` is `elevated`; `storage:plugin`/`notification` are `auto`; `getCapability("nope")` is `undefined`; `capabilityIds()` returns all ids; `capabilityDeclarationHash` is order-independent and changes when the set changes; every descriptor has `scopeEnforced: false` (no scoped capability ships enforced yet).
- [ ] Implement:

```ts
import { createHash } from "node:crypto"
import type { JsonSchema } from "./types"

export type CapabilityTier = "auto" | "consent" | "elevated"

export interface CapabilityDescriptor {
  id: string
  tier: CapabilityTier
  /** Reserved; only honored when scopeEnforced is true (none yet). */
  scopeSchema?: JsonSchema
  scopeEnforced: boolean
}

const ALL: CapabilityDescriptor[] = [
  { id: "storage:plugin", tier: "auto", scopeEnforced: false },
  { id: "notification", tier: "auto", scopeEnforced: false },
  { id: "clipboard:read", tier: "consent", scopeEnforced: false },
  { id: "clipboard:write", tier: "consent", scopeEnforced: false },
  { id: "clipboard:watch", tier: "elevated", scopeEnforced: false },
  { id: "system:open-url", tier: "consent", scopeEnforced: false },
  { id: "system:open-path", tier: "consent", scopeEnforced: false },
  { id: "system:capture-screen", tier: "elevated", scopeEnforced: false },
]

export const CAPABILITIES: ReadonlyMap<string, CapabilityDescriptor> = new Map(
  ALL.map((cap) => [cap.id, cap])
)

export function getCapability(id: string): CapabilityDescriptor | undefined {
  return CAPABILITIES.get(id)
}

export function capabilityIds(): string[] {
  return [...CAPABILITIES.keys()]
}

/** Stable hash over the declared-capability set; identity-invalidates grants. */
export function capabilityDeclarationHash(declared: readonly string[]): string {
  const normalized = [...new Set(declared)].sort().join("\n")
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}
```

- [ ] Run `pnpm test packages/plugin-manifest/src/capabilities.test.ts` → PASS. Commit `feat(manifest): add capability registry, tiers, and declaration hash`.

> Note: re-export `capabilities` from `packages/plugin-manifest/src/index.ts` so `@synapse/plugin-manifest` consumers see it. `JsonSchema` already exists in `packages/plugin-manifest/src/types.ts`.

## Task 2: Manifest schema — capability validation + `clipboard:watch` split

**Files:** Modify `packages/plugin-manifest/src/schema.ts`, Test `packages/plugin-manifest/src/index.test.ts` (existing)

Current state: `schema.ts:23` is `const permissionSchema = z.enum([...])`; line ~134 enforces `clipboard:change` activation requires `clipboard:read`.

- [ ] Write failing tests (add to `index.test.ts`): a manifest declaring `clipboard:watch` validates; a `clipboard:change` activation now requires `clipboard:watch` (not `clipboard:read`) — declaring only `clipboard:read` with a `clipboard:change` activation is rejected; the existing tool ⊆ plugin subset rule still holds; an unknown permission (`network:http`) is still rejected.
- [ ] Implement: build the enum from the registry instead of a hard-coded list, and update the activation rule.

```ts
import { capabilityIds } from "./capabilities"
const ids = capabilityIds() as [string, ...string[]]
const permissionSchema = z.enum(ids)
// activation refinement:
if (value.activationEvents?.includes("clipboard:change") &&
    !value.permissions.includes("clipboard:watch")) {
  ctx.addIssue({ code: z.ZodIssueCode.custom,
    message: "clipboard:change activation requires clipboard:watch permission",
    path: ["permissions"] })
}
```

- [ ] Run `pnpm test packages/plugin-manifest/` + `pnpm -F @synapse/plugin-manifest build` (regenerates the JSON schema from zod). → PASS. Commit `feat(manifest): validate capabilities from the registry and split clipboard:watch`.

> The scaffold/template manifest and any builtin plugin that used `clipboard:read` for watching must add `clipboard:watch`; grep `clipboard:change` under `packages/` and fix templates in this task.

## Task 3: Grant store (composite identity + invalidation)

**Files:** Create `src/main/plugins/grant-store.ts`, Test `src/main/plugins/grant-store.test.ts`

- [ ] Write failing tests (temp file): `grant` then `isGranted` true; `revoke` then `isGranted` false; persistence across a fresh `GrantStore` on the same file; `list(pluginId)` returns granted capabilities; **invalidation** — a grant stored under one identity is `isGranted === false` when queried with a different `capabilityDeclarationHash`, `publisherId`, or `signingKeyFingerprint`; `grantedBy` recorded.
- [ ] Implement:

```ts
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

export interface GrantIdentity {
  pluginId: string
  publisherId: string            // "unsigned" until signing lands
  signingKeyFingerprint: string  // "local:<sourceKind>" until signing lands
  capabilityDeclarationHash: string
}

export interface GrantRecord {
  capability: string
  grantedAt: number
  grantedBy: "install" | "user"
  scope?: unknown                 // reserved; never trusted as a restriction
  identity: GrantIdentity
}

export function grantStoreFilePath(userDataDir: string): string {
  return path.join(userDataDir, "plugins", "capability-grants.json")
}

function sameIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return a.pluginId === b.pluginId && a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint &&
    a.capabilityDeclarationHash === b.capabilityDeclarationHash
}

export class GrantStore {
  private records: GrantRecord[] | null = null
  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {}

  async isGranted(identity: GrantIdentity, capability: string): Promise<boolean> {
    return (await this.load()).some(
      (r) => r.capability === capability && sameIdentity(r.identity, identity)
    )
  }
  async grant(identity: GrantIdentity, capability: string, grantedBy: GrantRecord["grantedBy"], scope?: unknown): Promise<void> {
    const records = (await this.load()).filter(
      (r) => !(r.capability === capability && r.identity.pluginId === identity.pluginId)
    )
    records.push({ capability, grantedAt: this.now(), grantedBy, scope, identity })
    await this.persist(records)
  }
  async revoke(pluginId: string, capability: string): Promise<void> {
    const records = (await this.load()).filter(
      (r) => !(r.capability === capability && r.identity.pluginId === pluginId)
    )
    await this.persist(records)
  }
  async list(pluginId: string): Promise<GrantRecord[]> {
    return (await this.load()).filter((r) => r.identity.pluginId === pluginId)
  }
  private async load(): Promise<GrantRecord[]> {
    if (!this.records) {
      const raw = await readJsonFile(this.filePath)
      this.records = Array.isArray(raw) ? (raw as GrantRecord[]) : []
    }
    return this.records
  }
  private async persist(records: GrantRecord[]): Promise<void> {
    this.records = records
    await writeJsonFile(this.filePath, records)
  }
}
```

- [ ] Run `pnpm test src/main/plugins/grant-store.test.ts` → PASS. Commit `feat(plugins): add capability grant store with composite-identity invalidation`.

## Task 4: Capability gate — sync declaration + async context-bearing `ensure`

**Files:** Create `src/main/plugins/capability-gate.ts`, Test `src/main/plugins/capability-gate.test.ts`

This is the heart. Inject the grant store, a grant prompt port, and a per-call approver port (so the decision is testable without UI).

- [ ] Write failing tests (fakes for store/prompt/approver):
  1. undeclared capability → `ensure` rejects with `CapabilityDenied`.
  2. `auto` tier → resolves without prompt or approver.
  3. granted `consent` → resolves; no prompt.
  4. ungranted `consent` → calls the prompt; prompt true → persists grant + resolves; prompt false → rejects.
  5. ungranted `elevated` → prompt true → persists; then because actor `agent` → also calls approver.
  6. granted `elevated` + actor `agent` → **still calls approver** (grant not sufficient); approver false → rejects.
  7. granted `elevated` + actor `user` → resolves without approver.
  8. `assertDeclared` (sync) throws for an undeclared capability.
- [ ] Implement:

```ts
import type { GrantIdentity, GrantStore } from "./grant-store"
import { getCapability } from "@synapse/plugin-manifest"

export type CapabilityActor = "user" | "agent" | "background"

export interface CapabilityRequest {
  capability: string
  actor: CapabilityActor
  trigger: string
  operation: string
  requestedScope?: unknown
  reason?: string
}

export class CapabilityDenied extends Error {
  constructor(readonly pluginId: string, readonly capability: string, readonly why: string) {
    super(`Capability denied for ${pluginId}: ${capability} (${why})`)
    this.name = "CapabilityDenied"
  }
}

export interface GrantPromptPort { (req: { identity: GrantIdentity; request: CapabilityRequest; tier: string }): Promise<boolean> }
export interface CapabilityApprover { (req: { identity: GrantIdentity; request: CapabilityRequest }): Promise<boolean> }

export interface CapabilityGateOptions {
  identity: GrantIdentity
  declared: ReadonlySet<string>
  grants: GrantStore
  prompt: GrantPromptPort
  approve: CapabilityApprover
  audit: (entry: CapabilityAuditEntry) => void
}

export interface CapabilityAuditEntry {
  pluginId: string; capability: string; tier: string
  actor: CapabilityActor; trigger: string; operation: string
  requestedScope?: unknown; reason?: string
  decision: "allow" | "deny"; grantedNow: boolean; why: string
}

export class CapabilityGate {
  constructor(private readonly o: CapabilityGateOptions) {}

  /** Synchronous load/manifest-time check; defense-in-depth at runtime too. */
  assertDeclared(capability: string): void {
    if (!this.o.declared.has(capability)) {
      throw new CapabilityDenied(this.o.identity.pluginId, capability, "not declared")
    }
  }

  async ensure(request: CapabilityRequest): Promise<void> {
    const cap = getCapability(request.capability)
    const deny = (why: string, grantedNow = false): never => {
      this.emit(request, "deny", grantedNow, why, cap?.tier)
      throw new CapabilityDenied(this.o.identity.pluginId, request.capability, why)
    }
    if (!cap || !this.o.declared.has(request.capability)) return deny("not declared")

    let grantedNow = false
    if (cap.tier !== "auto") {
      const granted = await this.o.grants.isGranted(this.o.identity, request.capability)
      if (!granted) {
        const ok = await this.o.prompt({ identity: this.o.identity, request, tier: cap.tier })
        if (!ok) return deny("grant refused")
        await this.o.grants.grant(this.o.identity, request.capability, "user", request.requestedScope)
        grantedNow = true
      }
    }
    // A standing grant is necessary, not sufficient: elevated + agent/background re-approves per call.
    if (cap.tier === "elevated" && (request.actor === "agent" || request.actor === "background")) {
      const ok = await this.o.approve({ identity: this.o.identity, request })
      if (!ok) return deny("per-call approval refused", grantedNow)
    }
    this.emit(request, "allow", grantedNow, "permitted", cap.tier)
  }

  private emit(request: CapabilityRequest, decision: "allow" | "deny", grantedNow: boolean, why: string, tier = "unknown"): void {
    this.o.audit({
      pluginId: this.o.identity.pluginId, capability: request.capability, tier,
      actor: request.actor, trigger: request.trigger, operation: request.operation,
      requestedScope: request.requestedScope, reason: request.reason, decision, grantedNow, why,
    })
  }
}
```

- [ ] Run `pnpm test src/main/plugins/capability-gate.test.ts` → PASS. Commit `feat(plugins): add capability gate with context-bearing async ensure`.

## Task 5: Capability audit (redacted, dedicated sink)

**Files:** Create `src/main/plugins/capability-audit.ts`, Test `src/main/plugins/capability-audit.test.ts`

- [ ] Write failing tests (inject a memory `LogSink`): an audit entry is written as one JSON line carrying `capability/decision/actor`; secret-looking fields in `operation`/`requestedScope` are redacted (reuse `redactFields`); payload-ish keys never appear verbatim.
- [ ] Implement: a `createCapabilityAudit(sink)` returning `(entry: CapabilityAuditEntry) => void` that builds a `Logger` with the injected sink and writes `logger.child("capability").info("decision", { ...entry })` (the logger already redacts). For production, the sink is a `createFileSink(path.join(userDataDir, "logs"), { ... })` pointed at `audit.log` — add an optional `fileName` to `createFileSink` (default `main.log`) in this task and a test for it.
- [ ] Run `pnpm test src/main/plugins/capability-audit.test.ts src/main/logging/file-sink.test.ts` → PASS. Commit `feat(plugins): add redacted capability audit on a dedicated sink`.

## Task 6: Wire `ensure` into the plugin bridge

**Files:** Modify `src/main/plugins/plugin-bridge.ts`, Test `src/main/plugins/plugin-bridge.test.ts`

Today `createCapabilities` uses a synchronous `gate.check(permission)` before each adapter call (e.g. `clipboard.read` checks `clipboard:read`). Replace with `await gate.ensure({...})` carrying context, and route `clipboard.watch` through `clipboard:watch`.

- [ ] Write failing tests: `clipboard.readText()` invokes `ensure` with `{ capability: "clipboard:read", actor: "user", operation: "read" }` and proceeds when allowed / rejects with `CapabilityDenied` when denied; `clipboard.watch` invokes `ensure` with `clipboard:watch`; a denied capability does not call the adapter. (Inject a fake gate.)
- [ ] Implement: thread a `CapabilityGate` (per plugin) into `PluginBridge.createContext`; each capability wrapper calls `await this.gate.ensure({ capability, actor, trigger, operation, reason })`. `actor` comes from the invocation caller (user command → `user`; tool call by agent → `agent`; clipboard watcher tick → `background`). Map the existing `ToolCaller`/invocation to `actor`.
- [ ] Run `pnpm test src/main/plugins/plugin-bridge.test.ts` → PASS. Commit `feat(plugins): gate capability APIs through context-bearing ensure`.

> The bridge currently builds a `PermissionGate`. This task replaces that per-plugin gate construction with `CapabilityGate` built from the plugin's declared set + the shared grant store/prompt/approver/audit (passed into `PluginBridge`).

## Task 7: Revoke teardown

**Files:** Modify `src/main/plugins/plugin-host.ts` (+ `plugin-registry.ts`/`plugin-sandbox.ts` as needed), Test `src/main/plugins/plugin-host.test.ts`

- [ ] Write failing tests: `host.revokeCapability(pluginId, "clipboard:watch")` removes the grant **and** stops the plugin's clipboard watcher (assert the registry's watcher set no longer includes the plugin / `hasClipboardChangeListeners()` reflects it); revoking a capability cancels the plugin's tracked timers for background work (assert the sandbox cleared them).
- [ ] Implement `revokeCapability(pluginId, capability)` on `PluginHost`: `await grants.revoke(pluginId, capability)`, then drive teardown — for `clipboard:watch` stop the watcher via the existing registry/bridge watcher registry; for any capability, signal the sandbox to abort in-flight ops and clear timers associated with that plugin (reuse the sandbox's existing per-plugin `timers`/`intervals` sets; add an `abortPluginCapability(pluginId, capability)` hook).
- [ ] Run `pnpm test src/main/plugins/plugin-host.test.ts` → PASS. Commit `feat(plugins): tear down watchers and background work on capability revoke`.

## Task 8: Grandfather migration

**Files:** Create `src/main/plugins/grant-migration.ts`, Test `src/main/plugins/grant-migration.test.ts`

- [ ] Write failing tests: given installed plugins with declared permissions and an empty grant store, `migrateGrants` writes a grant per declared capability under the plugin's current identity with `grantedBy: "install"`; a plugin that declared the old `clipboard:read` for watching gets `clipboard:watch` granted too (per spec §9); migration is idempotent (re-running adds nothing); already-granted capabilities are left intact.
- [ ] Implement `migrateGrants(plugins, grants)`: for each active plugin, compute its `GrantIdentity` (`capabilityDeclarationHash(declared)`, sentinel publisher/fingerprint by source kind), and grant each declared capability if not already granted; apply the `clipboard:read → +clipboard:watch` rule only for plugins whose manifest had a `clipboard:change` activation.
- [ ] Run `pnpm test src/main/plugins/grant-migration.test.ts` → PASS. Commit `feat(plugins): grandfather installed plugins' permissions into capability grants`.

## Task 9: IPC — list capabilities, revoke, resolve grant prompt

**Files:** Create `src/main/ipc/capabilities.ts`, Test `src/main/ipc/capabilities.test.ts`

- [ ] Write failing tests: `listPluginCapabilities(pluginId)` returns each declared capability with `{ id, tier, granted, scopeEnforced }` (granted from the store under the current identity); `revoke(pluginId, capability)` calls `host.revokeCapability`; `resolveGrantPrompt(promptId, allow)` resolves a pending prompt; untrusted senders are rejected via the existing `isTrustedSender` guard (mirror `ipc/plugins.ts`).
- [ ] Implement `registerCapabilitiesIpc(ipcMain, service, { isTrustedSender })` with channels `capabilities:list`, `capabilities:revoke`, `capabilities:grant-resolve`. The JIT grant prompt is pushed to the renderer via a broadcast event `capabilities:grant-request` (carrying `{ promptId, pluginId, capability, tier, trigger, operation, reason }`), and the renderer answers via `capabilities:grant-resolve` — exactly mirroring the AI `approval_request`/`approve` round-trip in `agent-service.ts`.
- [ ] Run `pnpm test src/main/ipc/capabilities.test.ts` → PASS. Commit `feat(plugins): add capability IPC (list, revoke, grant prompt round-trip)`.

## Task 10: Assembly + minimal UI

**Files:** Modify `src/main/index.ts`, `src/main/plugins/plugin-host.ts`; renderer `src/renderer/src/components/pages/plugins-page.tsx` (+ `lib/electron.ts`, preload). Test: `plugins-page` test + preload typing.

- [ ] Wire in `index.ts`: construct `GrantStore(grantStoreFilePath(userData))`, the capability audit sink (`createFileSink(.../logs, { fileName: "audit.log" })`), the grant-prompt port (broadcast `capabilities:grant-request` and await `capabilities:grant-resolve`), and the per-call approver (reuse the AI `ApprovalGate` decision shape). Pass these into `PluginHost`. Run `migrateGrants` after `plugins.init()`.
- [ ] Renderer: in the Plugins page, add a per-plugin "Permissions" section listing capabilities with tier badge + granted state + a **Revoke** button (calls `capabilities:revoke`); render the JIT grant request as a dialog (allow/deny) wired to `capabilities:grant-resolve`. Reuse existing shadcn `dialog`/`badge`/`button`. Add a `data-testid="capability-row"` for the e2e/unit hook.
- [ ] Write a renderer test: the permissions section lists a plugin's capabilities and the Revoke button calls the wrapper. Run `pnpm test src/renderer/src/components/pages/plugins-page.test.tsx` → PASS.
- [ ] Run the full gate: `pnpm test` + `pnpm lint` + `pnpm typecheck` → green. Commit `feat(plugins): assemble capability governance and add the management UI`.

---

## Self-review

**Spec coverage:** three gates (T4 ensure + T2 declaration + T4 approver) · tiers/registry (T1) · clipboard:watch split (T1/T2) · context-bearing ensure with actor/trigger/operation/scope/reason (T4) · composite-identity grant key + invalidation (T3) · elevated≠silent for agent/background (T4 tests 5–7) · scope honesty (`scopeEnforced:false` everywhere in T1; UI shows no "limited" — T10) · redacted audit on dedicated sink (T5) · revoke teardown (T7) · grandfather migration (T8) · minimal UI + IPC (T9/T10). All spec sections map to a task.

**Placeholder scan:** no TBD/“handle edge cases”; each core task carries real code + real assertions. Integration tasks (T6/T7/T9/T10) specify exact signatures, channels, and test assertions.

**Type consistency:** `CapabilityRequest`, `GrantIdentity`, `GrantRecord`, `CapabilityDescriptor`, `CapabilityTier`, `CapabilityDenied`, `CapabilityGate.ensure/assertDeclared`, `GrantStore.isGranted/grant/revoke/list`, `capabilityDeclarationHash`, `getCapability`, `createFileSink({ fileName })` are used consistently across tasks.

**Sequencing:** T1→T2 (registry before schema), T3→T4 (store before gate), T4→T5 (gate emits audit entries), T6 depends on T4/T3/T5, T7 on T6, T8 on T3, T9/T10 assemble. Each task is independently committable and testable.
