# Trigger → Workspace Binding

> Date: 2026-07-11 · Status: draft, revised after two review rounds, pending
> re-review
> Fourth and final part of the four-part workspace-unification decomposition
> (① workspace-root-unification, merged [PR #40](https://github.com/J-C-Lab/Synapse/pull/40);
> ② host-resource-approval infrastructure, merged [PR #41](https://github.com/J-C-Lab/Synapse/pull/41);
> ③ workspace-instructions MCP resource, merged [PR #42](https://github.com/J-C-Lab/Synapse/pull/42)).
> Explicitly independent of ①–③ — flagged in ①'s spec as needing "a
> per-trigger settings layer/store from scratch," verified at the time to
> exist nowhere (manifest, `TriggerRuntime`, `InvocationRecord`, or
> renderer). Decided by interactive user Q&A on 2026-07-11; revised after
> two review rounds. Round 1 (3 P1 blocking, 4 P2): a real event-vs-instance
> dispatch ambiguity, a claimed capability (`memory` scope) this spec
> cannot actually deliver, a missing identity-pinning mechanism, and four
> narrower implementation gaps. Round 2 (3 P1 blocking, 2 P2): the store API
> didn't actually accept the `GrantIdentity` its own record type required,
> the async adapter-registration/pause-resume control flow didn't close the
> loop back to the registry, and `instanceId`/`workspaceId` were promised on
> `RunTrace`/audit but the plumbing to get them there was never specified.
> All findings verified against the real code before being fixed here, same
> discipline as ①–③.

## Why this is needed

Verified against the real code, not assumed:

- **Only agent-triggers (a manifest trigger with an `agent` block) ever
  produce an `AgentRuntime.run()` call.** `TriggerRegistry.onFire()`
  (`trigger-registry.ts:143-206`) branches on `decl.agent`: without it, the
  trigger's manifest-named handler runs directly in the sandbox with no
  `caller` concept at all. With it, `PluginHost.dispatchBackgroundAgent()`
  constructs a `BackgroundAgentRunner` whose `run()`
  (`background-agent-runner.ts:94-98`) builds
  `caller: { kind: "background-agent", invocationId, runId }` — **no
  `workspaceId` field exists anywhere in this path today.** This spec is
  therefore scoped entirely to agent-triggers; plain (non-agent) triggers
  are untouched throughout.
- **Every agent-trigger run today is invisibly global-scoped for
  trace/audit purposes.** `scopeForCaller()` (`memory-scope.ts:24-27`)
  falls through to `{ visibility: "global" }` whenever `caller.workspaceId`
  is absent. This spec gives the caller a real `workspaceId`, so trace and
  audit stop attributing every background-agent run to "nowhere."
- **Two capabilities remain, and stay, completely unreachable from any
  trigger — confirmed, not assumed, and this spec does not change either.**
  - Execution tools: `PluginHost`'s `this.tools` (`plugin-host.ts:270`) is
    a `PluginToolBridge` wrapping only the plugin registry —
    `list_files`/`read_file`/`search_files`/`apply_patch`/`run_command` are
    never registered into it.
  - Memory tools: `PluginHost.dispatchBackgroundAgent()`
    (`plugin-host.ts:413-436`) constructs `BackgroundAgentRunner` with
    `tools: this` — the *same* plugin-only tool bridge.
    `MemoryToolSource` (`memory_save`/`recall`/`list`) is composed only
    into the separate `CompositeToolHost` built in `index.ts` for the
    interactive-agent path. A background-agent run cannot call any memory
    tool today, full stop — see §3 for why this spec does not attempt to
    change that.

## Guiding principle

**A manifest-declared agent-trigger is a template, not a runnable thing by
itself.** Binding it to a workspace creates a long-lived **instance** — the
unit that fires, runs, consumes budget, and is individually
pausable/killable. A trigger template can have zero, one, or many
instances, each bound to exactly one workspace, at most one instance per
(template, workspace) pair. The same automation can run independently in
several workspaces without the user re-editing a single shared binding
every time they switch context — the whole reason this model was chosen
over "one workspace per trigger" during Q&A.

**What binding an instance to a workspace actually delivers, precisely:**
the instance's runs carry that workspace's id on `caller.workspaceId`
(so `RunTrace` and capability audit entries are attributed to a real
workspace instead of nothing), and the run's system prompt gets that
workspace's `AGENTS.md`/`CLAUDE.md` folded in via the same
`loadWorkspaceInstructions` spec ③ already hardened. **It does not** grant
memory tool access or execution tool access — both are non-goals, for
different reasons (see below and §3).

Non-agent triggers are **entirely out of scope** for this spec: they keep
registering automatically at plugin-enable time exactly as today, with no
instance concept, no workspace binding, no behavior change.

## Non-goals (explicitly deferred)

- **Memory tool access for agent-trigger instances.** Reviewer-caught: the
  original draft of this spec claimed binding would make
  `memory_save`/recall "workspace-scoped for free" via `scopeForCaller()`.
  That's true *if* the tools were reachable — they are not (see above).
  Wiring `MemoryToolSource` into `BackgroundAgentRunner`'s tool host is not
  a safe drop-in either: memory tools declare no `capabilities` on their
  descriptors today, so `toolCapabilitiesAllowed()`'s `.every()` over an
  empty array vacuously passes them regardless of a trigger's `uses[]` —
  every agent-trigger instance would silently gain unbudgeted
  `memory_save`/`memory_delete` the moment this shipped. Giving memory
  tools a real capability/budget declaration model is real, separate
  design work; a workspace-bound instance is the *prerequisite* for that
  follow-up (it needs `caller.workspaceId` to exist first, which is what
  this spec delivers), not something this spec builds itself.
- **Execution tool access for agent-trigger instances.** Same reasoning
  as memory: the five execution tools declare no `capabilities` either, so
  they'd have the identical vacuous-pass problem. Also would need a
  workspace→root resolution decision this spec doesn't make. Separate spec
  if ever needed.
- **Per-instance schedule/scope customization.** `schedule`/`scope` stay
  template-level (manifest-declared), identical for every instance of a
  trigger — an instance only chooses *which workspace*, never *when* or
  *what* the trigger watches.
- **A bulk "kill all instances across all workspaces" UI action.** The user
  removes instances individually; plugin disable/uninstall already tears
  down every trigger and every instance through an internal path (§6).
- **Exact visual placement of the "+ Add to workspace" affordance** in the
  Active Background panel — left to the implementation plan, same as ①'s
  parked "Manage roots" placement decision.
- **Any change to `McpClientManager`/`exposedExecutionRootIds`** or the
  external-MCP-caller path — unrelated axis, untouched.

## 1. Data model

```ts
// src/main/plugins/trigger-instance-store.ts
import type { GrantIdentity } from "./grant-store"

export interface TriggerInstanceRecord {
  /** Host-generated (crypto.randomUUID()), stable for the record's lifetime. */
  id: string
  /** Full plugin identity at creation time, NOT a bare pluginId — see
   *  "Identity pinning" below for why. */
  identity: GrantIdentity
  triggerId: string
  workspaceId: string
  /** true = record persists but is excluded from fan-out on fire. */
  paused: boolean
  createdAt: number
}

export class TriggerInstanceStore {
  async listAll(): Promise<TriggerInstanceRecord[]>
  async listForTrigger(pluginId: string, triggerId: string): Promise<TriggerInstanceRecord[]>
  /** Throws if a *non-stale* instance already exists for this exact
   *  (pluginId, triggerId, workspaceId) triple — at most one live instance
   *  per (template, workspace) pair, matching the product model: rebinding
   *  the same automation to the same workspace a second time is not a new
   *  parallel state, it's a no-op the UI should just not offer. Takes the
   *  full `GrantIdentity`, not a bare `pluginId` — the store cannot
   *  construct one itself (it has no access to the plugin's manifest or
   *  source kind), so the caller (the IPC handler, §6) resolves it first
   *  via the same `identityForPlugin` callback `TriggerRegistry` uses
   *  (§2). If a *stale* instance already occupies the triple (its stored
   *  `identity` doesn't match `identity` via `sameIdentity()`), `create()`
   *  still throws — staleness is resolved only through `reactivate()`
   *  below, never silently through `create()`, so there is exactly one
   *  code path that can turn a stale record current again. Mutations
   *  serialize through an internal `runExclusive()` queue, the same
   *  pattern `McpExposureStore` already uses — a plain read-check-write
   *  would let two concurrent `create()` calls both pass the duplicate
   *  check before either writes. */
  async create(identity: GrantIdentity, triggerId: string, workspaceId: string): Promise<TriggerInstanceRecord>
  /** Updates a stale instance's stored `identity` to `currentIdentity`,
   *  clearing its stale state. Throws if `id` doesn't exist. Deliberately
   *  narrow — this is the *only* way an instance's `identity` field
   *  changes after creation, so "was this instance ever silently
   *  re-pinned to a different plugin identity" always has one obvious
   *  answer: no, `reactivate()` always sets it to whatever the plugin's
   *  manifest currently says, never to an arbitrary caller-supplied value. */
  async reactivate(id: string, currentIdentity: GrantIdentity): Promise<TriggerInstanceRecord>
  async setPaused(id: string, paused: boolean): Promise<void>
  /** Deletes the record and returns it (or `undefined` if `id` didn't
   *  exist). Returns the removed record, not `void`, specifically so
   *  `TriggerRegistry.onInstanceRemoved()` (§2) — which needs the
   *  record's `identity.pluginId`/`triggerId` to know which trigger's
   *  adapter to possibly deregister — doesn't need a separate lookup
   *  before the delete. */
  async remove(id: string): Promise<TriggerInstanceRecord | undefined>
  /** Deletes every record for a plugin, regardless of trigger or
   *  workspace. Used only by uninstall (§6) — disable does NOT call this,
   *  see the disable-vs-uninstall note below. Returns the removed records
   *  so the caller can deregister each affected trigger's adapter if it
   *  just lost its last instance. */
  async removeForPlugin(pluginId: string): Promise<TriggerInstanceRecord[]>
}
```

Plain JSON file under `userDataDir/ai/`, following `WorkspaceRootStore`'s
conventions for reads/writes, and `McpExposureStore`'s `runExclusive()`
pattern for mutation serialization.

**Identity pinning (reviewer-caught, P1).** The original draft keyed
instances on a bare `pluginId` + `triggerId`, with no defense against a
plugin update silently changing the schedule, `uses[]`, agent budget, or
handler out from under an existing instance. This codebase already solves
exactly this problem for capability grants: `buildGrantIdentity()`
(`capability-governance.ts:28-46`) hashes `manifest.capabilities`,
`manifest.triggers` (via `triggerDeclarationHash`, folding in **every**
trigger's `id`/`type`/`scope`/`schedule`/`handler`/`uses`/`agent`), and
`manifest.contributes.credentials` into one `capabilityDeclarationHash`,
and `GrantStore`/`McpExposureStore` already key their records on the full
`GrantIdentity` (via `sameIdentity()`), not a bare id — "a plugin update
that rotates `capabilityDeclarationHash` does not silently carry over a
prior exposure decision" is a direct quote from `mcp-exposure-store.ts`'s
own comment, and it's exactly the invariant this spec needs too. So
`TriggerInstanceRecord.identity: GrantIdentity` reuses that existing
mechanism verbatim rather than inventing a parallel
`triggerDeclarationHash` field — the hash already changes on a change to
*any* trigger's declaration, at the same "whole plugin" granularity
`GrantStore`/`McpExposureStore` already use, so this introduces no new
inconsistency in how coarsely staleness is detected.

**How `TriggerRegistry` gets a `GrantIdentity` to compare against
(reviewer-caught gap, round 2): it cannot compute one itself.**
`buildGrantIdentity()` needs the plugin's manifest and source kind, which
`TriggerRegistry` — a small, focused component that only ever sees trigger
declarations, not full manifests — has no access to. `TriggerRegistryDeps`
therefore gains one more dependency:

```ts
export interface TriggerRegistryDeps {
  // ...existing fields (admission, invoker, adapters, dispatch, dispatchAgent)...
  /** Resolves a plugin's current GrantIdentity, or undefined if it isn't
   *  active. Constructed by PluginHost from its own registry — this is the
   *  exact same shape already used by stdio-entry.ts's `identityForPlugin`
   *  callback for MCP tool identity, reused here rather than inventing a
   *  parallel resolver. */
  identityForPlugin: (pluginId: string) => GrantIdentity | undefined
}
```

At registration time and at every fire, `TriggerRegistry` calls
`this.deps.identityForPlugin(pluginId)` and compares the result against
each instance's stored `identity` via `sameIdentity()`. A mismatch (or an
`undefined` current identity, meaning the plugin is no longer active) means
the instance is **stale**: excluded from fan-out (§2), surfaced in the
Active Background panel with a `needs-review` status, and does **not**
auto-resume. The user must explicitly re-confirm it via the new
`triggers:reactivate-instance` IPC (§6), which calls
`TriggerInstanceStore.reactivate(id, currentIdentity)` — **not**
`create()` (reviewer-caught contradiction, round 2: the original draft
said "re-run `create()` with the current identity," but `create()` throws
on a triple that's already occupied, stale or not — reactivation needed
its own method precisely so it isn't fighting `create()`'s own duplicate
guard). This mirrors the existing standing-grant-invalidation behavior for
capabilities, applied to instances.

`triggers:create-instance` (§6) additionally validates, beyond
`workspaceId`: the plugin is currently active, the trigger id exists in
its current manifest, and that trigger actually declares `agent` — not
just that the `workspaceId` is valid. Binding an instance to a non-agent
trigger, or a trigger that no longer exists, is rejected the same way an
unknown `workspaceId` already would be.

**No migration is needed for the data itself** — pre-upgrade, every
enabled agent-trigger ran as an implicit, un-tracked, workspaceless
instance, so there's nothing to migrate *into* `TriggerInstanceStore`.
What *is* needed is making the resulting stop visible — see §6's migration
notice, which replaces this section's earlier (reviewer-caught-incorrect)
claim that the empty-panel state alone counts as "visibly stopping."

## 2. Registry & dispatch changes (agent-triggers only)

**Two invocation levels, not one (reviewer-caught, P1).** The original
draft said "for each instance, mint and dispatch" without saying what
happens to the trigger's own manifest handler — and today's code
(`trigger-registry.ts:155-197`) mints exactly **one** `InvocationRecord`
per fire and runs the handler (always present — `handler` is a required
manifest field, `packages/plugin-manifest/src/triggers.ts:45`) and the
agent dispatch under that *same* `invocationId`, sequentially, with the
agent dispatch skipped entirely if the handler throws. Naively fanning out
N times would either re-run the handler's side effects (writing files,
sending notifications) N times, or run it once with no workspace identity
of its own to bill capability calls against. The fix keeps two distinct
kinds of invocation, discriminated at the type level so the ambiguity
can't resurface:

```ts
// src/main/plugins/background-invoker.ts
export type InvocationRecord =
  | {
      actor: "background"
      pluginId: string
      triggerId: string
      invocationId: string
      trigger: string
      signal: AbortSignal
      allowedUses?: TriggerUse[]
      triggerOrigin: symbol
      createdAt: number
    }
  | {
      actor: "background-agent"
      pluginId: string
      triggerId: string
      invocationId: string
      /** Which TriggerInstanceRecord this run belongs to. */
      instanceId: string
      workspaceId: string
      trigger: string
      signal: AbortSignal
      allowedUses?: TriggerUse[]
      triggerOrigin: symbol
      createdAt: number
    }
```

`onFire()` becomes:

1. Admission check (unchanged, trigger-level — see below).
2. Mint **one** event-level `InvocationRecord` (`actor: "background"`, no
   `workspaceId`/`instanceId`) and run the manifest handler under it,
   exactly as today. If the handler throws, record the fault and **stop —
   do not fan out to any instance**, matching today's existing
   fail-together sequencing (not a behavior change, just made explicit).
3. If the handler succeeds and `decl.agent` is present: look up
   `instanceStore.listForTrigger(pluginId, triggerId)`, filter to
   unpaused **and** identity-current instances (§1), and for each
   remaining instance mint its own instance-level `InvocationRecord`
   (`actor: "background-agent"`, real `instanceId` + `workspaceId`) and
   call `dispatchAgent(...)`. These N calls run via `Promise.allSettled()`,
   **not** a plain `await`-in-a-loop or `Promise.all()` — one workspace's
   instance failing (network error, budget exhausted, aborted) must not
   prevent sibling instances in other workspaces from completing. Each
   settlement is recorded/audited independently; a rejected settlement
   records a fault against *that instance* (not the trigger as a whole —
   see the Admission Breaker note below for why trigger-level admission
   state is deliberately not touched here).

`PluginAgentTriggerDispatchRequest` (`src/main/plugins/types.ts:120-130`)
and `BackgroundAgentRunInput` (`background-agent-runner.ts`) both gain
`instanceId: string` and `workspaceId: string` (both required — every real
call into `dispatchAgent`/`BackgroundAgentRunner.run()` now originates
from an instance-level `InvocationRecord`, so there is no "unbound" case
to make these optional for).

**OS-level adapter registration follows instance count, not plugin-enable
state — and both `register()` itself and its incremental counterparts must
be async (reviewer-caught, round 2).** Today, `register(pluginId, triggers):
void` is synchronous and calls the adapter's `register(scope) → Disposable`
unconditionally when a plugin with that trigger is enabled. Querying
`TriggerInstanceStore` (an async store) from inside it means `register()`
itself has to become `async register(...): Promise<void>`, and every
caller — `PluginHost.syncTriggerRegistrations()`, `setEnabled()`, and the
new IPC handlers below — must `await` it; the original draft never said
this explicitly, which would have left the query silently racing ahead of
its result. Going forward, for an agent-trigger, `register()` records the
declaration and admission-breaker config, then queries
`instanceStore.listForTrigger(pluginId, triggerId)` **once, at
registration time** — if any current-identity instance already exists
(e.g. on app restart or plugin re-enable), it calls `adapter.register()`
immediately, exactly as if the first instance had just been added; if
none exist (or all existing ones are stale, per §1), it does not. This
makes restart/re-enable rehydration and live instance creation follow the
same single rule instead of needing separate bootstrap logic.

**The registration criterion is "any current-identity instance exists,"
deliberately ignoring `paused` (reviewer-caught closed-loop gap, round
2).** The original draft said the adapter registers/deregisters on
*unpaused*, current-identity instance count — but `triggers:pause-instance`
/`triggers:resume-instance` (§6) only ever call `TriggerInstanceStore
.setPaused()`, with no corresponding registry notification. Under the
original rule, pausing a trigger's last unpaused instance would leave the
adapter registered forever (nothing ever told the registry the count hit
zero), and resuming a trigger's only instance after all were paused would
never re-register it either — a real dead end. Fixing this by adding
`onInstancePaused`/`onInstanceResumed` registry hooks was one option; the
simpler one, adopted here, is to change the *criterion* instead: adapter
presence tracks "does at least one current-identity instance exist,"
full stop, regardless of pause state. §2's existing fan-out step already
filters to unpaused instances at fire time, so a trigger with every
instance paused still has a registered-but-idle adapter — harmless (an
`fs.watch`/timer firing into an empty fan-out is a no-op), and it avoids
tearing down and rebuilding OS-level resources (file watchers especially)
every time a user toggles a single instance's pause state. `pause`/`resume`
therefore need **no** new registry hooks at all — only `create`/`remove`
do:

```ts
// TriggerRegistry, both async
async onInstanceAdded(pluginId: string, triggerId: string): Promise<void>
async onInstanceRemoved(record: TriggerInstanceRecord): Promise<void>
```

Both hooks are **idempotent** — they re-derive "should the adapter be
registered right now" from `instanceStore.listForTrigger()`'s current
count rather than assuming the caller only invokes them on an actual 0→1
or 1→0 transition. This matters because §6's `create-instance` and
`reactivate-instance` both call `onInstanceAdded` unconditionally after
their own store mutation succeeds, without first checking whether the
trigger already had another current-identity instance — relying on
`onInstanceAdded` itself to no-op safely (not register a second,
leaked `Disposable`) when the adapter is already registered. Same for
`onInstanceRemoved` and `remove-instance`. 0→1 current-identity instances
calls `adapter.register(scope)` and stores the `Disposable`; 1→0 disposes
it; anything else (still ≥1, or already 0) is a no-op. Non-agent triggers
keep registering immediately at enable, as today.

**Per-instance cancellation (reviewer-caught, P1).** The signal hierarchy
gains a level: `pluginController → triggerController → instanceController
→ invocationController` (was `plugin → trigger → invocation`). Each
instance's `AbortController` is created when its runtime is instantiated
(on first admission after the instance is created, or lazily on first
fire — implementation detail for the plan) and chained under the trigger's
controller, same pattern §2's existing `controller.signal.addEventListener
("abort", ...)` chaining already uses one level up.

**Ordering: persist first, then abort (reviewer-caught inconsistency,
round 2 — the round-1 draft said "abort before removing" here but showed
"remove, then notify" in §6's IPC description; these need to agree, and
persisting first is the correct order).** `triggers:remove-instance`
calls `TriggerInstanceStore.remove(id)`, which deletes the record and
returns it. Only if a record was actually returned does the IPC handler
call `TriggerRegistry.onInstanceRemoved(record)`, which (a) aborts that
instance's controller — cancelling any in-flight run, since the
`invocationController` chained underneath aborts too, not just future
fan-out — and (b) re-queries `instanceStore.listForTrigger()` to check
whether any current-identity instance remains; if none do, disposes the
adapter. Persisting the deletion before acting on it means a crash between
the two steps leaves the store as the source of truth (no orphaned record
pointing at a controller that no longer exists) rather than the reverse.
`pause` (`setPaused(id, true)`) does **not** abort the current run — it
only excludes the instance from **future** fan-out; an in-flight run is
allowed to finish. This asymmetry is deliberate: pause is "stop starting
new work," remove is "stop existing work too," matching how `revoke` vs
`disable` already differ for capabilities in the 2026-06-27 trigger spec.

**In-memory instance runtime state, for the panel (reviewer-caught gap,
round 2 — "surfaced in its panel row" had no data source).** A
`TriggerInstanceRecord` only has `paused`; it has no notion of "currently
running," "last outcome," or "last finished at," and the Admission Breaker
deliberately does not track per-instance failures (§ above). `TriggerRegistry`
holds one more piece of purely in-memory, non-persisted state, mirroring
the existing `AdmissionBreaker.status(pluginId, triggerId)` pattern one
level deeper:

```ts
interface TriggerInstanceRuntimeState {
  status: "idle" | "running" | "failed"
  inflight: number
  lastOutcome?: "success" | "failed" | "aborted"
  lastFinishedAt?: number
}
```

Updated by the fan-out step (§2 above): `inflight`/`status: "running"` on
dispatch start, `lastOutcome`/`lastFinishedAt`/`status` on each
`Promise.allSettled()` settlement. Reset (not persisted) on app restart —
this is observability, not durable state, same as `AdmissionBreaker`'s
existing status tracking. `triggers:list-instances` (§6) joins this state
into each row.

**The Admission Breaker stays at the (pluginId, triggerId) level, not
per-instance, and per-instance failures do not feed into it.** Event-storm
coalescing, concurrency caps, and trigger-level fault auto-pause govern
the shared OS event source itself — splitting that per-instance would mean
the same `fs.watch` firing 1000 times/sec gets admitted N times over
(once per instance) instead of once, defeating the point of the breaker.
An individual instance's run failing (step 3 above) is recorded against
that instance (surfaced in its panel row, §6) but does **not** call
`admission.recordFault()` — only a failure in the shared event-level
handler (step 2) does that, since only step 2 shares fate with the OS
registration itself.

## 3. `BackgroundAgentRunner` / `AgentRuntime` wiring

`BackgroundAgentRunInput` gains required `instanceId: string` and
`workspaceId: string` (§2).

**Two separate places need these values, not one (reviewer-caught gap,
round 2 — the round-1 draft only showed the `caller` object, which is not
where `RunTrace.workspaceId` actually comes from).** Verified against
`agent-runtime.ts:257`: `trace.workspaceId` is populated from the
**top-level** `AgentRunOptions.workspaceId`, not from `options.caller
.workspaceId` — these are two different fields that happen to usually
carry the same value on the interactive path, because
`AgentService.chat()` sets both. `BackgroundAgentRunner.run()`'s existing
call to `runtime.run({...})` sets neither today. So `run()`'s call becomes:

```ts
const result = await runtime.run({
  conversationId: input.invocationId,
  messages: [backgroundUserMessage(input)],
  signal: controller.signal,
  runId: start.runId,
  origin: "background-agent",
  workspaceId: input.workspaceId,        // ← drives RunTrace.workspaceId
  triggerInstanceId: input.instanceId,   // ← drives RunTrace.triggerInstanceId, new field, see below
  caller: {
    kind: "background-agent",
    invocationId: input.invocationId,
    runId: start.runId,
    workspaceId: input.workspaceId,        // ← drives capability-call audit, via PluginBridge
    triggerInstanceId: input.instanceId,   // ← ditto, see §5
  },
  approve: () => ({ allowed: this.ledger.tryDebitToolCall(start.runId, input.agent) }),
})
```

`AgentRunOptions` and `RunTrace` (`run-trace-store.ts`) both gain
`triggerInstanceId?: string`, mirroring the existing `workspaceId?: string`
field on each exactly — `recordTrace()` gains one more line,
`if (args.options.triggerInstanceId !== undefined) trace.triggerInstanceId
= args.options.triggerInstanceId`, next to the existing `workspaceId` one
at `agent-runtime.ts:257`.

This is the entire extent of what this spec wires up for trace/audit
attribution. `caller.workspaceId`/`caller.triggerInstanceId` do **not**
flow into memory scoping in any user-visible way this spec delivers,
because — as established in Non-goals — the tool that would consume them
(`memory_save`/recall) is not in this run's tool registry at all.
`scopeForCaller()` would compute the right scope *if* a memory tool call
happened, but no such call can happen today, so this spec does not claim
the memory-scoping behavior as a delivered outcome, only as a
mechanically-true-but-currently-unreachable fact worth noting for whoever
builds the follow-up.

`BackgroundAgentRunnerOptions` gains
`workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">`, used to
resolve the bound workspace's roots before constructing the per-run
`AgentRuntime`.

**A real wiring bug this spec must not introduce**: `AgentRuntime`'s
existing `executionWorkspaces` option (`agent-runtime.ts:87`) drives *two*
things at once — (a) `workspaceInstructionContext()`, which folds
`AGENTS.md`/`CLAUDE.md` into the run via `loadWorkspaceInstructions`, and
(b) `buildSystemPrompt()`'s `executionGuidance()` text, which tells the
model which `rootId`s it may pass to the five execution tools. Reusing
`executionWorkspaces` unmodified for a background-agent run would produce
(a), which is wanted, *and* (b), which is actively wrong — it would tell
the model it can call execution tools that were never registered into its
tool registry. Fix: `AgentRuntime` gets a second, independent option:

```ts
export interface AgentRuntimeOptions {
  // ...existing fields...
  executionWorkspaces?: () => readonly WorkspaceRootRecord[]
  /** Roots to fold into the run as workspace-instructions context, WITHOUT
   *  emitting execution-tool guidance text. Independent of
   *  executionWorkspaces — a run can have one, the other, both, or
   *  neither. */
  workspaceInstructionRoots?: () => readonly WorkspaceRootRecord[]
}
```

`run()` resolves `instructionContext` from
`workspaceInstructionRoots?.() ?? executionWorkspaces?.() ?? []` (so the
interactive path, which only ever sets `executionWorkspaces`, is
byte-for-byte unaffected), while `buildSystemPrompt()`'s call keeps reading
`executionWorkspaces` alone, unchanged. `BackgroundAgentRunner` constructs
its `AgentRuntime` with `workspaceInstructionRoots: () =>
resolvedRoots` and **never sets `executionWorkspaces`** — so a
background-agent run's system prompt gets instruction-folding with zero
execution-tool guidance text, matching the actual (toolless) reality of
its registry.

## 4. Budget accounting gains a workspace dimension

Per the Q&A decision ("每实例独立计算"): the same trigger template bound to
two workspaces must not let one workspace's usage exhaust the other's
allowance. This only applies to instance-level (`actor: "background-agent"`)
calls — event-level handler calls (§2 step 2) have no `workspaceId` to key
on and must keep using today's key shape unchanged, since they're still
shared, single, trigger-level invocations.

`trigger-budget.ts` (reviewer-caught, P2 — the original draft made this
field *required*, which cannot typecheck against the event-level branch
that has no `workspaceId` at all):

```ts
export interface BudgetKey {
  pluginId: string
  triggerId: string
  /** Present only for instance-level (background-agent) debits. */
  workspaceId?: string
  capabilityId: string
  scopeKey: string
}
```

`keyOf()`'s template-string join adds `\0${k.workspaceId ?? ""}` — this
ledger is purely in-memory (`private readonly windows = new Map()`, never
persisted), so reshaping its internal key format has no migration
implications; it only needs to stay internally consistent and
discriminating. `trigger-budget-breaker.ts`'s `createBudgetBreakerPort`
reads `rec.workspaceId` off the resolved `InvocationRecord` — present when
`rec.actor === "background-agent"`, `undefined` otherwise — and includes
it in the `tryDebit` key exactly as returned (no coercion needed now that
the field is optional on both sides).

`agent-budget.ts` (the separate `maxRuns`/`maxTokensPerRun`/
`maxToolCallsPerRun` ledger) is used **exclusively** by
`BackgroundAgentRunner.run()` (`background-agent-runner.ts:50`) — a path
that, per §2, only ever runs for instance-level dispatches. Its key can
therefore stay simple and required, no discriminated-optional treatment
needed here:

```ts
export interface AgentBudgetKey {
  pluginId: string
  triggerId: string
  workspaceId: string   // new, always present — see above
}
```

Budget windows are keyed by `(pluginId, triggerId, workspaceId)`, not
`instanceId` — a deliberate simplification: since `TriggerInstanceStore`
enforces at most one instance per `(pluginId, triggerId, workspaceId)`
triple, `workspaceId` alone already uniquely identifies "the" instance for
budget purposes at any given moment. Removing an instance and creating a
fresh one for the same workspace inherits whatever's left of the old
window rather than resetting it — a minor, low-stakes quirk (this ledger
is already ephemeral and resets on every app restart) not worth
`instanceId`-keying the budget windows to avoid.

## 5. Audit

**No new field needed on `CapabilityAuditEntry` itself (reviewer-caught —
the original draft's "add `workspaceId?: string`" was redundant).**
`CapabilityAuditEntry` (`capability-gate.ts:65-84`) already has
`workspaceId?: string`, and `CapabilityRequest` already has it too
(`capability-gate.ts:38-44`) — this plumbing exists because the
interactive-agent path already populates it from `caller.workspaceId`.
What was actually missing is that trigger-origin calls never had a
`workspaceId` to thread through in the first place; §2/§3 close that.

One field genuinely is new: `triggerInstanceId?: string`, populated
whenever the originating `InvocationRecord` has one (i.e. every
instance-level agent-trigger call, going forward). This is not redundant
with `workspaceId` — an instance can be removed and a new one created for
the same `(pluginId, triggerId, workspaceId)` triple later, and audit
entries from the first instance's lifetime should stay attributable to
that specific instance, not conflate with the second one's. Additive,
optional-on-read, same discipline used for `runId` and spec ③'s
resource-access audit — no rewrite of historical entries.

**Getting `triggerInstanceId` from `caller` to the audit entry requires
mirroring `workspaceId`'s existing threading at every stop along the way
(reviewer-caught gap, round 2 — round 1 only described the destination
field, not the path there).** Verified concretely: `workspaceId` is
already threaded through `ToolCaller.workspaceId`
(`@synapse/plugin-sdk`'s `tools.ts:33`) → `PluginBridge`'s per-call
`invocation` context object (`plugin-bridge.ts:99,102`, built from
`options.caller.workspaceId` at line 238) → every capability adapter's
`ensure()` wrapper (`plugin-bridge.ts:296,307` and the storage/network
adapters at 324/334/676) → `gate.ensure()`'s `CapabilityRequest.workspaceId`
→ `CapabilityAuditEntry.workspaceId`. This is the exact path an agent's
own tool call takes when it invokes a plugin capability during its
reasoning loop (via `AiToolRegistry` → `PluginToolBridge` →
`PluginRegistry.invokeTool` → this same `PluginBridge` machinery) — the
same path an instance-level background-agent run's tool calls take, since
`BackgroundAgentRunner`'s limited tool host is built from the same
`PluginToolBridge`. `triggerInstanceId` needs the identical treatment at
every one of those sites: `ToolCaller.triggerInstanceId?: string` (new,
next to `workspaceId`), threaded into `PluginBridge`'s `invocation` object,
into `CapabilityRequest.triggerInstanceId?: string` (new), into
`CapabilityAuditEntry.triggerInstanceId?: string` (new, as above). This
does **not** touch the separate sandbox ctx-facade path
(`BackgroundInvoker.contextOptions()`, used when a plugin's *own* manifest
handler code calls `ctx.foo()` directly) — that path is exclusively used
by event-level (`actor: "background"`) invocations, which never have an
`instanceId` by construction (§2), so it needs no change.

## 6. IPC & renderer

**Legacy template-level mutation IPC now rejects agent-triggers
(reviewer-caught, P2).** `triggers:pause`/`triggers:resume`/`triggers:kill`
(`src/main/ipc/triggers.ts`) operate on `(pluginId, triggerId)` and, for
`kill`, call `TriggerRegistry.deregisterTrigger()` — which tears down the
adapter registration and clears admission/invoker state but has (and
should keep having) no knowledge of `TriggerInstanceStore`. Left
reachable for agent-triggers, a user (or a future UI bug) calling
`triggers:kill` on one would tear down the shared OS registration while
every `TriggerInstanceRecord` for it stays on disk — orphaned until an app
restart's rehydration (§2) silently re-registers the adapter and resumes
firing, with no record of the kill ever having meant anything. Fix: all
three handlers check `getDeclaration(pluginId, triggerId)?.agent` first
and throw a clear error ("use instance-level controls for agent-triggers")
if present — non-agent triggers are completely unaffected. Plugin
disable/uninstall continue to use `PluginHost`'s internal
`deregisterPlugin()`/`killAllBackground()` directly (as they already do
today — these are not routed through the `triggers:kill` IPC handler in
the first place), so this guard does not block legitimate teardown.

**Disable vs. uninstall handle `TriggerInstanceRecord`s differently**,
matching how capability grants already persist across disable/enable but
not across uninstall: disabling a plugin (`deregisterPlugin()`) tears down
the adapter and aborts in-flight runs (§2) but leaves
`TriggerInstanceRecord`s on disk — re-enabling the same, unchanged plugin
build rehydrates them exactly as before (§2's registration-time query),
so a user toggling a plugin off and back on doesn't lose their bindings.
Uninstalling calls `TriggerInstanceStore.removeForPlugin(pluginId)`
(§1) and, for each returned record, `TriggerRegistry.onInstanceRemoved()`
— a fresh install later is a new plugin from the user's perspective, and
there is nothing to rehydrate into (this parallels `GrantStore` clearing a
plugin's grants on uninstall).

New instance-level IPC surface:

- `triggers:list-instances` (payload `{ pluginId, triggerId }`) →
  `TriggerInstanceRow[]`, each `{ id, workspaceId, workspaceName, paused,
  stale: boolean, status: "idle" | "running" | "failed", budgets:
  TriggerBudgetRow[] }` — `stale` reflects the identity mismatch check
  from §1, `status` is joined from the in-memory
  `TriggerInstanceRuntimeState` (§2); `budgets` computed the same way
  `listTriggers()` computes them today, keyed with the instance's
  `workspaceId` added (§4), `workspaceName` joined from `WorkspaceStore`
  for display.
- `triggers:create-instance` (payload `{ pluginId, triggerId, workspaceId
  }`) → validates, in order: `identityForPlugin(pluginId)` resolves to a
  `GrantIdentity` (i.e. the plugin is currently active — an `undefined`
  result is the failure case, not a separate check), the trigger exists in
  the plugin's current manifest and declares `agent`, and `workspaceId`
  exists (`WorkspaceStore.exists()`) — fail closed on any miss, same
  precedent as the P4 slice's conversation-creation validation. Calls
  `TriggerInstanceStore.create(identity, triggerId, workspaceId)` — the
  resolved `identity`, not a bare `pluginId` (§1) — then
  `await TriggerRegistry.onInstanceAdded(pluginId, triggerId)`.
- `triggers:reactivate-instance` (payload `{ instanceId }`) → re-resolves
  `identityForPlugin(pluginId)` for the stale instance's plugin (fails
  closed the same way if the plugin is no longer active), calls
  `TriggerInstanceStore.reactivate(instanceId, identity)`. Does not touch
  adapter registration — a stale instance being reactivated doesn't change
  whether *some* current-identity instance already existed for the trigger
  (if this was the only instance, it was already excluded from the
  registration-time count while stale, so reactivating brings the count
  from 0→1 — meaning this endpoint calls `onInstanceAdded` too, same as
  `create-instance`, whenever the reactivated instance is the trigger's
  only current-identity one).
- `triggers:pause-instance` / `triggers:resume-instance` (payload `{
  instanceId }`) → `TriggerInstanceStore.setPaused()` only — no registry
  call, per §2's "registration ignores `paused`" rule.
- `triggers:remove-instance` (payload `{ instanceId }`) →
  `TriggerInstanceStore.remove()` (returns the removed record, §1), then —
  if a record was actually removed — `await TriggerRegistry
  .onInstanceRemoved(record)`, which aborts that instance's controller
  and checks whether the adapter should deregister (§2's ordering note:
  persist the deletion first, act on it second). Note `record.identity
  .pluginId`, not `record.pluginId` — `pluginId` lives under the nested
  `identity` object (§1's `TriggerInstanceRecord` shape), a mismatch the
  round-1 draft had in this exact spot.

Standard 4-touchpoint pattern (pure handler → `index.ts` registration →
preload → `lib/electron.ts` wrapper), tests on the pure handlers.

**Renderer — `ActiveBackgroundPanel`**: restructured so an agent-trigger
renders as a template header (type, schedule/scope summary — unchanged
from today) with a nested list of instance rows underneath (workspace
name, per-instance budget usage, paused/active/`needs-review` status,
pause/resume/remove buttons wired to the new IPC), plus an "+ Add to
workspace" action on the header. A `needs-review` instance (stale
identity, §1) renders distinctly from a normal paused one and offers a
"review & re-activate" action instead of resume. Non-agent triggers keep
rendering as today's flat single row, untouched.

**Renderer — `DeclaredTriggersPanel`**: gains one line of copy for
agent-triggers noting that after enabling, this automation must be
individually activated per workspace from the Active Background panel.

**Migration notice (P2, revised again in round 2).** Both of Synapse's
built-in plugins declare an agent-trigger today — `github-inbox`'s
`poll-inbox` (timer) and `downloads-organizer`'s `downloads` (fs.watch),
confirmed in `resources/builtin-plugins/*/synapse.json`. Upgrading a real
existing install therefore silently stops two automations most users
likely have running, not a hypothetical edge case. The Active Background
panel's zero-instance state alone is where a user *discovers* this if
they go looking, but that is not the same as being *told* — most users
won't open that panel unprompted. This spec adds a one-time, dismissible
notice that names the specific agent-triggers that stopped firing,
explains why (workspace binding is now required), and links directly into
the Active Background panel to re-bind them.

**The trigger condition must distinguish a real upgrade from a fresh
install (reviewer-caught, round 2 — "instance store is empty" alone can't
tell them apart).** "Plugin enabled + declares an agent-trigger + zero
`TriggerInstanceStore` records" is satisfied by two completely different
situations: (a) a pre-existing install where the plugin was already
running under the old, un-versioned trigger behavior, or (b) a brand new
install where the user just enabled the plugin for the first time under
*this* version's rules and simply hasn't clicked "add to workspace" yet —
showing "your automation has stopped" in case (b) would be actively false
(nothing was ever running). There is no existing app-wide
"first run"/schema-version marker in this codebase to key off (checked —
`plugin-version.ts` and `plugin-host.ts`'s version tracking are
per-plugin update-detection, not an app-wide fresh-install signal), so
this spec doesn't invent one. Instead it reuses a signal that's already
precisely scoped to the right question: **does this plugin already have
capability grants recorded** (`GrantStore.list(identity)` — non-empty
means the user went through this plugin's consent flow at some point
before right now, which can only be true for a pre-existing install,
since case (b)'s "just enabled it" moment necessarily also *just* created
those grants during the same session). Concretely: the very first time
`TriggerInstanceStore`'s backing JSON file is initialized (i.e. it does
not exist on disk yet — the same one-shot "file absent" check every other
store in this codebase already uses to detect first-ever use), the
initialization step checks every currently-enabled plugin that declares
an agent-trigger; any with a non-empty `GrantStore.list(identity)` is
recorded as "affected" in a small notice-state file:

```ts
// src/main/plugins/trigger-migration-notice.ts
interface TriggerMigrationNoticeState {
  affectedTriggers: Array<{ pluginId: string; triggerId: string }>
  dismissedAt?: number
}
```

Computed exactly once (gated on `TriggerInstanceStore`'s own file not yet
existing, not a separate version counter — there is only ever one thing to
migrate away from, so a dedicated versioning scheme would be
over-engineering for this single case), never recomputed afterward. An
empty `affectedTriggers` array (the fresh-install case) means the panel
shows no notice at all — only a non-empty list renders it, with a
"dismiss" action writing `dismissedAt`. Test descriptions for the
no-data-migration behavior (§7) should be written as "no data migration,
paired with a one-time visible notice computed only for pre-existing
installs" — not "silent stop," which round 1's review correctly flagged
as self-contradictory against the product intent, and not an unconditional
notice either, which would be a fresh-install false positive.

## 7. Testing strategy

- **`trigger-instance-store.test.ts`** (new): create/list/remove
  round-trip; `create()` takes a `GrantIdentity` (not a bare `pluginId`)
  and persists it on the record; `remove()` returns the deleted record,
  `undefined` for an unknown id; `removeForPlugin()` removes every record
  for that plugin across all triggers/workspaces and returns them, leaving
  other plugins' records untouched; `listForTrigger` scopes correctly;
  `create()` throws on a duplicate `(pluginId, triggerId, workspaceId)`
  triple **regardless of whether the existing record is stale or current**
  (staleness is only ever resolved through `reactivate()`, never
  `create()`), including under concurrent calls (two `create()` calls
  racing for the same triple — only one succeeds, verifying
  `runExclusive()` serialization actually prevents the race, not just the
  duplicate check in isolation); `reactivate()` updates `identity` on an
  existing record and throws for an unknown id; `setPaused()` toggles
  without deleting the record.
- **`trigger-registry.test.ts`** (extend): `register()`,
  `onInstanceAdded()`, and `onInstanceRemoved()` are all `async` and every
  production call site (`syncTriggerRegistrations()`, `setEnabled()`, the
  IPC handlers) awaits them — a test using a `TriggerRegistryDeps.invoker`
  with a deliberately slow-resolving `instanceStore` mock catches a
  missing `await` by observing the adapter register/deregister call
  happening *after* the assertion point, not before; an agent-trigger with
  zero current-identity instances never calls `adapter.register()`;
  creating the first instance registers it; removing the last instance
  disposes it; **pausing every instance of a trigger does NOT deregister
  the adapter, and resuming one does NOT re-register it** (registration
  tracks current-identity instance *existence*, not pause state — this is
  the fixed rule from the closed-loop gap, and the fan-out step separately
  still excludes paused instances at fire time, verified by a paused
  instance's OS event landing on a registered-but-idle adapter producing
  zero dispatches); **a fire event with two unpaused instances in
  different workspaces runs the manifest handler exactly once (not twice)
  and dispatches the agent exactly twice, once per instance, with
  distinct `workspaceId`s and `instanceId`s**; a handler that throws
  prevents any agent dispatch (fault recorded, matching today's existing
  sequencing); **one instance's agent dispatch rejecting does not prevent
  a sibling instance's dispatch from completing** (asserts
  `Promise.allSettled` semantics, not `Promise.all`); a paused instance is
  excluded from fan-out but not deleted; a stale-identity instance
  (`identityForPlugin()`'s current result no longer matches the stored
  `identity`) is excluded from fan-out and reported as `needs-review`, not
  silently resumed; removing an instance aborts its in-flight run;
  pausing an instance does **not** abort its in-flight run; a plugin with
  no current `identityForPlugin()` result (disabled/uninstalled) treats
  every one of its instances as stale; `TriggerInstanceRuntimeState` per
  instance transitions `idle → running → (success|failed)` around a fired
  dispatch and is exposed via a query the panel IPC (§6) can read;
  non-agent trigger register/fire behavior is byte-for-byte unchanged
  (explicit regression coverage, not just "no test broke").
- **`trigger-budget.test.ts` / `agent-budget.test.ts`** (extend): two
  instances of the same trigger in different workspaces have fully
  independent counters; event-level (non-instance) debits use the
  pre-existing key shape with no `workspaceId` segment and are unaffected
  by any instance's budget state; repeated fires of the same instance
  share one counter, as today.
- **`background-agent-runner.test.ts`** (extend): the `runtime.run()` call
  is asserted to include **both** the top-level `workspaceId`/
  `triggerInstanceId` options **and** `caller.workspaceId`/
  `caller.triggerInstanceId` (a test that only checked `caller` would have
  passed against the round-1 draft's bug — `RunTrace.workspaceId` reads
  the top-level field, not `caller`'s, per `agent-runtime.ts:257`, so this
  needs its own explicit assertion, not just an assertion on `caller`);
  `AgentRuntime` is constructed with `workspaceInstructionRoots` set and
  `executionWorkspaces` **not** set — assert on the constructed options
  object directly, not just end-to-end behavior, so a future accidental
  re-introduction of `executionWorkspaces` here is caught immediately.
- **`agent-runtime.test.ts`** (extend): a run with only
  `workspaceInstructionRoots` set folds workspace-instructions into the
  message context but the system prompt contains no execution-tool
  guidance text; a run with only `executionWorkspaces` set (today's
  interactive-path shape) is unaffected — both instruction-folding and
  guidance text still appear, proving the split didn't regress the
  existing path; a run with `options.workspaceId`/`options.triggerInstanceId`
  set produces a `RunTrace` carrying both.
- **`plugin-bridge.test.ts`** (extend — new test, closing the §5 threading
  gap): a capability call made with `caller.triggerInstanceId` set
  produces a `CapabilityAuditEntry.triggerInstanceId` equal to it, via the
  exact same `invocation`-object threading `workspaceId` already uses
  (`plugin-bridge.ts:99,102,238` and each adapter's `ensure()` call) — not
  a new, parallel mechanism.
- **`ipc/triggers.test.ts`** (extend): `triggers:create-instance` resolves
  `identityForPlugin(pluginId)` and passes the resulting `GrantIdentity`
  (not a bare `pluginId`) into `TriggerInstanceStore.create()`; rejects an
  inactive plugin (`identityForPlugin` returns `undefined`), an unknown
  `workspaceId`, an unknown trigger id, and a trigger without `agent`;
  rejects a duplicate instance; `triggers:reactivate-instance` updates a
  stale instance's identity and, when it was the trigger's only instance,
  triggers the same `onInstanceAdded` adapter-registration path
  `create-instance` does; `triggers:pause`/`resume`/`kill` reject when the
  target trigger declares `agent`, with non-agent triggers unaffected; the
  new handlers validate payload shape the same way the existing four do.
- **Regression / upgrade scenario**: a plugin manifest declares an
  agent-trigger, the plugin is "enabled" (capability grants present) but
  `TriggerInstanceStore` is empty — assert the adapter's `register()` is
  never called and `triggers:list-instances` reports zero active
  instances.
- **Migration notice — upgrade vs. fresh install (reviewer-caught, round
  2, replacing round 1's under-specified version of this test)**: (a) a
  plugin with an agent-trigger and an existing, non-empty `GrantStore`
  grant, `TriggerInstanceStore`'s file not yet created — the notice-state
  computation includes that trigger in `affectedTriggers`; (b) the same
  setup but with an empty `GrantStore` for that plugin (simulating a fresh
  install where the plugin was just enabled this session) —
  `affectedTriggers` is empty and no notice condition is satisfied; (c)
  the computation runs exactly once — a second app start with
  `TriggerInstanceStore`'s file now present does not recompute or
  re-populate `affectedTriggers` even if the plugin is later disabled and
  re-enabled.
- **Identity staleness**: an instance created against manifest version A,
  then the plugin updates to manifest version B (different
  `capabilityDeclarationHash`, reflected in a new `identityForPlugin()`
  result) — the instance is excluded from fan-out and reported
  `needs-review`; `reactivate()` with the current identity clears the
  stale state and, if it was the trigger's only instance, re-triggers
  adapter registration; a plugin that becomes inactive
  (`identityForPlugin()` returns `undefined`) makes every one of its
  instances stale too, not just ones with a hash mismatch.

## 8. Parked questions (surfaced, not solved)

- **A real capability/budget model for memory tools**, so a future spec
  can safely expose `memory_save`/recall to workspace-bound agent-trigger
  instances without the vacuous-`uses[]`-pass problem described in
  Non-goals. This spec's `caller.workspaceId` plumbing is the prerequisite
  that follow-up will build on.
- **Execution-tool access for agent-trigger instances** — same shape of
  follow-up, same prerequisite.
- **Whether the Admission Breaker should ever become per-instance** (e.g.
  if one workspace's instance is misbehaving and should fault-pause
  without affecting siblings) — kept trigger-level for this spec since the
  shared OS resource makes per-instance admission semantically murky;
  revisit only if a real fault-isolation need surfaces in practice.
- **Exact visual placement of "+ Add to workspace"** and the migration
  notice's exact copy/dismissal UX — implementation-plan-level UI
  decisions, not re-litigated here (same treatment as ①'s "Manage roots"
  placement).
