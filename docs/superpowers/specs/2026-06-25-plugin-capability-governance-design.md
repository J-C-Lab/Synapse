# Plugin Capability Governance — Foundation Design

> Date: 2026-06-25 · Status: approved (with reinforcements), pending implementation plan
> First slice of the "plugins as restricted, grantable, revocable, auditable
> Capability containers" direction. This spec builds the **governance container**
> only — concrete high-risk capabilities (network, fs, credentials, schedule,
> native) are each their own later spec.

## Guiding principle

**A grant is not a one-time pass. It is a context-bearing capability-call
decision.**

Every capability invocation is decided with full context — *who* triggered it
(actor), *what* triggered it (trigger), *which* concrete operation and scope it
needs, and *why*. A persisted grant only lowers friction for the safe cases
(low-risk capabilities, user-initiated foreground actions). It NEVER removes the
decision point for high-risk capabilities driven by the agent or by background
activity. If this principle is not upheld, plugins are just permission bits, not
a safe Capability container — and the whole ecosystem's safety story collapses.

## Goal (this foundation spec)

A capability-agnostic governance core: a tiered capability taxonomy with hard
red lines, a context-bound grant store, a two-phase enforcement path (sync
declaration validation at load + async context-bearing `ensure()` at runtime),
per-call approval for high-risk/agent/background calls, redacted audit, and
revocation that tears down in-flight use.

## Non-goals (each its own later spec)

- Concrete high-risk capabilities: scoped `network`, scoped `fs`, credential
  vault, `schedule`/event sources, native bridges.
- Real scope **enforcement** (the model reserves scope; adapters enforce it
  per-capability — see §"Scope honesty").
- Full grant-management UI polish (foundation ships a minimal list + revoke).
- Deepened agent per-call approval UX (foundation defines the seam + reuses the
  existing `ApprovalGate`).

---

## 1. Core model — the three gates

A capability call is permitted **iff all three hold**:

1. **Declaration** (static, synchronous, load-time): the plugin's manifest
   declares the capability, and any tool-level capability is a subset of the
   plugin's. Validated when the manifest is parsed and when the plugin loads —
   this is the existing `PermissionGate`-style check, kept synchronous.
2. **Grant** (persisted, context-bound): the user has granted the capability to
   *this specific* plugin identity (see §4 for the composite key), and the grant
   is still valid.
3. **Per-call decision** (runtime, async, context-bearing): `ensure(request)`
   evaluates the call's context. For `elevated` capabilities driven by `agent`
   or `background` actors, this ALWAYS routes through the per-call `ApprovalGate`
   regardless of a standing grant.

Every gate evaluation emits a redacted audit record.

## 2. Capability taxonomy and tiers

A capability is `{ id, tier, scopeSchema?, scopeEnforced }`, defined in one
registry (`packages/plugin-manifest`). Tiers:

| Tier | Granted | Notes |
| --- | --- | --- |
| `auto` | At install, automatically | Low-risk, high-frequency |
| `consent` | JIT prompt on first use; persisted once granted | Medium-risk |
| `elevated` | JIT prompt on first use **and** per-call approval when actor is agent/background | High-risk |
| *(forbidden)* | Not representable — absent from the registry | Red lines (§7) |

### Current permissions mapped (with `clipboard:watch` split out)

| Capability | Tier |
| --- | --- |
| `storage:plugin` | `auto` |
| `notification` | `auto` |
| `clipboard:read` | `consent` |
| `clipboard:write` | `consent` |
| `clipboard:watch` (**new, split from read/write**) | `elevated` — continuous background surveillance of all clipboard activity |
| `system:open-url` | `consent` |
| `system:open-path` | `consent` |
| `system:capture-screen` | `elevated` |

`clipboard.watch` previously rode on `clipboard:read`. It becomes its own
capability so a plugin that only reads on demand cannot silently monitor
everything the user copies.

## 3. `ensure()` — the context-bearing decision

```ts
interface CapabilityRequest {
  capability: string
  actor: "user" | "agent" | "background" // background = watcher / schedule / OS event
  trigger: string      // e.g. "command:hello.world" | "tool:greet" | "clipboard:change"
  operation: string    // concrete op, e.g. "read" | "POST api.github.com/repos" | "write ~/Documents/x"
  requestedScope?: unknown // the scope THIS call needs; matched against the capability's scopeSchema
  reason?: string      // human-readable justification — shown in the prompt and audited
}

// Resolves if permitted; throws CapabilityDenied otherwise.
ensure(request: CapabilityRequest): Promise<void>
```

