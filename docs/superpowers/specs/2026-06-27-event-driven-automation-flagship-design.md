# Event-Driven Automation Framework — "Downloads Organizer" Flagship (sketch)

> Date: 2026-06-27
> Status: **design sketch / flagship scenario — NOT implementation-ready.**
> Direction approved. Must resolve the 6 amendments below (governance alignment,
> background-agent invocation boundary, reversibility model, agent budget, undo
> ownership, fs:write/notification/settle semantics) before splitting into
> implementation plans. Builds on the event-driven triggers model in
> `2026-06-27-event-driven-triggers-design.md` and the capability-governance /
> scoped-network model already LIVE.

## Goal

Prove the thesis that a plugin earns its place only by delivering what an agent
**cannot do alone** — by shipping one end-to-end flagship scenario and the
capabilities it forces into existence:

> A resident watcher notices a finished download, the **agent** decides where it
> belongs, **deterministic host/plugin code** files it under a governed scoped
> write, and the user gets a notification with an **Undo** button — unattended.

Neither side can do this alone: the agent process is one-shot, has no resident
file watch, and no governed write; the plugin has no brain. **Agent supplies
intelligence (a classification decision); the plugin/host supplies the
OS-monopoly capabilities (resident watch, governed write, native notification)
and owns the safety-critical mechanics (journal, rollback). Governance makes
unattended operation safe and reversible.**

## The filter (why this scenario, not a calculator)

A plugin must occupy the high "physical-monopoly" band (a one-shot, GUI-less,
hook-less agent literally cannot do it). Downloads-organizer sits squarely there:
a resident `fs:watch` plus a governed, reversible write, driven unattended. Pure
deterministic/format/DB work (the "agent + shell already does this" band) is out.

## Architecture decision: Agent is the brain (option A)

The trigger does **not** run a rules engine in the plugin handler, and the plugin
is **not** granted a model key. The settled file event wakes the built-in agent
harness via `BackgroundInvoker`, with a bounded toolset gated by the trigger's
declared `uses`. The plugin never holds a model key; no `ai:invoke` governance
domain is opened in this round. (Rejected: (B) plugin-as-brain with `ai:invoke`;
(C) deterministic-with-escalation — deferred.)

**Refinement (amendment 6):** the agent decides, it does not write. It is handed
a **narrow decision tool**, not generic `fs:write`. The move + journal + notify
are executed by deterministic host/plugin code. This keeps the thesis honest:
agent = intelligence, plugin/host = OS capability + safety semantics. See §⑥.

---

## Governance alignment with Event-Driven Triggers (amendment 1)

**This spec does not introduce a second permission system.** There is no new
`AutomationGrant`. The mechanism already exists and is LIVE:

- Enabling a plugin runs `grantTriggerUses` ([trigger-grants.ts](../../../src/main/plugins/trigger-grants.ts)),
  which creates a **standing grant** under the existing `GrantIdentity`
  (`pluginId / publisherId / signingKeyFingerprint / capabilityDeclarationHash`)
  for every non-`auto` capability listed in a trigger's `uses`. Trigger identity
  is bound via `triggerDeclarationHash` in `capability-governance.ts`.
- Consent is therefore **enable-time, not first-background-run** — fixing the
  "user is not at the computer" hole. The user authorizes the whole unattended
  behavior when enabling the plugin.
- A standing grant is invalidated by the existing identity model: a publisher /
  signing-key / declaration-hash / trigger-declaration-hash change drops prior
  trust. No bespoke grant identity is needed (the original sketch's bare
  `{pluginId, triggerId, capabilityId, scope}` tuple was weaker than this and is
  dropped).

So `fs:write` is simply declared in the organizer trigger's `uses`. **The only
net-new governance is the reversibility guardrail** (§④), layered into the
capability gate's existing background/agent branch.

