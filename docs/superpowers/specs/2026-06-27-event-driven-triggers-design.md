# Event-Driven Triggers + Background Capability Model Design

> Date: 2026-06-27
> Status: design approved in conversation (4 sections), revised after two
> external review rounds. Round 1 (host-minted invocation, three-level signal
> teardown, manifest-named handlers, sanitized event payloads). Round 2
> amendments applied: per-(trigger,capability,scope) budgets; manifest `uses`
> declarations; `triggerOrigin` held ONLY in a host-side invocation record
> (never enters the sandbox); explicit Trigger Admission vs Capability Budget
> breaker split; conservative timer floor; clipboard hash dropped; fs.watch
> root-relative paths; grant invalidation tied to the identity fingerprint.
> Ready for implementation plan.

## Context

Synapse's plugin capability governance is LIVE end-to-end (JIT prompts, per-call
approval, revoke UI, audit) and `scoped network` (`network:https`) is shipped and
audited as v1-complete. This spec opens the next direction: **giving plugins the
one class of capability an agent cannot replicate with shell + scripts —
long-lived, event-driven background reaction.**

An agent is request/response: it cannot keep a listener alive, react to an OS
event when no agent call is in flight, or run on a schedule. That persistence is
the differentiating value of a plugin. This spec defines the permission and
capability model for it.

## Goal

> Plugins can react to declared OS/time events in the background, but only
> through manifest-declared triggers whose every sensitive action remains
> scoped, granted, budgeted, rate-limited, audited, observable, and instantly
> killable.

## Non-goals

- Free-form runtime trigger registration. Triggers come ONLY from the manifest.
- Autonomous plugin background processes outside a runtime-created invocation.
- Per-call prompting for background actions (replaced by enable-time consent +
  hard budget/rate caps + observability + kill).
- Webhook / inbound HTTP triggers, system power/network-state events (deferred).
- User-editable narrowed trigger scopes (grant scope = declared scope, as in
  network v2).

## Scoped Network v1 — audit result (carried in as context)

`network:https` is **v1-complete and production-grade**; all 103 related tests
pass. The single chokepoint ([network-fetcher.ts](../../../src/main/plugins/network-fetcher.ts))
enforces, with no bypass: https-only + no-userinfo + default-port URL validation;
path normalization against encoded traversal; consent gate before any byte
leaves; `resolvePublicIps` validating every resolved address with the connection
pinned to the validated IP (SSRF / DNS-rebinding guard); request/response size
caps; hop-by-hop + cookie header stripping; same-origin-only bounded redirects;
revoke → `abortAll()` teardown; sanitized audit.

Non-blocking post-MVP polish (NOT security gaps), tracked as backlog:

1. No address failover — `pinnedAddress = addresses[0]` only; no retry on the
   next resolved public IP if the first connect fails.
2. No per-plugin rate/concurrency cap — consent covers "whether", not "how
   often". (Directly addressed by this spec's budget/rate-limit machinery.)
3. Buffered-only responses (25 MiB cap); no streaming, so large downloads are
   blocked.
4. Same-origin redirect only (intentional v1 policy, documented).

## Core architecture — the Trigger/Reactor spine

Generalize the existing hardcoded `onClipboardChange` dispatch
([plugin-sandbox.ts dispatchEvent](../../../src/main/plugins/plugin-sandbox.ts))
into a generic spine. Every trigger type shares one execution + governance
backbone; each source contributes only a thin **event adapter**.

```
[source adapters]        [Trigger Registry]      [Background Invoker]     [warm Sandbox]
 timer/cron   ┐                                   host-side: mints         handler(event, ctx)
 fs.watch     ├─ fire(event) ─► registry lookup ─► budget/rate breaker ─► invocation ──► declared
 clipboard    │                  (hard circuit)        (host-minted)       caps only; each
 global-hotkey┘                                                            sensitive action → gate
```

### Section 1 — non-negotiable boundaries

1. **The manifest is the sole source of trigger declarations.** Runtime reads
   the manifest at plugin **enable** time and registers triggers.
2. Firing creates a **background invocation**, which dispatches to the
   corresponding **exported handler** in the warm sandbox.
3. **Plugin code cannot add triggers at runtime.** `ctx` exposes NO
   `triggers.on/register`. `activate`/`deactivate` are for state
   init/cleanup only — no registration power. A bare `setInterval` attempting to
   masquerade as a trigger is contained by the sandbox's existing timer tracking.