Decision flow:

1. Re-assert declaration (defense in depth against a tampered/desynced load) →
   if undeclared, **deny**.
2. Resolve tier from the registry.
3. `auto` → allow (install-granted).
4. Grant missing/invalid for the composite identity (§4):
   - `consent` → request a user JIT grant (async). Granted → persist + continue;
     denied → **deny**.
   - `elevated` → request a user JIT grant, prominently flagged high-risk.
     Granted → persist + continue; denied → **deny**.
5. Grant present (or just granted) → per-call decision:
   - `elevated` **and** actor ∈ {`agent`, `background`} → route through the
     `ApprovalGate` for a per-call decision. Denied → **deny**. (The standing
     grant is necessary, not sufficient.)
   - otherwise (`consent`, or actor `user`) → allow.
6. Audit the outcome with full, redacted context (§6).

The capability APIs in the SDK bridge are already `async`, so they change from a
synchronous `gate.check(cap)` to `await gate.ensure(request)` — true lazy JIT:
the prompt fires only when the capability is actually exercised. The synchronous
declaration check (gate 1) is retained at load time and as the step-1 assertion.

## 4. Grant identity — context-bound key

A grant is **not** keyed by `pluginId` alone. The key is a composite identity:

```
pluginId · publisherId · signingKeyFingerprint · capabilityDeclarationHash
```

- `capabilityDeclarationHash` = hash over the plugin's sorted declared-capability
  set. If an update adds/changes declared capabilities, prior grants are invalid
  → the user must re-grant. A malicious update cannot inherit trust granted to a
  narrower predecessor.
- `publisherId` / `signingKeyFingerprint` come from the signed package. If the
  publisher changes or the signing key rotates, prior grants are invalid.

**Invalidation:** on load, compute the current identity tuple; if it differs from
the tuple stored with a grant, treat the capability as **not granted**.

**Dependency / known limitation:** `publisherId` + `signingKeyFingerprint`
require the plugin-signing infrastructure
(`docs/superpowers/specs/2026-06-10-plugin-signing-verification-design.md`).
Until signing lands, unsigned/local plugins use sentinels
(`publisherId = "unsigned"`, `signingKeyFingerprint = "local:<sourceKind>"`), and
invalidation still works on `pluginId` + `capabilityDeclarationHash`. The grant
store records which identity components were available, so grants made under
sentinels can be force-invalidated once real signing exists.

## 5. Revocation — tear down in-flight use

`revoke(identity, capability)` is not a flag flip:

1. Remove the grant record.
2. **Tear down any in-flight use bound to that capability:**
   - `clipboard:watch` → stop the plugin's clipboard watcher (the host already
     tracks watchers).
   - background/scheduled tasks using the capability → cancel (the sandbox
     already tracks timers/intervals; abort via their `AbortSignal`).
   - in-flight `elevated` operations → abort via their `AbortSignal`.

The host exposes `revokeCapability(identity, capability)` that updates the grant
store **and** drives the teardown through the registry/sandbox. The teardown
interface is defined here; concrete per-capability teardown ships with each
capability, but watcher + timer teardown (which exist today) are handled in this
foundation.

## 6. Audit

Every gate evaluation and every `elevated` invocation emits a record via
`logger.child("capability")` to a dedicated `userData/logs/audit.log` sink
(separate retention from general logs). Records run through `redact.ts`.

Fields: `ts, pluginId, identity (short fingerprint), capability, tier, actor,
trigger, operation, requestedScope, decision, grantedNow?, reason`.

**The audit logs metadata, never payloads.** `operation`/`requestedScope` are
redacted; clipboard contents, file contents, request bodies, and secrets are
never written.

## 7. Red lines (absent from the registry + sandbox-enforced)

Capabilities that must never exist or be grantable:

- Arbitrary shell / `child_process` / process spawn.
- Filesystem access outside an explicitly granted, adapter-enforced scope.
- Reading another plugin's storage / any cross-plugin access.
- Access to the agent's provider API keys or the user's other secrets.
- Sandbox escape / `require` of Node built-ins beyond the curated globals.
- Network without a granted, adapter-enforced `network` capability.