A capability call from a background-agent invocation is allowed only if **all**
hold (extends the triggers spec's gate rules):

1. the capability is declared by the plugin;
2. the capability is listed in **this trigger's `uses`** (not "all plugin
   tools" — amendment 2);
3. the requested scope is contained by declared ∩ grant ∩ uses ∩
   invocation-narrowed scope (adapter `contains`, gate stays scope-agnostic);
4. the per-`(pluginId, triggerId, capabilityId, normalizedScope, period)` budget
   remains (existing Capability Budget Breaker);
5. for `fs:write`: the operation has a committed journal **and** is currently
   reversible — otherwise it falls back to per-call approval.

---

## Background-agent invocation boundary (amendment 2)

Reuse the existing host-private origin model — do **not** let the plugin/agent
assert its own background-ness:

- `InvocationRecord` ([background-invoker.ts](../../../src/main/plugins/background-invoker.ts))
  already holds `triggerOrigin: symbol` host-side only; the sandbox receives
  `BackgroundContextOptions` with **no** `triggerOrigin`; the gate resolves the
  record by `invocationId` and trusts only the host record. A forged/expired id
  fails closed. This boundary already exists and tests enforce it.

Two net-new pieces this scenario needs:

- **Actor distinction.** The gate currently treats `actor: "agent"` and
  `"background"` identically (per-call approval, [capability-gate.ts:180](../../../src/main/plugins/capability-gate.ts)).
  The flagship needs the *opposite* for reversible in-scope writes. Add
  `actor: "background-agent"` to `CapabilityActor` (a trigger-woken agent task),
  so the gate can: skip per-call approval for reversible in-scope `uses`, while
  still recording "a model made this decision".
- **`allowedUses` on the record.** Add host-side `allowedUses: TriggerUse[]` to
  `InvocationRecord` so the gate enforces rule 2 (capability ∈ this trigger's
  uses) without re-deriving it. Never crosses into the sandbox.

---

## Reversibility = journaled operation + current state (amendment 3)

Reversibility is **not** a static API-name classification. `move` is only
reversible when the target did not pre-exist, the source is unchanged, the
journal is already on disk, and rollback is possible (a cross-volume `move`
degrades to copy+delete — a different risk class than an atomic rename).

```ts
interface FsWriteOperation {
  kind: "move" | "mkdir" | "writeText"
  collisionPolicy: "fail-if-exists" | "overwrite-requires-approval"
  journalPolicy: "required"
  rollback: "supported" | "best-effort" | "unsupported"
}
```

Hard rules:

1. The journal entry is committed to disk **before** the write executes.
2. `move` defaults to `fail-if-exists` — never silent overwrite.
3. Undo verifies the target is still the file this op produced (journal `opId`
   + size/mtime, optional content hash) before reversing.
4. A failed rollback notifies the user and writes an audit entry.
5. Reversibility is decided by operation **+ current file state** at gate time,
   not by the method name.
6. `mkdir` that finds an existing directory returns already-exists, is not a
   "new" op, and writes no journal. Undo of a created dir is only via the
   journal's rollback mechanism (not a general plugin-facing delete, which stays
   out of scope).

---

## Agent task budget (amendment 4)

Not opening `ai:invoke` is correct (no plugin model key), but a background
trigger auto-waking the built-in agent still spends the user's model quota, CPU,
context, and time. So a background-agent trigger **must** declare an agent budget
alongside its capability budgets, surfaced in enable-time consent:

```jsonc
"agent": {
  "maxRuns": 20,            // per period
  "period": "1d",
  "maxToolCallsPerRun": 8,
  "maxTokensPerRun": 4000,
  "timeoutMs": 30000
}
```

Enable-time consent string, e.g.: *"This plugin may auto-wake the Agent when a
new file appears in Downloads, up to N times/day, max M tool calls each."* This
keeps the flagship inside the triggers spec's budget/rate/fault breaker model
instead of around it.

---

## Capability ledger

| Step | Capability | State | Note |
| --- | --- | --- | --- |
| Notice new file | `fs:watch` trigger | extend | settle/debounce for "download finished" (③). |
| Inspect file | `fs:read` (in trigger `uses`) | exists | scope aligned with write scope. |
| Decide | narrow decision tool / structured output | new | agent does NOT get generic `fs:write` (amend. 6). |
| File it | **`fs:write`** (in trigger `uses`, reversibility-gated) | **new** | host owns journal + move (①, amend. 3/5). |
| Notify + Undo | `notification` with host-minted actions | extend | action carries only host-minted `journalId` (amend. 7). |
| Undo journal | host-side, inside `fs:write.move()` | new | not agent/plugin discretion (amend. 5). |

## Deliverables (build order)

### ① `fs:write` capability + path/collision semantics (amendment 6)

- Registry: `id: "fs:write"`, `tier: elevated`, `scopeEnforced: true`, **reuses
  `fsPathAdapter`**.
- SDK `FsAPI`: `writeText`, `mkdir`, `move(from, to, opts)`, `rename`. The host
  `move` returns a host-minted `{ journalId }`.
  ```ts
  move(fromRootId, fromRel, toRootId, toRel, {
    ifTargetExists?: "fail" | "prompt-overwrite"   // default "fail"
    preserveMetadata?: boolean
    journal?: true
  })
  ```
- Rules: every `rel` canonicalized by the adapter (reject `..`, encoded
  traversal, absolute paths, empty segments); symlinks cannot escape scope
  (reuse the existing realpath + `O_NOFOLLOW` guard in
  [fs-path-resolver.ts](../../../src/main/plugins/fs-path-resolver.ts));
  case-insensitive collision handled on Windows/macOS (`Report.pdf` vs
  `report.pdf`); **both** move endpoints inside declared ∩ grant ∩ uses ∩
  invocation-narrowed scope; `writeText` is new-file-only by default, overwrite
  is always per-call approval; `delete` out of scope this round.

### ② Notification with host-minted actions + callback (amendment 7)

