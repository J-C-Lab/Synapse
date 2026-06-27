# Event-Driven Automation Framework — "Downloads Organizer" Flagship (lightweight)

> Date: 2026-06-27
> Status: design (lightweight). Approved direction; to be split into ~2
> implementation plans (foundations: ①②③④ · wiring + flagship: ⑤⑥).
> Builds on the event-driven triggers landed in #14 (timer / clipboard:change /
> fs:watch) and the scoped-network / capability-governance model already LIVE.

## Goal

Prove the thesis that a plugin earns its place only by delivering what an agent
**cannot do alone** — by shipping one end-to-end flagship scenario and the
capabilities it forces into existence:

> A resident watcher notices a finished download, the **agent** decides where it
> belongs, the plugin **files it** under a governed scoped write, and the user
> gets a notification with an **Undo** button — all unattended.

Neither side can do this alone: the agent process is one-shot, has no resident
file watch, and has no governed write; the plugin has no brain. **Agent supplies
intelligence; the plugin supplies the OS-monopoly capabilities (resident watch,
governed write, native notification); governance makes unattended operation safe
and reversible.**

## The filter (why this scenario, not a calculator)

A plugin must occupy the high "physical-monopoly" band (a one-shot, GUI-less,
hook-less agent literally cannot do it) — not the "agent + shell already does
this" band. Downloads-organizer sits squarely in the monopoly band: a resident
`fs:watch` plus a governed, reversible `fs:write`, driven unattended. Pure
deterministic/format/DB work (the "agent + shell" band) is explicitly out.

## Architecture decision: Agent is the brain (option A)

The trigger does **not** run a deterministic rules engine in the plugin handler,
and the plugin is **not** granted model access. Instead the settled file event
wakes the built-in agent harness via `background-invoker`, with a bounded
toolset = only this plugin's tools, gated by the plugin's grants.

- The plugin **never** holds a model key. No new `ai:invoke` governance domain is
  opened in this round.
- Rejected alternatives: (B) plugin-as-brain with a governed `ai:invoke`
  capability — self-contained but opens token-spend governance + a new
  model-access risk surface; (C) deterministic-with-escalation — more moving
  parts, deferred. A/B/C may be revisited once `ai:invoke` is independently
  warranted.

## Governance decision: automation grant + reversibility guardrail (A+B)

The existing model says elevated capabilities, when an agent or background task
drives them, require a JIT prompt **plus per-call approval**. Unattended
automation cannot prompt on every move. Resolution:

- **Automation grant (A):** a new grant type binding `(pluginId, triggerId,
  capabilityId, scope)`. Created once via a JIT prompt; afterwards background /
  trigger-driven calls within that scope run **without** per-call prompts.
  Revocable in the existing grant/revoke UI; invalidated if the scope changes or
  the capability declaration hash changes.
- **Reversibility guardrail (B):** only **reversible / journaled** operations can
  be released by an automation grant. **Irreversible** operations (delete,
  overwrite of an existing file) are **always** downgraded to per-call approval,
  even inside an automation grant's scope.

This is the core "permissions & capabilities" contribution: governed capabilities
that support unattended automation without regressing to ungoverned, shell-style
blanket access. It generalizes to every later event-driven scenario
(clipboard→calendar, monitoring sentinels).

## Capability ledger for the flagship

| Step | Capability | State | Note |
| --- | --- | --- | --- |
| Notice new file | `fs:watch` trigger | extend | Event carries `rootId/relativePath/kind/size/ext` but **no "download finished" semantics** — settle/debounce needed (③). |
| Inspect file | `fs:read` | exists | Scope must align with the write scope. |
| File it | **`fs:write`** (move/rename/mkdir/writeText) | **new** | Missing entirely today; SDK `fs.ts` has only `resolvePath`+`readText`. Core new capability (①). |
| Notify + Undo | `notification` with actions/callback | extend | Today only `new Notification().show()` — no buttons, no callback (②). |
| Undo journal | `storage:plugin` | exists | Records pre-move location for rollback. |

## Deliverables (build order)

### ① `fs:write` capability (core)

- Registry: `id: "fs:write"`, `tier: elevated`, `scopeEnforced: true`,
  **reuses `fsPathAdapter`** (same path-scope semantics as fs:read/watch).
