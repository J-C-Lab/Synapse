# Trigger → Workspace Binding

> Date: 2026-07-11 · Status: draft, pending review
> Fourth and final part of the four-part workspace-unification decomposition
> (① workspace-root-unification, merged [PR #40](https://github.com/J-C-Lab/Synapse/pull/40);
> ② host-resource-approval infrastructure, merged [PR #41](https://github.com/J-C-Lab/Synapse/pull/41);
> ③ workspace-instructions MCP resource, merged [PR #42](https://github.com/J-C-Lab/Synapse/pull/42)).
> Explicitly independent of ①–③ — flagged in ①'s spec as needing "a
> per-trigger settings layer/store from scratch," verified at the time to
> exist nowhere (manifest, `TriggerRuntime`, `InvocationRecord`, or
> renderer). Decided by interactive user Q&A on 2026-07-11, same process
> used for the prior three specs.

## Why this is needed

Verified against the real code, not assumed:

- **Only agent-triggers (a manifest trigger with an `agent` block) ever
  produce an `AgentRuntime.run()` call.** `TriggerRegistry.onFire()`
  (`trigger-registry.ts:164-197`) branches on `decl.agent`: without it, the
  trigger's manifest-named handler runs directly in the sandbox with no
  `caller` concept at all. With it, `PluginHost.dispatchBackgroundAgent()`
  constructs a `BackgroundAgentRunner` whose `run()`
  (`background-agent-runner.ts:94-98`) builds
  `caller: { kind: "background-agent", invocationId, runId }` — **no
  `workspaceId` field exists anywhere in this path today.** This spec is
  therefore scoped entirely to agent-triggers; plain (non-agent) triggers
  are untouched throughout.
- **Every agent-trigger run today is invisibly global-scoped.**
  `scopeForCaller()` (`memory-scope.ts:24-27`) falls through to
  `{ visibility: "global" }` whenever `caller.workspaceId` is absent — so
  any `memory_save`/recall a background agent performs today pollutes (or
  reads) the global scope, not any particular workspace, purely as a side
  effect of nothing ever populating the field.
- **Execution tools remain, and stay, completely unreachable from any
  trigger.** `PluginHost`'s `this.tools` (`plugin-host.ts:270`) is a
  `PluginToolBridge` wrapping only the plugin registry — `list_files`,
  `read_file`, `search_files`, `apply_patch`, `run_command` are never
  registered into it. This spec does not change that; see Non-goals.

## Guiding principle

**A manifest-declared agent-trigger is a template, not a runnable thing by
itself.** Binding it to a workspace creates a long-lived **instance** — the
unit that actually fires, runs, consumes budget, and is individually
pausable/killable. A trigger template can have zero, one, or many
instances, each bound to exactly one workspace, at most one instance per
(template, workspace) pair. The same automation can run independently in
several workspaces without the user re-editing a single shared binding
every time they switch context — the whole reason this model was chosen
over "one workspace per trigger" during Q&A.

Non-agent triggers are **entirely out of scope** for this spec: they keep
registering automatically at plugin-enable time exactly as today, with no
instance concept, no workspace binding, no behavior change.

## Non-goals (explicitly deferred)

- **Execution tool access for agent-trigger instances.** Binding a trigger
  to a workspace grants it that workspace's memory scope and
  workspace-instructions only — not `list_files`/`read_file`/`run_command`
  against the workspace's roots. Decided explicitly during Q&A: the smaller
  slice ships first; execution-tool access for triggers would require
  redesigning how `uses[]` declares tool-level capabilities (today's five
  execution tools declare no `capabilities` at all, so the existing
  `toolCapabilitiesAllowed` filter in `background-agent-runner.ts` would
  exclude them outright regardless of workspace binding) — a separate spec
  if ever needed.
- **Per-instance schedule/scope customization.** `schedule`/`scope` stay
  template-level (manifest-declared), identical for every instance of a
  trigger — an instance only chooses *which workspace*, never *when* or
  *what* the trigger watches.
- **A bulk "kill all instances across all workspaces" UI action.** The user
  removes instances individually, or disables the whole plugin (which
  already tears down every trigger and every instance via
  `PluginHost.killAllBackground()`/`deregisterPlugin()`).
- **Exact visual placement of the "+ Add to workspace" affordance** in the
  Active Background panel — left to the implementation plan, same as ①'s
  parked "Manage roots" placement decision.
- **Any change to `McpClientManager`/`exposedExecutionRootIds`** or the
  external-MCP-caller path — unrelated axis, untouched.

## 1. Data model

New store, structurally identical in spirit to `WorkspaceRootStore`:

```ts
// src/main/plugins/trigger-instance-store.ts
export interface TriggerInstanceRecord {
  /** Host-generated (crypto.randomUUID()), stable for the record's lifetime. */
  id: string
  pluginId: string
  triggerId: string
  workspaceId: string
  /** true = record persists but is excluded from fan-out on fire. */
  paused: boolean
  createdAt: number
}

export class TriggerInstanceStore {
  async listAll(): Promise<TriggerInstanceRecord[]>
  async listForTrigger(pluginId: string, triggerId: string): Promise<TriggerInstanceRecord[]>
  /** Throws if an instance already exists for this exact
   *  (pluginId, triggerId, workspaceId) triple — at most one instance per
   *  (template, workspace) pair, matching the product model: rebinding the
   *  same automation to the same workspace a second time is not a new
   *  parallel state, it's a no-op the UI should just not offer. */
  async create(pluginId: string, triggerId: string, workspaceId: string): Promise<TriggerInstanceRecord>
  async setPaused(id: string, paused: boolean): Promise<void>
  /** Deletes the record. Callers (TriggerRegistry) are responsible for
   *  deregistering the underlying OS adapter if this was the last instance
   *  for its (pluginId, triggerId) — the store itself has no knowledge of
   *  adapters. */
  async remove(id: string): Promise<void>
}
```

Plain JSON file under `userDataDir/ai/`, following `WorkspaceRootStore`'s
existing conventions (own file, atomic read/write helpers).

**No migration is needed.** Pre-upgrade, every enabled agent-trigger ran as
an implicit, un-tracked, workspaceless instance — there is nothing to
migrate *into* `TriggerInstanceStore`, because the new registration rule in
§2 (register the OS adapter only once an instance exists) already produces
the desired post-upgrade state on its own: an empty store means zero
instances means the adapter never registers, so the trigger simply stops
firing until the user explicitly re-creates an instance. This was a
deliberate Q&A decision (over auto-migrating into a `default`-workspace
instance) — a background automation silently changing what workspace it
operates in on upgrade was judged worse than it visibly stopping and
prompting the user to rebind.

## 2. Registry & dispatch changes (agent-triggers only)

`TriggerRegistry` (`src/main/plugins/trigger-registry.ts`) changes, gated
entirely on `decl.agent` being present — the non-agent branch (today's
`register()`/`onFire()` behavior) is untouched:

- **OS-level adapter registration follows instance count, not plugin-enable
  state.** Today, `register()` calls the adapter's `register(scope) →
  Disposable` unconditionally when a plugin with that trigger is enabled.
  Going forward, for an agent-trigger, `register()` records the declaration
  and admission-breaker config, then queries
  `instanceStore.listForTrigger(pluginId, triggerId)` **once, at
  registration time** — if any instance already exists (e.g. on app restart
  or plugin re-enable, when instances created in a previous session are
  still on disk), it calls `adapter.register()` immediately, exactly as if
  the first instance had just been added; if none exist, it does not. This
  makes restart/re-enable rehydration and live instance creation follow the
  same single rule instead of needing separate bootstrap logic. From then
  on, a new `TriggerRegistry.onInstanceAdded(pluginId, triggerId)` /
  `onInstanceRemoved(pluginId, triggerId)` pair (called by the IPC layer
  around `TriggerInstanceStore.create()`/`remove()`) transitions the
  adapter registration incrementally: 0→1 instances calls
  `adapter.register(scope)` and stores the `Disposable`; 1→0 disposes it.
  Non-agent triggers keep registering immediately at enable, as today.
- **`onFire()` fans out per instance.** For an agent-trigger, instead of
  minting one invocation, `onFire()` now calls
  `instanceStore.listForTrigger(pluginId, triggerId)`, filters out paused
  records, and for each remaining instance independently calls
  `invoker.mint({ ..., workspaceId: instance.workspaceId })` followed by
  its own `dispatchAgent(...)` call — one fire event can produce N
  independent runs, each with its own `caller.workspaceId`, own budget
  debit, own audit entry. A trigger with zero unpaused instances fires the
  adapter event and fans out to nothing (a harmless no-op, not an error).
- **The Admission Breaker stays at the (pluginId, triggerId) level, not
  per-instance.** Event-storm coalescing, concurrency caps, and fault
  auto-pause govern the shared OS event source itself — splitting that
  per-instance would mean the same `fs.watch` firing 1000 times/sec gets
  admitted N times over (once per instance) instead of once, defeating the
  point of the breaker. This is unchanged from today's design; only the
  post-admission fan-out is new.

`BackgroundInvoker` (`src/main/plugins/background-invoker.ts`): `MintInput`
and `InvocationRecord` gain a required `workspaceId: string` for the
agent-trigger path (every real instance has one by construction — there is
no more "unbound" agent-trigger invocation once this ships).

## 3. `BackgroundAgentRunner` / `AgentRuntime` wiring

`BackgroundAgentRunInput` (`src/main/ai/background-agent-runner.ts`) gains
a required `workspaceId: string`. `run()`'s `caller` becomes:

```ts
caller: {
  kind: "background-agent",
  invocationId: input.invocationId,
  runId: start.runId,
  workspaceId: input.workspaceId,
}
```

No change needed to `scopeForCaller()` — it already turns any present
`caller.workspaceId` into `{ visibility: "workspace", workspaceId }`, so
`memory_save`/recall become workspace-scoped for free.

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
tool registry (§ above, Non-goals). Fix: `AgentRuntime` gets a second,
independent option:

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
allowance.

`trigger-budget.ts`:

```ts
export interface BudgetKey {
  pluginId: string
  triggerId: string
  workspaceId: string   // new
  capabilityId: string
  scopeKey: string
}
```

`keyOf()`'s template-string join gains a `\0${k.workspaceId}` segment.
`trigger-budget-breaker.ts`'s `createBudgetBreakerPort` reads
`rec.workspaceId` off the resolved `InvocationRecord` (§2) and includes it
in the `tryDebit` key.

`agent-budget.ts` (the separate `maxRuns`/`maxTokensPerRun`/
`maxToolCallsPerRun` ledger, keyed only by `{ pluginId, triggerId }` today)
gets the same treatment:

```ts
export interface AgentBudgetKey {
  pluginId: string
  triggerId: string
  workspaceId: string   // new
}
```

`BackgroundAgentRunner.run()`'s `this.ledger.tryStart(...)` call passes
`workspaceId: input.workspaceId` alongside the existing two fields.

Non-agent triggers are unaffected — they never call
`BudgetLedger`/`AgentBudgetLedger` with a `workspaceId` because they have
no instance concept; their existing budget keys are unchanged (this spec
does not touch the non-agent code path in either ledger's call sites).

## 5. Audit

Trigger-origin capability calls already flow through
`capability-audit.ts` with a `triggerId` field
(2026-06-27 spec, §4). This spec adds one optional field,
`workspaceId?: string`, populated whenever the originating
`InvocationRecord` has one (i.e. every agent-trigger call, going forward) —
additive-optional-on-read, same discipline used for `runId` and for spec
③'s resource-access audit; no rewrite of historical entries.

## 6. IPC & renderer

New instance-level IPC surface, parallel to the existing template-level
`triggers:list/pause/resume/kill` (`src/main/ipc/triggers.ts`), which stays
completely unchanged and continues to serve non-agent triggers (and
plugin-wide teardown) exactly as today:

- `triggers:list-instances` (payload `{ pluginId, triggerId }`) →
  `TriggerInstanceRow[]`, each `{ id, workspaceId, workspaceName, paused,
  budgets: TriggerBudgetRow[] }` — `budgets` computed the same way
  `listTriggers()` computes them today, just keyed with the instance's
  `workspaceId` added, and `workspaceName` joined from `WorkspaceStore` for
  display.
- `triggers:create-instance` (payload `{ pluginId, triggerId, workspaceId
  }`) → validates `workspaceId` against `WorkspaceStore.exists()` (fail
  closed on an unknown id, same precedent as the P4 slice's
  conversation-creation validation), calls
  `TriggerInstanceStore.create()`, then `TriggerRegistry.onInstanceAdded()`.
- `triggers:pause-instance` / `triggers:resume-instance` (payload `{
  instanceId }`) → `TriggerInstanceStore.setPaused()`.
- `triggers:remove-instance` (payload `{ instanceId }`) →
  `TriggerInstanceStore.remove()`, then
  `TriggerRegistry.onInstanceRemoved()`.

Standard 4-touchpoint pattern (pure handler → `index.ts` registration →
preload → `lib/electron.ts` wrapper), tests on the pure handlers.

**Renderer — `ActiveBackgroundPanel`** (`src/renderer/src/components/plugins/active-background-panel.tsx`):
restructured so an agent-trigger renders as a template header (type,
schedule/scope summary — unchanged from today) with a nested list of
instance rows underneath (workspace name, per-instance budget usage,
paused/active status, pause/resume/remove buttons wired to the new IPC),
plus an "+ Add to workspace" action on the header that opens a workspace
picker (reusing the `ai:list-workspaces` IPC already used by
`workspace-switcher.tsx`). A template with zero instances shows the header
with an empty instance list and the same "+ Add to workspace" affordance —
this is also what every pre-existing agent-trigger looks like immediately
after upgrading (§1's "no migration" note), so it doubles as the natural,
un-fancy way a user notices "this automation isn't running anymore, here's
how to turn it back on." Non-agent triggers keep rendering as today's flat
single row, untouched.

**Renderer — `DeclaredTriggersPanel`** (pre-enable consent review): gains
one line of copy for agent-triggers only, noting that after enabling, this
automation must be individually activated per workspace from the Active
Background panel. No flow change — the panel still only collects the
existing capability/budget consent at enable time; workspace binding
stays a separate, repeatable action, per the Q&A decision that binding
should not be re-litigated every time a plugin is enabled.

## 7. Testing strategy

- **`trigger-instance-store.test.ts`** (new): create/list/remove
  round-trip; `listForTrigger` scopes correctly; `create()` throws on a
  duplicate `(pluginId, triggerId, workspaceId)` triple; `setPaused()`
  toggles without deleting the record.
- **`trigger-registry.test.ts`** (extend): an agent-trigger with zero
  instances never calls `adapter.register()`; creating the first instance
  registers it; removing the last instance disposes it; a fire event with
  two unpaused instances in different workspaces mints two invocations
  with distinct `workspaceId`s and dispatches twice; a paused instance is
  excluded from fan-out but not deleted; non-agent trigger register/fire
  behavior is byte-for-byte unchanged (explicit regression coverage, not
  just "no test broke").
- **`trigger-budget.test.ts` / `agent-budget.test.ts`** (extend): two
  instances of the same trigger in different workspaces have fully
  independent counters (draining one's budget doesn't affect the other's);
  repeated fires of the same instance share one counter, as today.
- **`background-agent-runner.test.ts`** (extend): `caller.workspaceId`
  equals `input.workspaceId`; `AgentRuntime` is constructed with
  `workspaceInstructionRoots` set and `executionWorkspaces` **not** set —
  assert on the constructed options object directly, not just end-to-end
  behavior, so a future accidental re-introduction of `executionWorkspaces`
  here is caught immediately.
- **`agent-runtime.test.ts`** (extend): a run with only
  `workspaceInstructionRoots` set folds workspace-instructions into the
  message context but the system prompt contains no execution-tool
  guidance text; a run with only `executionWorkspaces` set (today's
  interactive-path shape) is unaffected — both instruction-folding and
  guidance text still appear, proving the split didn't regress the
  existing path.
- **`ipc/triggers.test.ts`** (extend): `triggers:create-instance` rejects
  an unknown `workspaceId`; rejects a duplicate instance; the four new
  handlers validate payload shape the same way the existing four do.
- **Regression / upgrade scenario**: a plugin manifest declares an
  agent-trigger, the plugin is "enabled" (capability grants present) but
  `TriggerInstanceStore` is empty — assert the adapter's `register()` is
  never called and `listTriggers`/`triggers:list-instances` reports zero
  active instances, proving the no-migration story in §1 actually produces
  the intended silent-stop behavior rather than an exception or a stuck
  half-registered state.

## 8. Parked questions (surfaced, not solved)

- **Execution-tool access for agent-trigger instances** — explicitly
  deferred (Non-goals); would need its own spec once/if execution tools
  ever gain `capabilities` declarations `uses[]` could reference.
- **Whether the Admission Breaker should ever become per-instance** (e.g.
  if one workspace's instance is misbehaving and should fault-pause without
  affecting siblings) — kept trigger-level for this spec since the shared
  OS resource makes per-instance admission semantically murky; revisit only
  if a real fault-isolation need surfaces in practice.
- **Exact visual placement of "+ Add to workspace"** in the Active
  Background panel — implementation-plan-level UI decision, not
  re-litigated here (same treatment as ①'s "Manage roots" placement).