These are enforced twice: not present in the capability registry (cannot be
declared) and not reachable from the `node:vm` sandbox globals.

## 8. Scope honesty (no false "restricted" signal)

Scope is **reserved** in the model (`scopeSchema` on the descriptor, `scope` on
the grant) but only **honored** when an adapter actually enforces it. Each
capability carries `scopeEnforced: boolean`.

- A capability whose scope is meaningful but unenforced (`scopeEnforced: false`)
  is **not opened** — it is not exposed/grantable in this foundation.
- The grant prompt and the management UI **never** display "limited to X" unless
  `scopeEnforced` is true for that capability. No scoped-looking grant may imply
  a restriction the runtime does not enforce.

## 9. Migration / backward compatibility

Today, installing a plugin implicitly grants all its declared permissions. On
upgrade:

- **Grandfather existing installed plugins:** migrate their manifest-declared
  permissions into the grant store as granted, under the current identity tuple,
  so present behavior is preserved.
- **Exception:** `clipboard:watch` — because it splits out of `clipboard:read`,
  a plugin that watched under the old model is granted `clipboard:watch` during
  migration (no behavior change), but any *new* install/update must declare and
  be granted `clipboard:watch` explicitly.
- New installs and any capability-set change go through the tiered flow.

## 10. Components / files

| File | Responsibility |
| --- | --- |
| `packages/plugin-manifest/src/capabilities.ts` (new) | Capability registry: `{ id, tier, scopeSchema?, scopeEnforced }`. Single source mapping the current permissions + `clipboard:watch`. |
| `packages/plugin-manifest/src/schema.ts` (modify) | Validate declared capabilities against the registry; keep the tool ⊆ plugin subset rule. |
| `src/main/plugins/grant-store.ts` (new) | Persisted grants keyed by composite identity; `isGranted / grant / revoke / list`; scope reserved, not enforced. JSON via `atomic-json-store`. |
| `src/main/plugins/capability-gate.ts` (evolve `permissions.ts`) | Sync declaration check + `async ensure(request)`; consults registry + grant store + (for elevated/agent/background) the `ApprovalGate`. |
| `src/main/plugins/capability-audit.ts` (new) | Redacted audit records → dedicated `audit.log` sink built on the structured logger. |
| `src/main/plugins/plugin-bridge.ts` (modify) | Capability APIs call `await ensure({...context})` instead of `gate.check(cap)`; thread `actor/trigger/operation/reason`. |
| host + registry/sandbox (modify) | `revokeCapability` teardown of watchers/timers/in-flight ops. |
| IPC + Plugins-page section (new, minimal) | List a plugin's capabilities (tier, granted?, identity validity) + JIT grant prompt + **revoke** button. |

## 11. Testing (pure-logic, unit)

- **Grant store:** grant/revoke/persist/`isGranted`; identity-tuple invalidation
  (changed declaration hash / publisher / fingerprint ⇒ not granted).
- **`ensure()`** (inject a fake prompt + fake `ApprovalGate`): auto allows;
  granted allows; ungranted consent prompts → persists; ungranted elevated
  prompts → persists; elevated + agent/background always re-approves even when
  granted; denial throws `CapabilityDenied`; undeclared denies.
- **Audit:** every decision emits a redacted record; payload fields never appear.
- **Revoke teardown:** revoking `clipboard:watch` stops the watcher; revoking a
  capability cancels tracked timers/in-flight ops.
- **Migration:** existing declared permissions are grandfathered; `clipboard:watch`
  handled per §9.

## 12. Scope boundary (foundation vs later)

Foundation delivers: taxonomy + tiers + red lines, grant store (scope-reserved,
context-bound key), `CapabilityGate.ensure`, per-call approval seam for
elevated/agent/background, redacted audit, revoke teardown for existing
watcher/timer surfaces, grandfather migration, minimal grant list + revoke UI.

Later specs (each own): scoped `network`, scoped `fs`, credential vault,
`schedule`/event sources, native bridges (each ships its adapter-enforced scope
and concrete teardown), full grant-management UI, deeper agent approval UX, and
the signing dependency that upgrades the sentinel identity components.