Trigger declarations are normalized and reviewed through the same path as
capability declarations (`normalizeCapabilities`); the trigger surface and the
permission surface are one.

**Declaration form (chosen: declarative manifest, not imperative `activate`):**
declarative keeps the full trigger set visible and auditable at install/review
time, structurally identical to capability declarations, and prevents runtime
listener smuggling.

### Section 2 — permission model

**Trust front-loaded to a single enable-time consent.** Enabling a plugin
presents, as one unit, `{ triggers, the capabilities each trigger calls, each
trigger's budget }`. Reuses the existing `normalizeCapabilities` declaration /
review chain.

**Background actions do NOT prompt per-call.** This changes one existing
behavior: today [capability-gate.ts](../../../src/main/plugins/capability-gate.ts)
re-approves `elevated + background` per call via `approve()`. Under the new
model a **trigger-originated** background invocation carries a host-private
`triggerOrigin` marker; for those calls the gate replaces per-call `approve()`
with a **budget/rate circuit-breaker check**.

**Two distinct breakers at two distinct stages** (must NOT be collapsed into
one layer):

**(a) Trigger Admission Breaker** — decides whether an incoming event may create
a background invocation at all. Owns: trigger fire-frequency, event-storm
coalescing / drop, per-trigger pause, fault state, max concurrency. Runs at the
`fire(event)` stage, before the host mints any invocation.

**(b) Capability Budget Breaker** — decides whether the woken handler may call a
given sensitive capability. Runs inside the capability gate, per call.

Example: an `fs.watch` emitting 1000 changes/sec is coalesced/dropped by the
Admission Breaker before any handler wakes; once a handler does wake and tries
to read a file or hit the network, the Capability Budget Breaker debits the
`fs:read` / `network:https` budget.

Capability-gate evaluation for a trigger-origin call:

| Gate | Semantics | On trip |
| --- | --- | --- |
| Scope check | `adapter.contains(declared, requested)` (unchanged) | deny + audit |
| Standing grant | granted at enable time | — |
| Capability budget | tracked per **(pluginId, triggerId, capabilityId, normalizedScope, period)** tuple — NOT a single pooled per-trigger total | drop + audit + panel red |
| Cancel signal | revoke / kill / disable → abort in-flight | reuse network `abortAll` |

**Budget granularity (amendment 1):** budget is per
`(pluginId, triggerId, capabilityId, normalizedScope, period)`. A trigger-level
outer cap MAY exist, but it must NOT replace capability-level budgets — otherwise
a budget intended for `notification:show` could be drained by `network:https` or
`agent:invoke`. Each sensitive capability under a trigger has its own allowance.

**Invariant:** both breakers are a **hard circuit-breaker, not a consent
mechanism** — exhaustion drops silently and surfaces in the panel; it never
prompts. Consent happens only at enable time. The existing agent-driven
`elevated` path is unchanged (no `triggerOrigin` → still per-call `approve()`),
so security there is not weakened.

**Per-trigger scope shapes (v1 four types):**

- **timer/cron** — `{ schedule: "*/5 * * * *" | { intervalMs } }`. Conservative
  minimum-interval floor (amendment 5): signed/stable plugins `intervalMs ≥
  60000` and cron granularity ≥ 1 minute; dev/unsigned local plugins may relax
  to ≥5s behind an explicit dev-mode flag. The floor is enforced at registration
  (reject below floor), not just defaulted.
- **fs.watch** — `{ paths: ["~/Documents/**"], events: ["create","modify"] }`,
  path normalization reusing the network-scope approach (`..` / encoding
  folding), with system/sensitive directories denied (allowlist roots +
  denylist).
- **clipboard** — `{ contentTypes?: ["text"] }`, lifting the existing
  `clipboard:watch` into this model. Safe event exposes NO content hash
  (amendment 6): a plain hash of short clipboard content — password, OTP, email,
  URL — is dictionary-attackable. Any change-dedup is done host-internally with a
  runtime-private, short-lived keyed fingerprint never handed to the plugin.
- **global-hotkey** — `{ accelerator: "CmdOrCtrl+Shift+K" }`, conflict detection
  at registration time (reject already-bound / system-reserved combos) to
  prevent hotkey hijacking.

