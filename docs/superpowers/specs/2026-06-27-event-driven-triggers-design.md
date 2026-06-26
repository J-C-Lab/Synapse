# Event-Driven Triggers + Background Capability Model Design

> Date: 2026-06-27
> Status: design approved in conversation (4 sections), revised after external
> review (host-minted invocation, three-level signal teardown, manifest-named
> handlers, sanitized event payloads). Implementation plan not yet drafted.

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

| Gate | Semantics | On trip |
| --- | --- | --- |
| Scope check | `adapter.contains(declared, requested)` (unchanged) | deny + audit |
| Standing grant | granted at enable time | — |
| Budget | per trigger: ≤ N sensitive actions / period | drop + audit + panel red |
| Rate | per trigger min interval / per plugin concurrency cap | coalesce or drop |
| Cancel signal | revoke / kill / disable → abort in-flight | reuse network `abortAll` |

**Invariant:** budget/rate are a **hard circuit-breaker, not a consent
mechanism** — exhaustion drops silently and surfaces in the panel; it never
prompts. Consent happens only at enable time. The existing agent-driven
`elevated` path is unchanged (no `triggerOrigin` marker → still per-call
`approve()`), so security there is not weakened.

**Per-trigger scope shapes (v1 four types):**

- **timer/cron** — `{ schedule: "*/5 * * * *" | { intervalMs } }`, enforced
  minimum interval floor (e.g. ≥1s) against busy loops; budget derived from
  frequency by default.
- **fs.watch** — `{ paths: ["~/Documents/**"], events: ["create","modify"] }`,
  path normalization reusing the network-scope approach (`..` / encoding
  folding), with system/sensitive directories denied (allowlist roots +
  denylist).
- **clipboard** — `{ contentTypes?: ["text"] }`, lifting the existing
  `clipboard:watch` into this model.
- **global-hotkey** — `{ accelerator: "CmdOrCtrl+Shift+K" }`, conflict detection
  at registration time (reject already-bound / system-reserved combos) to
  prevent hotkey hijacking.

### Section 3 — lifecycle & dispatch (revised)

The existing dispatch is already the right shape (builds a background context
with `actor:"background"` + trigger + abort signal, runs the hook under a
timeout). Four revisions harden it:

**R1 — the background invocation is minted by the host-side Invoker; the sandbox
only executes the handler inside it.** Security-critical: `triggerOrigin` is the
switch that disables per-call prompting (Section 2). The plugin/sandbox must NOT
be able to construct it, else a plugin could forge `triggerOrigin` and bypass
the agent-driven `elevated` per-call `approve()`.

```
fire(event) → registry lookup + budget/rate circuit-breaker
            → Background Invoker (host) mints invocation:
                actor: "background"
                triggerOrigin: runtime-private token (sandbox cannot see/build)
                pluginId / triggerId
                audit + grant context
                per-trigger signal + single-shot timeout
            → sandbox.dispatchTrigger(invocation, event)  // executes manifest-named export only
```

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

```jsonc
"triggers": [
  { "id": "sync-5min",     "type": "timer",    "schedule": {"intervalMs": 300000}, "handler": "triggers.onSyncTick" },
  { "id": "daily-summary", "type": "cron",     "schedule": "0 9 * * *",            "handler": "triggers.onDailySummary" },
  { "id": "watch-dls",     "type": "fs.watch", "scope": {"paths":["~/Downloads/**"]}, "handler": "triggers.onDownloads" }
]
```

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
| clipboard | `{ contentTypes, textLength, changedAt, hash? }` | full text → `clipboard:read` |
| fs.watch | `{ path, kind, timestamp, size?, ext? }` | file content → `fs:read` |
| hotkey | `{ accelerator, pressedAt }` | — |
| timer | `{ scheduledAt, firedAt, driftMs }` | — |

> Migration note (breaking): the current
> [dispatchEvent](../../../src/main/plugins/plugin-sandbox.ts) hands the full
> `ClipboardContent` to the handler. Under the new model clipboard events
> downgrade to metadata; full text requires `clipboard:read`. Intentional
> hardening, flagged breaking.

**Lifecycle hook map:**

| Phase | Mount point | Action |
| --- | --- | --- |
| Enable | `host.setEnabled(id, true)` | read manifest triggers → register 4 adapters (start interval/cron, fs watcher, clipboard poll, hotkey); enable-time consent gate first |
| Fire | adapter `fire(event)` | registry lookup → budget/rate circuit-breaker → host mints invocation → `sandbox.dispatchTrigger` |
| Execute | warm sandbox | run manifest-named export handler; each sensitive action → gate (scope + grant, no prompt) |
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
- **Trigger Registry** — owns the manifest→TriggerRuntime map, budget/rate
  counters, circuit-breaker state; pure-ish, depends on adapters via interfaces.
- **Background Invoker** (host) — mints invocation contexts incl. the private
  `triggerOrigin`; the only place that token is created.
- **Capability gate** (existing, extended) — recognizes `triggerOrigin` to swap
  per-call approval for the budget/rate check.
- **Sandbox** (existing, extended) — `dispatchTrigger(invocation, event)`
  executes the manifest-named export; never constructs invocations.
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

- Registry: budget exhaustion drops + audits; rate coalescing; fault
  auto-pause; enable→register / disable→deregister symmetry.
- Invoker: `triggerOrigin` cannot be forged from sandbox; gate swaps approval
  for budget check only when present.
- Teardown: three-level signals — revoke one trigger leaves siblings running;
  disable kills all; single timeout kills one invocation.
- Adapters: each emits the sanitized safe event only; full content requires the
  gated capability and is separately audited.
- fs.watch path normalization mirrors network-scope traversal tests; hotkey
  conflict rejection.
- End-to-end (real registry + gate + grant store, faked OS seams) per the
  network-e2e pattern.