- `show({ title, body, actions?: [{ id, title }] })`; clicking dispatches a
  `notification:action` event `{ notificationId, actionId }` to the plugin.
- Security: `notificationId` is **host-generated** (not plugin-chosen); the
  callback is bound to the original `pluginId + notificationId + actionId`;
  actions have a TTL (e.g. 1 h) after which a click only opens the history
  panel; the action payload may carry **only** a host-minted `journalId`, no
  arbitrary plugin JSON; on platforms without notification buttons, fall back to
  an Undo in the Active Background panel / Notification Center.

### ③ fs:watch "download finished" settle (amendment 8)

- Trigger scope gains optional `settle: { stableMs, ignoreExtensions? }`
  (default ignore `crdownload`/`part`/`tmp`/`download`).
- Real-download semantics: a `.crdownload → final-name` rename emits exactly one
  settled `create` for the final name; a cancelled/deleted temp emits nothing; a
  file that resumes growing **resets** the stability timer; a per-path **max
  settle window** (e.g. 10 min) bounds the in-memory table; `stableMs` has a
  floor (e.g. 1000 ms) to prevent a 0-value storm; output stays a **safe event**
  (`rootId + relativePath + size + ext`, no absolute path).

### ④ Reversibility guardrail in the capability gate (governance core)

Per §"Governance alignment" + §"Reversibility": the gate, for a
`background-agent` invocation hitting `fs:write`, allows without prompt only when
the op is journaled-and-currently-reversible and in scope; irreversible ops
(overwrite, cross-volume degrade, anything `rollback: unsupported`) downgrade to
per-call approval. No new grant store; this is a gate decision over the existing
standing trigger grant.

### ⑤ Wiring (architecture A): trigger → background-agent

- The settled event mints a `background-agent` `InvocationRecord` (with
  `allowedUses`) via `BackgroundInvoker` and enqueues an agent task carrying the
  manifest instruction template + the settled (safe) event payload + a bounded
  toolset = exactly this trigger's `uses`.

### ⑥ Flagship plugin `downloads-organizer` (amendment 6)

- The agent is handed a **narrow tool / structured-output contract**, not generic
  `fs:write`:
  ```ts
  organizer.classifyAndMove({
    sourceRootId, sourceRel,
    category: "images" | "documents" | "archives" | "videos" | "other",
    reason
  })
  // or the agent only emits { category, confidence, reason } and host code moves.
  ```
  The deterministic `classifyAndMove` (host/plugin) performs journal → move →
  notify-with-Undo. The Undo action carries the host-minted `journalId`; the host
  bridge validates and performs the rollback.
- Declares: `fs:watch` (settle, `~/Downloads`), `fs:read`, `fs:write` (scope:
  `~/Downloads` + category dirs), `notification`, all as trigger `uses` with
  budgets + the `agent` budget; agent-driven `fs:watch` trigger.

## Out of scope (this spec)

- `delete` / general file removal (rollback-only deletion of journaled creates is
  internal, not a plugin-facing capability).
- `ai:invoke` (plugin-held model access) + its token governance.
- Accessibility automation / cross-app input (deferred heavier flagship).
- The clipboard→calendar scenario (next flagship, once a secrets vault exists).

## Testing (per deliverable)

- **① fs:write:** ops succeed only inside declared ∩ grant ∩ uses ∩ narrowed
  scope; either move endpoint out of scope is denied + audited; `..`/absolute/
  symlink-escape rejected; case-insensitive collision detected; `writeText`
  overwrite is irreversible/per-call; cross-volume move classified
  `best-effort`/non-atomic.
- **② notification:** plugin-chosen notificationId is rejected (host mints it);
  an action click dispatches `notification:action`; expired action only opens
  history; action payload cannot carry arbitrary JSON beyond `journalId`.
- **③ settle:** `.crdownload → final` emits one settled `create`; growth resets
  the timer; cancelled temp emits nothing; max-settle-window evicts; `stableMs`
  floor enforced; event leaks no absolute path.
- **④ governance:** reversible in-scope `background-agent` `fs:write` runs with
  no prompt; irreversible (overwrite / cross-volume / `rollback: unsupported`)
  prompts even under the standing grant; out-of-scope denied; disabling the
  plugin revokes the standing `uses` grant (existing `revokeTriggerUses`).
- **⑤ wiring:** the invocation's toolset equals the trigger's `uses` and nothing
  else; the agent cannot reach a capability the plugin declares but this trigger
  does not list; `triggerOrigin` never appears in sandbox-visible options;
  `allowedUses` enforced host-side.
- **⑥ flagship + agent budget:** end-to-end classify → move → Undo restores the
  original location (verified by journal opId + size/mtime); exceeding
  `maxRuns`/`maxToolCallsPerRun`/`maxTokensPerRun`/`timeoutMs` trips the breaker;
  the agent never invokes generic `fs:write` directly.