**Standing grant invalidation (amendment 8).** An enable-time background grant
is NOT permanent. It is invalidated — forcing re-consent at next enable — when
any of these change:

- plugin disabled or uninstalled;
- trigger paused / revoked / killed;
- manifest changes; trigger `scope` changes; trigger `uses` / capability budget
  changes;
- plugin package hash / signature changes; publisher identity changes.

This reuses the existing
[identity fingerprint](../../../src/main/plugins/capability-gate.ts) (already
hashes `pluginId` + `publisherId` + `signingKeyFingerprint` +
`capabilityDeclarationHash`): fold the trigger declarations into that hash (or a
parallel `triggerDeclarationHash`) so any trigger/scope/budget/identity change
yields a new fingerprint and the old grant no longer matches. Prevents an
upgrade that widens scope from inheriting the prior authorization.

### Section 3 — lifecycle & dispatch (revised)

The existing dispatch is already the right shape (builds a background context
with `actor:"background"` + trigger + abort signal, runs the hook under a
timeout). Four revisions harden it:

**R1 — the background invocation lives ONLY in a host-side record; the sandbox
never receives the invocation object or `triggerOrigin` (amendment 3).**
Security-critical: `triggerOrigin` is the switch that disables per-call
prompting (Section 2). Passing the whole `invocation` (even with a
non-enumerable `triggerOrigin`) into the sandbox risks misuse or future
serialization leakage. So `triggerOrigin` is NOT a JS field anywhere the plugin
can reach.

```
fire(event) → registry lookup + Trigger Admission Breaker (§2)
            → Background Invoker (host) mints a record keyed by invocationId:
                { actor: "background", triggerOrigin (runtime-private),
                  pluginId, triggerId, grant context, audit context,
                  per-trigger signal, single-shot timeout }
                stored in a host-side Map<invocationId, InvocationRecord>
            → host builds a sanitized ctx facade whose capability methods
              CLOSE OVER invocationId (the plugin never reads it)
            → sandbox.dispatchTrigger(ctxFacade, event)   // executes manifest-named export only
```

When the handler calls a capability, the ctx facade carries `invocationId` back
to the host; the gate looks up the host-side `InvocationRecord` by `invocationId`
and trusts ONLY that record for `triggerOrigin` / grant / audit context. The
sandbox cannot see, build, or forge `triggerOrigin`; an unknown or expired
`invocationId` fails closed.

**R2 — three-level signal hierarchy for precise teardown.** Plugin-level
`capabilityAbort` alone cannot revoke a single trigger without killing unrelated
background work. Chain controllers:

```
pluginAbortController            // disable / uninstall / kill whole plugin
   └─ triggerAbortController     // revoke / pause one trigger
        └─ invocationSignal + timeout   // one handler run
```

```ts
interface TriggerRuntime {
  pluginId: string
  triggerId: string
  controller: AbortController        // chained under pluginAbortController
  registrations: Disposable[]        // interval / fs watcher / hotkey unregister handles
  inflight: Set<BackgroundInvocation>
}
```

- `setEnabled(false)` → abort plugin controller + dispose all `TriggerRuntime`.
- `revoke(triggerId)` → abort that trigger controller + dispose only its adapter
  registration.
- single timeout → abort only that invocation.

This upgrades the current plugin-wide
[abortPluginCapability](../../../src/main/plugins/plugin-sandbox.ts) (whose
`capability` arg is reserved/no-op) to true trigger-level teardown — resolving
the "revoke `clipboard:watch` kills unrelated intervals" trade-off noted there.

**R3 — handler names come from the manifest; the SDK only provides the
`triggers` object convention.** Supports multiple triggers of the same type:

Each trigger MUST also declare `uses` — the capabilities it may call when woken,
each with its own scope and budget — plus `limits` (amendment 2). Without `uses`
the enable-time panel cannot show "what can this trigger do once woken," and the
per-capability budgets of amendment 1 have nowhere to live.