- SDK `FsAPI` additions: `writeText(rootId, rel, data)`, `mkdir(rootId, rel)`,
  `move(fromRootId, fromRel, toRootId, toRel)`, `rename` (= move within one dir).
  Both endpoints of a move must lie inside granted scope.
- **Reversibility classification** (feeds the guardrail): `move` / `rename` /
  `mkdir` / new-file create = **reversible** (journaled); overwrite of an
  existing file = **irreversible**.
- `delete` is **out of scope this round** — the organizer moves, never deletes;
  YAGNI. A separate elevated capability if ever needed.

### ② Notification with actions + callback (extend `notification`)

- `show({ title, body, actions?: [{ id, title }] })`; clicking an action
  dispatches a `notification:action` event `{ notificationId, actionId }` back to
  the plugin (mirrors the existing `PluginEventRequest` dispatch shape).
- Undo flow: the plugin journals each move keyed by `notificationId` in
  `storage:plugin`; on the Undo action it issues the reverse `move` — itself a
  reversible, in-scope `fs:write`, so it passes the guardrail automatically.

### ③ fs:watch "download finished" settle (extend the trigger)

- Trigger scope gains optional `settle: { stableMs, ignoreExtensions? }`: the
  adapter buffers raw events per path and only emits a synthesized settled
  `create` once the file size has been stable for `stableMs` and its extension is
  not in the ignore set (default `crdownload` / `part` / `tmp` / `download`).
- Default remains raw mode; settle is opt-in.

### ④ Automation grant + reversibility guardrail (governance core)

- `grant-store` gains `AutomationGrant { pluginId, triggerId, capabilityId,
  scope, createdAt }`.
- `capability-gate` decision for a background/trigger-driven elevated call:
  - find a matching automation grant (same plugin + trigger + capability, and
    requested scope ⊆ granted scope via `adapter.contains`);
  - matched **and reversible** → **allow, no prompt**;
  - matched **but irreversible** → per-call approval;
  - no match → per-call approval (unchanged).
- The automation grant is created on first run via JIT prompt and surfaced in the
  existing capability/revoke UI.

### ⑤ Wiring (architecture A): trigger → agent

- A new "agent-driven" trigger kind: the settled event, instead of only invoking
  the plugin's own handler, enqueues a background agent task through
  `background-invoker` carrying: a manifest-supplied instruction template, the
  settled event payload, and a **bounded toolset = only this plugin's tools**
  (`fs:read` / `fs:write` / `notify`), gated by the plugin's grants + automation
  grant.
- The manifest declares the trigger as agent-driven and supplies the task prompt.

### ⑥ Flagship plugin `downloads-organizer` (reference consumer)

- Declares: `fs:watch` (settle, `~/Downloads`) + `fs:read` + `fs:write` (scope:
  `~/Downloads` + category dirs) + `notification`; an agent-driven `fs:watch`
  trigger whose prompt is "classify this finished download and file it under the
  right category folder".
- Exercises the full loop: settle → wake agent → read → decide → governed move →
  notify with Undo.

## Out of scope (this spec)

- `delete` / file removal capability.
- `ai:invoke` (plugin-held model access) and its token-spend governance.
- Accessibility automation / cross-app input (the option-③ flagship from
  brainstorming — heavier platform + security surface, deferred).
- The clipboard→calendar scenario (the natural next flagship once a secrets
  vault exists).

## Testing (per deliverable)

- **① fs:write:** writeText/mkdir/move/rename succeed only inside granted scope;
  a move with either endpoint outside scope is denied + audited; overwrite of an
  existing file is classified irreversible.
- **② notification:** an action click dispatches `notification:action` to the
  plugin; the Undo reverse-move restores the original location.
- **③ settle:** a `.crdownload` → final-name rename emits exactly one settled
  `create`; a still-growing file emits nothing until stable for `stableMs`; raw
  mode (no `settle`) is unchanged.
- **④ governance:** reversible in-scope call under an automation grant runs with
  no prompt; an irreversible call under the same grant still prompts; an
  out-of-scope call has no grant and prompts; revoking the automation grant
  restores per-call approval.
- **⑤ wiring:** a settled event enqueues an agent task whose toolset is exactly
  the plugin's gated tools and nothing else.
- **⑥ flagship:** end-to-end — a dropped file is classified, moved, and
  surfaced with a working Undo, unattended.