```jsonc
"triggers": [
  {
    "id": "watch-dls",
    "type": "fs.watch",
    "scope": { "paths": ["~/Downloads/**"], "events": ["create", "modify"] },
    "handler": "triggers.onDownloads",
    "uses": [
      { "capability": "fs:read",       "scope": { "paths": ["~/Downloads/**"] },          "budget": { "maxCalls": 20, "period": "1h" } },
      { "capability": "network:https", "scope": { "hosts": ["api.example.com"] },          "budget": { "maxCalls": 10, "period": "1h" } }
    ],
    "limits": { "minIntervalMs": 1000, "maxConcurrency": 1 }
  },
  {
    "id": "daily-summary",
    "type": "cron",
    "schedule": "0 9 * * *",
    "handler": "triggers.onDailySummary",
    "uses": [
      { "capability": "notification", "scope": {}, "budget": { "maxCalls": 1, "period": "1d" } }
    ],
    "limits": { "maxConcurrency": 1 }
  }
]
```

`uses[].scope` is matched by the same `adapter.contains` used for capability
declarations; `uses[].budget` is the per-`(trigger,capability,scope)` allowance
from amendment 1. A handler calling a capability not listed in its trigger's
`uses` is denied even if the plugin declares that capability elsewhere.

```ts
export const triggers = {
  async onSyncTick(event, ctx) {},
  async onDailySummary(event, ctx) {},
  async onDownloads(event, ctx) {},
}
```

Fixed names (`onTimer`/`onFsChange`/...) are rejected — they cannot express
same-type multiplicity.

**R4 — dispatch carries an adapter-normalized SAFE EVENT, never raw sensitive
content.** Consistent with Section 2 data minimization and the network audit
redaction discipline. To obtain full content the handler must call a gated
capability (separately audited).

| Trigger | Safe event payload | Full read → gate |
| --- | --- | --- |
| clipboard | `{ contentTypes, textLength, changedAt }` (no hash, amendment 6) | full text → `clipboard:read` |
| fs.watch | `{ rootId, relativePath, kind, timestamp, size?, ext? }` (root-relative, amendment 7) | absolute path / content → `fs:resolvePath` / `fs:read` |
| hotkey | `{ accelerator, pressedAt }` | — |
| timer | `{ scheduledAt, firedAt, driftMs }` | — |

> fs.watch path (amendment 7): the safe event carries `rootId` (which declared
> watch root) + `relativePath` within it — NOT an absolute path. A bare filename
> and directory structure are themselves sensitive (leak home dir / username).
> The plugin declared the root, so the relative path is the minimal disclosure;
> the absolute path is obtained only via a gated `fs:resolvePath` / `fs:read`.
> Audit and UI also read better: `Downloads/report.pdf`, not
> `/Users/xxx/Downloads/report.pdf`.

> Migration note (breaking): the current
> [dispatchEvent](../../../src/main/plugins/plugin-sandbox.ts) hands the full
> `ClipboardContent` to the handler. Under the new model clipboard events
> downgrade to metadata; full text requires `clipboard:read`. Intentional
> hardening, flagged breaking.

**Lifecycle hook map:**

| Phase | Mount point | Action |
| --- | --- | --- |
| Enable | `host.setEnabled(id, true)` | read manifest triggers → register 4 adapters (start interval/cron, fs watcher, clipboard poll, hotkey); enable-time consent gate first |
| Fire | adapter `fire(event)` | registry lookup → **Trigger Admission Breaker** → host mints invocation record (invocationId) → `sandbox.dispatchTrigger(ctxFacade, event)` |
| Execute | warm sandbox | run manifest-named export handler; each sensitive action → gate via invocationId → scope + grant + **Capability Budget Breaker** (no prompt) |
| Disable / revoke / kill | `setEnabled(false)` / `abortPluginCapability` / `disposePlugin` | deregister triggers (clear interval / close watcher / unregister hotkey) → abort controllers → reuse network `abortAll()` |

**New SDK / manifest surface** (main process + SDK types only; renderer/preload
unchanged): manifest schema gains `triggers[]`; SDK gains the `triggers` export
convention; `ctx` gains NO registration API (Section 1 boundary).

### Section 4 — observability & kill

Trust model B rests on after-the-fact observability + instant kill, so this is a
precondition for the model, not decoration.

**Active Background panel** (alongside existing governance UI
[plugin-capability-list.tsx](../../../src/renderer/src/components/plugins/plugin-capability-list.tsx),
reusing existing IPC). Each enabled plugin expands its trigger list; each row
shows live:

| Column | Source |
| --- | --- |
| trigger id / type / scope summary | manifest (reuse `adapter.summarize` style) |
| budget consumption `N/M (period)` | Trigger Registry counters |
| last fired / in-flight count | `TriggerRuntime.inflight` |
| status: `active / throttled / budget-exhausted / faulted / paused` | circuit-breaker |
| actions: pause / resume / kill | drives the Section 3 `triggerAbortController` |

**Three breakers, all panel-visible and all audited:**

1. **Budget exhausted** (hard cap) → silent drop + red `budget-exhausted`, no
   prompt (preserves B).
2. **Rate limit** (over-frequency) → coalesce/drop + `throttled`.
3. **Fault breaker** (new) → handler throws/times out past a threshold →
   auto-pause that trigger + `faulted`, preventing a broken plugin from burning
   resources on infinite retry. Robustness gate beyond budget.

**Audit reuses the existing chain.** Trigger-origin calls go through
[capability-audit](../../../src/main/plugins/capability-audit.ts); add
`triggerId` plus `decision: "throttled" | "dropped"` enums; redaction discipline
unchanged (safe events carry no sensitive content; full reads gate + audit
separately).

**Kill semantics** map directly to the Section 3 hierarchy:

- panel "pause trigger" = abort `triggerAbortController` + dispose adapter
  registration; sibling triggers unaffected.
- "kill plugin" = abort `pluginAbortController`; all triggers + in-flight
  handlers cut.
- global "stop all background" = iterate-abort every plugin controller (panic
  button).

## Component boundaries

- **Source adapters** (timer, fs.watch, clipboard, hotkey) — own OS
  registration + normalization into safe events; depend on Node/Electron APIs;
  expose `register(scope) → Disposable` and `fire(event)`.
- **Trigger Registry** — owns the manifest→TriggerRuntime map and the **Trigger
  Admission Breaker** (fire-frequency, coalescing, concurrency, pause, fault
  state); depends on adapters via interfaces.
- **Background Invoker** (host) — mints the `InvocationRecord` (incl. the private
  `triggerOrigin`) into a host-side `Map<invocationId, InvocationRecord>`; the
  only place that token exists. Builds the sanitized ctx facade.
- **Capability gate** (existing, extended) — looks up the `InvocationRecord` by
  invocationId; for trigger-origin calls swaps per-call approval for the
  **Capability Budget Breaker** (per-(trigger,capability,scope) budget).
- **Sandbox** (existing, extended) — `dispatchTrigger(ctxFacade, event)`
  executes the manifest-named export; never sees the invocation object or
  `triggerOrigin`, never constructs invocations.
- **Active Background panel** (renderer, existing governance UI extended) —
  read-only state + pause/resume/kill actions over existing IPC.

## Implementation order

1. **Spine + timer/cron first** as the reference implementation — registry,
   host-minted invocation, `triggerOrigin` gate path, three-level teardown,
   budget/rate/fault breakers, dispatch of safe events. Timer adds no new OS
   attack surface, so it proves the whole backbone.
2. **clipboard lift** — migrate existing `clipboard:watch` onto the spine,
   including the breaking metadata-only payload change.
3. **fs.watch** — adds `fs:watch` capability + path-scope adapter (reuse network
   path normalization; allowlist/denylist roots).
4. **global-hotkey** — adds accelerator scope + registration conflict detection.

Each trigger type is a thin adapter on the shared spine; the permission model,
teardown, and panel are built once in step 1.

## Testing

- Admission Breaker: event-storm coalescing/drop; concurrency cap; fault
  auto-pause; enable→register / disable→deregister symmetry.
- Capability Budget Breaker: per-`(trigger,capability,scope)` isolation — a
  budget for `notification` is NOT drained by `network:https` calls; exhaustion
  drops + audits without prompting.
- `uses` enforcement: a handler calling a capability absent from its trigger's
  `uses` is denied even if the plugin declares it elsewhere.
- Invoker: the sandbox never receives `triggerOrigin`; a forged/unknown/expired
  invocationId fails closed; the gate trusts only the host-side record.
- Grant invalidation: changing trigger scope / `uses` / budget / signature
  yields a new fingerprint and forces re-consent (old grant no longer matches).
- Teardown: three-level signals — revoke one trigger leaves siblings running;
  disable kills all; single timeout kills one invocation.
- Adapters: each emits the sanitized safe event only; full content requires the
  gated capability and is separately audited.
- fs.watch path normalization mirrors network-scope traversal tests; hotkey
  conflict rejection.
- End-to-end (real registry + gate + grant store, faked OS seams) per the
  network-e2e pattern.
