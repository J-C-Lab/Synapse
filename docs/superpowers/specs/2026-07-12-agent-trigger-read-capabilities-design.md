# S07 — Agent-trigger Governed Read Capabilities

> Date: 2026-07-12 · Status: draft, pending review
> First spec of Phase 3 ("先可观察，再扩权") in the four-phase, ten-spec
> roadmap (S01-S10), depending on S04 (RunProvenance Consolidation), S05
> (Workspace Lifecycle) and S06 (Run Observatory) — all three merged to
> `main`. Full roadmap status tracked in project memory
> `s01-s10-roadmap-status.md`.

## Why this is needed

Verified against the real repo, not assumed.

- **A background-agent trigger instance today can call only plugin-manifest
  tools — zero host tools.** Confirmed by tracing the full dispatch chain:
  `TriggerRegistry.onFire` (`src/main/plugins/trigger-registry.ts:274-413`)
  calls `this.deps.dispatchAgent!(...)` with `allowedUses: decl.uses`, wired
  in production to `PluginHost.dispatchBackgroundAgent()`
  (`src/main/plugins/plugin-host.ts:455-481`), which constructs a
  `BackgroundAgentRunner` with **`tools: this`** (line 463) — the
  `PluginHost` instance itself. `BackgroundAgentRunner.limitedTools()`
  (`src/main/ai/background-agent-runner.ts:122-132`) wraps that and filters
  by `toolCapabilitiesAllowed()`, but `PluginHost.listTools()`
  (`plugin-host.ts:446-448`) only ever delegates to
  `PluginRegistry.listTools()` — tools with `provenance: "plugin"` from
  active plugin manifests. `MemoryToolSource` and `ExecutionToolHostSource`
  are never composed into `PluginHost`'s tool surface; they only exist in
  the separate `CompositeToolHost` built in `src/main/index.ts:921-951` for
  the **interactive** chat path. This is a structural gap — wiring
  memory/execution into the background-agent path requires plumbing a new
  `ToolHostPort` composition, not adding a capability id to an existing one.
- **The workspace-scoping mechanism these two capabilities need already
  exists end-to-end and is unused.** `TriggerInstanceRecord.workspaceId`
  (`src/main/plugins/trigger-instance-store.ts:5-12`) is mandatory — every
  instance is bound to exactly one workspace at creation
  (`plugin-host.ts:498-510`). That id already flows through
  `TriggerRegistry.onFire` → `dispatchBackgroundAgent` →
  `BackgroundAgentRunner.run()` → `buildBackgroundAgentRun({workspaceId,
  triggerInstanceId, ...})` (`run-provenance.ts:65-79`) → `toToolCaller()`
  (`run-provenance.ts:120-132`), producing a `ToolCaller{kind:
  "background-agent", workspaceId, triggerInstanceId, runId, invocationId}`
  for every tool call `AgentRuntime` makes inside that run
  (`agent-runtime.ts:280`). Both destination tool families already consume
  `caller.workspaceId` correctly: `memory-scope.ts`'s
  `queryScopeForCaller(caller, includeGlobal)` (lines 30-39) scopes
  `memory_search`/`memory_list` to that workspace (plus global-visibility
  entries, per this spec's decision below);
  `ExecutionToolHostSource.invokeTool()`
  (`execution-tool-host.ts:146-248`) resolves
  `roots = workspaceRoots.listForWorkspace(caller.workspaceId)` (line 169)
  and enforces path containment via `WorkspacePolicy.resolvePath()`
  (`workspace-policy.ts:8-27`) — real, tested fencing, not advisory. None of
  this needs to be built; it only needs to be *reached*.
- **Capability declaration and budget metering are already fully generic —
  but nothing calls them for host tools.** `TriggerUse`
  (`packages/plugin-manifest/src/triggers.ts:31-35`) is `{capability,
  scope?, budget}`, validated against a single central capability registry
  (`packages/plugin-manifest/src/capabilities.ts:65-90`, 14 existing ids —
  neither `memory:read` nor `execution:read` exists yet). The budget ledger
  (`trigger-budget.ts`'s `BudgetLedger`, `trigger-budget-breaker.ts`'s
  `createBudgetBreakerPort()`) is capability-id-agnostic — confirmed by
  reading `tryDebit()` (`trigger-budget-breaker.ts:26-47`), which resolves
  `pluginId`/`triggerId`/`workspaceId`/`allowedUses` purely from
  `invocationIdOf(request.invocation)` looked up in the `BackgroundInvoker`
  — no new ledger infrastructure needed. **But this only fires through
  `CapabilityGate.ensure()`** (`capability-gate.ts:115-221`), and nothing in
  the background-agent dispatch path ever calls it for host tools: neither
  `BackgroundAgentRunner.limitedTools()`'s `invokeTool` (line 130, a bare
  pass-through to `this.options.tools.invokeTool`) nor
  `PluginToolBridge.invoke()` (`plugin-tool-bridge.ts:60-68`, used for
  today's plugin tools) calls `ensure()`. For plugin tools, gating happens
  because the plugin's *own sandboxed handler code* calls a capability
  method that crosses into `PluginBridge`, which does call `ensure()`
  (`plugin-bridge.ts:240-262`'s `gateFor()`). Memory/execution are
  host-native functions with no such intermediary — simply tagging their
  tool descriptors with a capability id would make `toolCapabilitiesAllowed`
  filter *visibility* correctly (an instance without the capability in
  `uses[]` wouldn't see the tool), but would never check a standing grant,
  debit `uses[].budget`, or write a capability-audit entry. **This is the
  central design problem this spec solves — not "add two tool sources," but
  "add a governance-wrapping layer that makes host tools go through the same
  `CapabilityGate.ensure()` real plugin capability calls already go
  through."**
- **`CapabilityGate.ensure()`'s trigger-origin branch is exactly the
  semantics this spec needs, already built.** Read in full
  (`capability-gate.ts:141-168`): for a trigger-origin call (detected via
  `budgetBreaker.isTriggerOrigin(invocationIdOf(request.invocation))`), a
  non-`auto`-tier capability requires `grants.isGranted(...)` to already be
  true — **"not granted at enable time," no JIT prompt, no per-call
  approve** (the file's own doc comment, lines 9-13, states this
  explicitly) — then `budgetBreaker.tryDebit(request)`, denying
  `"not-in-uses"` or `"exhausted"` as appropriate, then emits an audit entry
  either way. This is precisely "enable-time consent, runtime budget
  enforcement, always audited" — nothing new to build here, only to reach.

## Architecture

### New capability ids: `memory:read`, `execution:read`

Both added to the central registry (`packages/plugin-manifest/src/capabilities.ts`),
alongside the existing 14:

```ts
{ id: "memory:read", tier: "consent", scopeEnforced: false }
{ id: "execution:read", tier: "consent", scopeEnforced: false }
```

- **`consent` tier, not `auto` or `elevated`.** A background trigger reading
  workspace files/memory unattended is more sensitive than `notification`
  (`auto`) but doesn't need `network:https`-style per-call reapproval
  (`elevated`) given it's read-only and already hard-fenced by
  `WorkspacePolicy`/`memory-scope.ts`'s workspace boundary. Per
  `capability-gate.ts:145-154`'s trigger-origin branch, `consent` for a
  trigger-origin call means **grant-at-enable-time, not JIT-prompt-at-first-
  use**: every subsequent fire debits budget silently once granted, no
  runtime prompt. **This grant-at-enable-time promise is not actually
  enforced by anything today, for any existing trigger capability** — see
  "Explicit confirmation gate," below, for why `memory:read`/`execution:read`
  cannot simply reuse the existing (broken) auto-grant path the other 14
  capabilities use.
- **Unscoped (`scopeEnforced: false`).** The boundary isn't "which
  paths/hosts can this plugin touch" (that's what `scope` encodes for
  `fs:read`/`network:https`) — it's "which workspace is this trigger
  instance bound to," which comes for free from
  `TriggerInstanceRecord.workspaceId` → `ToolCaller.workspaceId`, not from
  anything a manifest author declares. A plugin author opts an agent-trigger
  into these exactly like any other capability:
  ```ts
  uses: [
    { capability: "memory:read", budget: { maxCalls: 20, period: "1h" } },
    { capability: "execution:read", budget: { maxCalls: 20, period: "1h" } },
  ]
  ```
  `PluginBridge.gateFor()`'s default `declared` parameter already merges
  `uses[]` into the gate's declared-capability set via
  `mergeDeclaredWithTriggerUses(manifest.capabilities, manifest.triggers)`
  (`plugin-bridge.ts:236-239`, `784`) — no separate top-level `capabilities`
  entry is required.
- **`memory:read` grants read access to the instance's bound workspace's
  memory *and* global-visibility memory** (not other workspaces' scoped
  memory). This matches `queryScopeForCaller`'s existing default
  (`includeGlobal: true`, `memory-scope.ts:30-39`) and the interactive
  agent's own behavior today — global memory is, by construction, meant to
  be visible everywhere, so this isn't "cross-workspace" access in the
  sense this spec's non-goals exclude. The consent-grant UI copy must say
  so explicitly ("can read this workspace's memory and global memory"), not
  merely "workspace memory."

### Explicit confirmation gate — a real, verified pre-existing gap

**Confirmed during review, not assumed.** Every existing `consent`/
`elevated` trigger capability is silently auto-granted today, with no real
user confirmation ever required. Traced end-to-end: `PluginRegistry.
addDiscoveredPlugin()` (`plugin-registry.ts:339-346`) sets a newly-loaded
plugin's status to `"active"` by default — both at startup (`registry.
load()`) and on a fresh install — with no confirmation gate. `PluginHost.
init()` then unconditionally calls `syncTriggerRegistrations()`
(`plugin-host.ts:327`), which calls `ensureTriggerUseGrants()` →
`grantTriggerUses()` (`trigger-grants.ts:43-60`) for every active plugin;
that function unconditionally writes `grants.grant(identity, id, "user",
scope)` for every non-`auto`-tier `uses[]` entry it finds, no prompt, no
confirmation. The real `DeclaredTriggersPanel` + Enable Confirm dialog
(`plugins-page.tsx:226,492`) genuinely exists and genuinely shows the
declared triggers/capabilities/budgets before granting — but it only fires
on the *manual* "toggle a disabled plugin back to enabled" action. A fresh
install (which defaults straight to `"active"`) and every app restart
(which re-syncs already-active plugins) never route through it.

This is a real, systemic gap affecting all 14 existing capabilities, not
something this spec introduces. Fixing it generally — building a real
confirmation state machine for every trigger capability — is out of scope
for S07 (see Non-goals); it would be a separate, independently-scoped spec.
Instead, S07 adds a **narrow confirmation gate scoped to exactly these two
new capability ids**, leaving the other 14's existing (silent-auto-grant)
behavior completely unchanged:

1. The capability registry entry gains a new field,
   `requiresExplicitTriggerConfirmation?: boolean` — `true` only for
   `memory:read`/`execution:read`, absent (falsy) for the existing 14.
2. `grantTriggerUses()` (`trigger-grants.ts:43-60`) is amended: before
   auto-granting a `use`, it checks
   `getCapability(use.capability)?.requiresExplicitTriggerConfirmation !==
   true`. Capabilities with that flag are simply skipped by the automatic
   sync path — left ungranted, exactly as if the plugin never declared
   them, until something else grants them.
3. Nothing else needs to change in `CapabilityGate.ensure()`. Its existing
   trigger-origin branch (`capability-gate.ts:145-154`) already denies an
   ungranted non-`auto` capability with `"not granted at enable time"` and
   writes an audit entry — this is exactly the correct fail-closed behavior
   once auto-grant no longer silently satisfies it. No new denial logic is
   needed; the base handler side of a trigger (non-agent dispatch) is
   completely unaffected either way, since `memory:read`/`execution:read`
   only ever gate the agent-dispatch tool calls this spec adds, per Non-goals.
4. A new pure function, `pendingCapabilityConfirmations(manifest,
   isGranted)` (`src/main/plugins/trigger-grants.ts`), walks a plugin
   manifest's triggers' `uses[]`, filters to
   `requiresExplicitTriggerConfirmation` capabilities not yet granted for
   that identity, and **deduplicates by capability id** — a plugin whose
   manifest declares `memory:read` on two different triggers reports it
   once, with both trigger ids attached for display, not two duplicate rows:
   ```ts
   interface PendingTriggerCapability {
     capabilityId: string
     triggerIds: string[]
   }
   function pendingCapabilityConfirmations(
     manifest: PluginManifest,
     isGranted: (capabilityId: string) => Promise<boolean>
   ): Promise<PendingTriggerCapability[]>
   ```
   No new persisted state — "pending" is always computed live from the
   manifest + `GrantStore`, unlike `TriggerMigrationNotice`'s file-backed
   dismissal state (that mechanism solves a different problem, remembering
   an already-handled one-time migration; there's nothing to "dismiss"
   here — an ungranted capability stays pending until the user acts,
   indefinitely, by design).

5. **Renderer cannot write grants directly — this is a privilege-escalation
   surface, not a display concern.** The first draft said the confirm
   dialog "calls `GrantStore.grant()` directly," which would let a
   compromised or buggy renderer submit an arbitrary `{pluginId,
   capabilityIds}` pair and have it granted verbatim — for a manifest that
   never declared the capability, a capability that doesn't require
   explicit confirmation at all, a stale identity from before a manifest
   update, or a disabled/unknown plugin. The renderer never touches
   `GrantStore` — it only calls two new host-owned `PluginHost` methods,
   IPC-exposed behind the existing trusted-sender guard:
   ```ts
   // PluginHost
   async listPendingTriggerCapabilityConfirmations(): Promise<
     { pluginId: string; capabilities: PendingTriggerCapability[] }[]
   >

   async confirmTriggerCapabilities(input: {
     pluginId: string
     capabilityIds: string[]
   }): Promise<PendingTriggerCapability[]>  // returns the recomputed remaining-pending list
   ```
   `confirmTriggerCapabilities()` re-derives everything from scratch rather
   than trusting the renderer's input, in this order: (1) re-resolve the
   plugin from the live registry, reject if `status !== "active"` or
   `manifest` is absent; (2) build `GrantIdentity` from the *current*
   manifest/source kind (never a captured one — the same freshness
   discipline as `dispatchBackgroundAgent()`'s registry re-resolution
   above); (3) recompute `pendingCapabilityConfirmations()` fresh; (4)
   intersect the caller's `capabilityIds` against that fresh pending set —
   any id not currently pending (unknown, already granted, not declared, or
   lacking `requiresExplicitTriggerConfirmation`) is silently dropped, not
   granted; (5) for the surviving intersection, grant each via
   `GrantStore.grant()` — the same store, same shape
   `ensureTriggerUseGrants()` already writes to, just from this explicit,
   re-validated call site instead of the automatic sweep; (6) return the
   freshly recomputed pending list (should now exclude what was just
   granted). New IPC channels `plugins:list-pending-trigger-capabilities`/
   `plugins:confirm-trigger-capabilities`, preload exposure, and a
   `lib/electron.ts` wrapper follow this codebase's existing `guard(event,
   channel)` + typed-argument-validation pattern (see Testing).
6. Renderer: a new banner (modeled on the existing shape of
   `trigger-migration-notice-banner.tsx`, not its file-backed persistence)
   surfaces on the Plugins page whenever
   `listPendingTriggerCapabilityConfirmations()` returns a non-empty result
   for any active plugin. Clicking it opens a confirm dialog reusing
   `DeclaredTriggersPanel`, scoped to just the pending capabilities;
   confirming calls `confirmTriggerCapabilities()`. The copy must state
   exactly what's being granted per the earlier Architecture decision —
   "can read this workspace's memory and global memory" / "can read this
   workspace's files" — not a bare capability id.
7. **This banner alone does not cover the disabled→enabled toggle —
   confirmed as a real gap during review.** The existing Enable Confirm
   dialog's "Allow" button (`plugins-page.tsx:499-506`) calls
   `applyEnabled(plugin, true)` → `setPluginEnabled()` → `PluginHost.
   setEnabled()` (`plugin-host.ts:373-381`) → `ensureTriggerUseGrants()`,
   which (per this spec's fix, item 2 above) now *skips*
   `memory:read`/`execution:read` — so a plugin re-enabled through the
   existing dialog becomes active with its trigger registered, but the two
   new capabilities stay ungranted until the *separate* banner is noticed.
   Worse: because visibility filtering only checks `uses[]` declaration
   (§ "Read-only tool sources" below), the tools would still appear in the
   model's tool list and get called-then-denied on every fire, burning
   `maxToolCallsPerRun`/token budget for nothing until the user acts. Fix:
   a new host-side `confirmAndEnablePlugin(pluginId, capabilityIds)`
   method composes `confirmTriggerCapabilities()` and `setEnabled(pluginId,
   true)` as one atomic sequence (grant first, enable second; if enabling
   fails, the grant already succeeded and is harmless — a granted-but-
   disabled capability does nothing — so there's no rollback needed, only
   ordering). The Enable Confirm dialog's "Allow" button calls this new
   method instead of the bare `setPluginEnabled()`, passing whichever
   pending capability ids `DeclaredTriggersPanel` is already displaying for
   that plugin's triggers.
8. `pendingCapabilityConfirmations()`/the banner also cover the "plugin
   update newly adds `memory:read`/`execution:read` to an already-
   installed, already-active plugin" case for free — it's computed from
   the *current* manifest on every check, so a manifest update that adds
   either capability makes it pending again automatically, no separate
   migration-detection logic needed. This case doesn't need
   `confirmAndEnablePlugin()` (the plugin is already enabled) — the plain
   banner + `confirmTriggerCapabilities()` path handles it.

### Read-only tool sources

Two new files, narrowly read-only by construction (no write/patch/shell path
exists to disable — it's simply never built):

- **`src/main/ai/memory/memory-read-tools.ts`** — `MemoryReadOnlyToolSource`,
  exposing only `memory_search`/`memory_list` (the two tools
  `memory-tools.ts`'s existing `TOOLS` array already marks
  `readOnlyHint: true`, lines 61-93). Unlike `ExecutionToolHostSource`,
  `MemoryToolSource`'s constructor takes only a `MemoryService` (confirmed:
  `memory-tools.ts:109`, no `isAllowed`/dedicated audit-log parameter to
  preserve) — so there's no equivalent hidden dependency to lose. Still,
  for the same drift-avoidance reason as execution: this class wraps a real
  `MemoryToolSource` instance and narrows its surface (same shape as
  `ExecutionReadOnlyToolSource` above — `ownsTool()` allowlists
  `memory_search`/`memory_list`, `listTools()` filters and tags
  `manifestTool.capabilities: [{ id: "memory:read" }]`, `invokeTool()`
  delegates unchanged) rather than reimplementing `memory-scope.ts`'s
  `queryScopeForCaller`/`entryMatchesQuery` logic a second time.
- **`src/main/ai/execution/execution-read-tools.ts`** —
  `ExecutionReadOnlyToolSource`, exposing only `list_files`/`read_file`/
  `search_files` (`execution-tool-host.ts`'s three `readOnlyHint: true`
  descriptors, lines 36-87). **Confirmed during review**:
  `ExecutionToolHostSourceOptions` requires `log: ExecutionLogStore` (not
  optional) and `isAllowed?: () => boolean` — `execution-tool-host.ts:20-27`
  — and both `listTools()` and `invokeTool()` gate on `isAllowed()` (the
  `allowAgentShell` global master switch), while every successful
  `list_files`/`read_file`/`search_files` call already writes an
  `ExecutionLogStore` audit entry (confirmed reading `invokeTool()`'s body,
  lines 213-222). Silently reusing `file-tools.ts` directly (bypassing both)
  would let a background-agent instance read files even when the user has
  turned Agent Shell off entirely, and would leave those reads with no audit
  trail at all. **Fix**: `ExecutionReadOnlyToolSource` does not
  reimplement any of this — it wraps a real, fully-configured
  `ExecutionToolHostSource` instance (constructed with the same real
  `workspaceRoots`/`log`/`isAllowed` the interactive path already uses) and
  narrows its surface:
  ```ts
  export class ExecutionReadOnlyToolSource implements ToolHostSource {
    constructor(private readonly inner: ExecutionToolHostSource) {}
    private static readonly ALLOWED = new Set(["list_files", "read_file", "search_files"])
    ownsTool(fqName: string): boolean {
      return this.inner.ownsTool(fqName) && ExecutionReadOnlyToolSource.ALLOWED.has(
        fqName.slice(EXECUTION_FQ_PREFIX.length + EXECUTION_PLUGIN_ID.length + 1)
      )
    }
    listTools(): RegisteredToolDescriptor[] {
      return this.inner.listTools()
        .filter((d) => this.ownsTool(d.fqName))
        .map((d) => ({ ...d, manifestTool: { ...d.manifestTool, capabilities: [{ id: "execution:read" }] } }))
    }
    invokeTool(fqName, input, options): Promise<ToolResult> {
      // ownsTool() already guarantees fqName is one of the 3 read tools —
      // apply_patch/run_command can never reach this class's invokeTool.
      return this.inner.invokeTool(fqName, input, options)
    }
  }
  ```
  This inherits `isAllowed`-gating, `ExecutionLogStore` auditing, and
  `WorkspacePolicy` fencing automatically and exactly as the interactive
  path already gets them — zero duplicated logic, zero drift risk if
  `ExecutionToolHostSource`'s internals change later. `apply_patch`/
  `run_command` (the `destructiveHint: true` pair) are excluded by
  `ownsTool()`'s allowlist, never reachable through this class.

Both are new, independent classes — `MemoryToolSource`/
`ExecutionToolHostSource` (the existing read+write interactive-path
sources) are completely untouched.

### Governance wiring — the core of this spec

`PluginBridge` gains one new, narrow public method (its existing `gateFor()`
stays private — exposing it as-is would let a caller override the
`declaredCapabilities` parameter and bypass the manifest-declared set
entirely):

```ts
// src/main/plugins/plugin-bridge.ts
createBackgroundHostToolAuthorizer(
  pluginId: string,
  manifest: PluginManifest
): {
  ensure(request: CapabilityRequest): Promise<void>
  /** Which of the given capability ids are currently granted for this
   *  plugin's identity — a pure read, no audit entry, no budget debit.
   *  Used only to decide tool *visibility*; `ensure()` remains the
   *  authoritative, audited check at invoke time. */
  confirmedCapabilities(candidateIds: readonly string[]): Promise<Set<string>>
} {
  const sourceKind = this.sourceKindFor(pluginId)
  const identity = buildGrantIdentity(pluginId, manifest, sourceKind)
  const gate = this.gateFor(pluginId, manifest)
  return {
    ensure: (request) => gate.ensure(request),
    confirmedCapabilities: async (candidateIds) => {
      const entries = await Promise.all(
        candidateIds.map(async (id) => [id, await this.governance.grants.isGranted(identity, id)] as const)
      )
      return new Set(entries.filter(([, granted]) => granted).map(([id]) => id))
    },
  }
}
```

**Confirmed as a real gap during review**: without this, `listTools()` would
list a tool as soon as its capability is *declared* in `uses[]`
(`toolCapabilitiesAllowed`, checked one layer up by `BackgroundAgentRunner.
limitedTools()`, unchanged) — regardless of whether it's actually *granted*
yet. Since visibility and the confirmation gate (above) are now
independent, an instance whose trigger declares `memory:read` but hasn't
been confirmed would still see `memory_search` in its tool list, could call
it, and would get denied by `gate.ensure()` every single time — burning a
full tool-call round-trip (and its `maxToolCallsPerRun`/token cost) on a
call that can never succeed. `GovernedBackgroundToolHost` closes this by
resolving the currently-granted subset **once per dispatch**, before
`BackgroundAgentRunner` ever calls `listTools()` (not per-`listTools()`-call
— `ToolHostPort.listTools()` is synchronous, confirmed via
`tool-registry.ts:16-18`, so an async grant check cannot live inside it):

New `GovernedBackgroundToolHost` (`src/main/ai/background-host-tool-gate.ts`):

```ts
export interface GovernedBackgroundToolHostOptions {
  authorizer: {
    ensure(request: CapabilityRequest): Promise<void>
    confirmedCapabilities(candidateIds: readonly string[]): Promise<Set<string>>
  }
  sources: ToolHostSource[]  // only the sources whose backing tool instance actually exists — see below
  /** Resolved once, before construction, via authorizer.confirmedCapabilities(). */
  confirmed: ReadonlySet<string>
}

export class GovernedBackgroundToolHost implements ToolHostSource {
  // listTools(): sources.flatMap(s => s.listTools()), then filters out any
  //   descriptor whose sole manifestTool.capabilities[0].id is not in `confirmed`
  //   — this is IN ADDITION TO, not instead of, limitedTools()'s existing
  //   uses[]-declaration filter one layer up; declared-but-unconfirmed tools
  //   are hidden here, declared-and-confirmed-but-not-in-uses[] tools are
  //   already hidden by the existing filter.
  // ownsTool(fqName): true iff some source.ownsTool(fqName) — unaffected by
  //   confirmation status, so invokeTool() below still runs for a stale/direct
  //   call and gate.ensure() still denies it (defense in depth; listTools()
  //   is a visibility optimization, not the security boundary).
  // invokeTool(fqName, input, options):
  //   1. find the owning source; resolve its descriptor's manifestTool.capabilities
  //      (asserted to be exactly one S07 capability id — memory:read or execution:read;
  //      this is the single source of truth for both visibility filtering upstream
  //      and gating here, no separate hand-maintained fqName→capability map)
  //   2. build InvocationContext = { source: "tool", caller: options.caller,
  //      trigger: `tool:${fqName}`, signal: options.signal }
  //   3. await authorizer.ensure({ capability, invocation, operation: toolName, signal: options.signal })
  //      — operation is the bare tool name only (e.g. "read_file", not the
  //      full "execution:core/read_file" fqName), never the
  //      query/path/content, matching this codebase's existing low-sensitivity
  //      audit-entry convention (execution's own detailed activity already
  //      lives in ExecutionLog, not the capability audit)
  //   4. on CapabilityDenied, propagate without invoking the source (deny-before-delegate,
  //      never delegate-then-check)
  //   5. on success, delegate to source.invokeTool(fqName, input, options) — exactly
  //      one ensure() call per invocation, including when the input later fails
  //      validation inside the source (a call attempt happened; it debits)
}
```

`PluginHost.dispatchBackgroundAgent()` (`plugin-host.ts:455-481`) is updated:

```ts
private async dispatchBackgroundAgent(request: PluginAgentTriggerDispatchRequest): Promise<void> {
  if (!this.options.backgroundAgentProvider) {
    throw new Error("background agent provider not configured")
  }
  const entry = this.registry.get(request.pluginId)
  if (!entry || entry.status !== "active" || !entry.manifest) {
    throw new Error(`Plugin is not active: ${request.pluginId}`)
  }

  const authorizer = this.bridge.createBackgroundHostToolAuthorizer(request.pluginId, entry.manifest)
  const confirmed = await authorizer.confirmedCapabilities(["memory:read", "execution:read"])

  const sources: ToolHostSource[] = []
  const executionTools = this.options.executionTools?.()
  if (executionTools) sources.push(new ExecutionReadOnlyToolSource(executionTools))
  const memoryTools = this.options.memoryTools?.()
  if (memoryTools) sources.push(new MemoryReadOnlyToolSource(memoryTools))

  const governed = new GovernedBackgroundToolHost({ authorizer, sources, confirmed })
  const tools = new CompositeToolHost([
    governed,
    asFallbackSource(this, (fqName) => governed.ownsTool(fqName)),
  ])

  const { provider, model } = await this.options.backgroundAgentProvider()
  const runner = new BackgroundAgentRunner({
    provider, model,
    tools,  // was: tools: this
    ledger: this.agentBudgetLedger,
    recordRun: this.options.recordRun,
    runBudgetRegistry: this.options.runBudgetRegistry,
    workspaceRoots: this.options.workspaceRoots,
  })
  await runner.run({ /* unchanged */ })
}
```

Two fixes over the first draft, both caught during review:

- **`entry` is re-resolved from the live registry and checked for
  `status === "active"` and a present `manifest`** — not just truthiness.
  `PluginRegistryEntry.manifest` is optional and `status` has more states
  than `"active"` (`types.ts:69-78`, e.g. `"disabled"`/`"crashed"`/
  `"invalid"`/`"shadowed"`) — a plugin that crashed or was disabled between
  the trigger firing and this dispatch running must not have its stale
  captured manifest used to construct an authorizer.
- **`asFallbackSource(this, (fqName) => governed.ownsTool(fqName))`, not
  `asFallbackSource(this, governed.ownsTool)`.** Passing the bare method
  reference loses its `this` binding — `asFallbackSource`'s `claimedBy`
  parameter (`composite-tool-host.ts:39`) invokes it as a plain function,
  so an unbound `governed.ownsTool` would crash or misbehave the first time
  it reads `this` internally. Wrapped in an arrow function, `this` stays
  bound to `governed` correctly.
- **`confirmed` is resolved once, before `GovernedBackgroundToolHost` is
  constructed**, from `authorizer.confirmedCapabilities(["memory:read",
  "execution:read"])` — the visibility-vs-grant fix described above.
  `sources` is built conditionally, pushing `ExecutionReadOnlyToolSource`/
  `MemoryReadOnlyToolSource` only when their backing tool instance actually
  resolves (see Constructor wiring, below) — omitted, not constructed
  around a missing inner, when a feature is genuinely unconfigured.

`governed` is claimed first in the `CompositeToolHost`'s source list; it
only ever claims the 5 fqNames its two sources produce
(`memory:core/memory_search`, `memory:core/memory_list`,
`execution:core/list_files`, `execution:core/read_file`,
`execution:core/search_files` — never a whole-namespace prefix claim, so a
future *write* tool added under the same `memory:`/`execution:` prefix is
never accidentally routed into the unrestricted background path). The
fallback claims everything else, preserving today's plugin-tool behavior
unchanged.

**Constructor wiring — confirmed and corrected twice during review.** The
first draft assumed `PluginHostOptions` could receive an already-constructed
`memory?: MemoryService` and build `this.memoryReadSource` once in the
constructor. Tracing the real startup order in `src/main/index.ts`
disproves this: `initPluginHost()` runs at line 1209, but `MemoryService`
(line 857), `ExecutionLogStore` (line 877), and the interactive path's own
`executionSource = new ExecutionToolHostSource({...})` (line 878) are all
constructed *inside* `createAgentService()`, called afterward at line 1239
— `PluginHost`'s constructor genuinely cannot receive any of them as a
direct value.

**Second, deeper problem, also confirmed during review**: the *second*
draft fixed the ordering with lazy getters over the raw `MemoryService`/
`ExecutionLogStore`, but proposed constructing a **second, independent**
`ExecutionToolHostSource` inside `PluginHost` from those raw stores.
`ExecutionToolHostSource` holds its own private `anyRootsExist` flag
(`execution-tool-host.ts:126`), populated only by an explicit `refresh()`
call — and `refresh()` is wired to workspace-root changes in exactly one
place: `onWorkspaceRootsChanged: () => void executionSource.refresh()`
(`main/index.ts:971-972`), naming the interactive path's specific instance.
A second, independently-constructed instance would never receive that
callback — if no `WorkspaceRoot` exists at the moment `PluginHost` first
builds it, its `anyRootsExist` would stay `false` forever, even after the
user creates one later, permanently hiding `execution:read`'s tools from
every background-agent instance regardless of grant status. Sharing the
underlying `workspaceRoots`/`log`/`isAllowed` *stores* was not enough —
the *tool source instance itself* carries state that only one wiring path
updates.

**Fix**: share the actual `MemoryToolSource`/`ExecutionToolHostSource`
*instances* the interactive path already builds and maintains, not just
their backing stores — mirroring the same `let agent` / `backgroundAgentProvider`
lazy-getter pattern this file already uses for the identical ordering
problem (`main/index.ts:253,786`, `agent` assigned after
`createAgentService()` resolves):

```ts
// main/index.ts, alongside the existing `let agent`/`let runTraceRecorder`
let sharedMemoryTools: MemoryToolSource | undefined
let sharedExecutionTools: ExecutionToolHostSource | undefined

// inside initPluginHost()'s options, alongside backgroundAgentProvider:
memoryTools: () => sharedMemoryTools,
executionTools: () => sharedExecutionTools,

// inside createAgentService(), right after `executionSource`/the memory
// tool source are constructed (mirroring the existing
// `runTraceRecorder = recordRun` assignment) — the SAME instances the
// interactive CompositeToolHost already uses, not new ones:
sharedMemoryTools = memoryToolSource
sharedExecutionTools = executionSource
```

`PluginHostOptions` gains, alongside the already-required `workspaceRoots`:

```ts
memoryTools?: () => MemoryToolSource | undefined
executionTools?: () => ExecutionToolHostSource | undefined
```

Both are read fresh on every `dispatchBackgroundAgent()` call (not cached
at construction, not memoized — a plain getter call is cheap and this
guarantees the very latest `refresh()`-updated state), by which point
`createAgentService()` has always already run, since `agent` (consumed by
the pre-existing `backgroundAgentProvider` getter on the very same dispatch
path) already depends on that same ordering guarantee today. This
automatically and permanently shares `refresh()` state, `isAllowed`,
`ExecutionLogStore` auditing, and `MemoryService` — including any future
internal fix to either class — with zero separate wiring to maintain. When
a getter resolves `undefined` (the feature genuinely unconfigured), the
corresponding read-only source is **omitted from `sources` entirely**
(see the `dispatchBackgroundAgent()` listing above) — `ExecutionReadOnlyToolSource`/
`MemoryReadOnlyToolSource`'s constructors require a real, non-optional
inner instance; there is no "constructs anyway with an empty listTools()"
mode, since that would mean maintaining a second no-op code path for a
case that's already cleanly handled by not adding the source to the list
at all.

`isAllowed` needs none of this getter treatment — `launcher.getSettings
().allowAgentShell` is already read as `isAllowed: () =>
launcher.getSettings().allowAgentShell` at `main/index.ts:881` for the
interactive path's `ExecutionToolHostSource`, and `launcher` is available
at `PluginHost`-construction time with no ordering dependency at all. The
exact same closure is passed to the `ExecutionToolHostSource` instance
`ExecutionReadOnlyToolSource` wraps.

### Budget enforcement

Each `memory_search`/`memory_list`/`list_files`/`read_file`/`search_files`
call made through `GovernedBackgroundToolHost` debits the trigger's declared
`uses[].budget` via the existing `BudgetBreakerPort`/`BudgetLedger` — the
same mechanism already serving `notification`/`network:https`/etc., with
zero new ledger infrastructure. This is layered on top of, not a
replacement for, the existing per-run `AgentTriggerBudget`
(`maxToolCallsPerRun`, enforced independently by
`background-agent-runner.ts:56,61-67,110-119`'s `AgentBudgetLedger`) — a
single run can still be capped at N total tool calls regardless of which
capability they belong to, while `uses[].budget` additionally caps how many
of *specifically* `memory:read`/`execution:read` calls happen across
*all* fires in a rolling period. Exceeding either cap denies the call the
same way any other `CapabilityDenied` does.

## Testing

- **`memory-read-tools.test.ts`** (new): `MemoryReadOnlyToolSource.listTools()`
  returns exactly `memory_search`/`memory_list`, each tagged
  `capabilities: [{id: "memory:read"}]`; `invokeTool()` for a
  `background-agent` caller scoped to workspace A never returns a
  workspace-B-scoped entry, but does return a global-visibility entry
  (the `includeGlobal: true` regression test); `memory_save`/
  `memory_ingest`/`memory_delete` never appear in `listTools()` and
  `ownsTool()` returns `false` for their fqNames.
- **`execution-read-tools.test.ts`** (new): `ExecutionReadOnlyToolSource.listTools()`
  returns exactly `list_files`/`read_file`/`search_files`, each tagged
  `capabilities: [{id: "execution:read"}]`; `apply_patch`/`run_command`
  never appear and `ownsTool()` returns `false` for their fqNames; a
  path-escape attempt through `read_file`/`search_files` is rejected by
  the same `WorkspacePolicy` fencing the interactive path already relies
  on (reusing `workspace-policy.test.ts`'s existing attack-path fixtures,
  not reinventing them); **`listTools()`/`invokeTool()` both return
  empty/denied when the wrapped `ExecutionToolHostSource`'s `isAllowed()`
  returns `false`** (the Agent Shell master-switch regression); **a
  successful `read_file` call writes an `ExecutionLogStore` entry**
  (asserted against a real `ExecutionLogStore`, not a stub — the
  audit-trail-preservation regression).
- **`trigger-grants.test.ts`**: `grantTriggerUses()` skips auto-granting
  any `use.capability` where `getCapability(...)
  ?.requiresExplicitTriggerConfirmation === true`, while still
  auto-granting every other existing capability unchanged (the
  narrow-scope regression — the fix must not touch the other 14's
  behavior); `pendingCapabilityConfirmations(manifest, isGranted)` returns
  exactly the declared-but-ungranted explicit-confirmation capabilities,
  **deduplicated by capability id with all declaring trigger ids attached**
  (two triggers both declaring `memory:read` produce one
  `PendingTriggerCapability` with `triggerIds: [id1, id2]`, not two rows),
  empty once granted, and recomputes fresh (no stale caching) when a
  manifest is updated to add a new one.
- **`background-host-tool-gate.test.ts`** (new): the core of this spec's
  correctness —
  - a call succeeds only after `authorizer.ensure()` resolves; the
    underlying source's `invokeTool` is never called if `ensure()` throws
    `CapabilityDenied` (deny-before-delegate, asserted via a spy that
    counts zero invocations on the wrapped source).
  - exactly one `ensure()` call per `invokeTool()` call, including when the
    wrapped source itself later throws on invalid input.
  - the `CapabilityRequest` passed to `ensure()` carries `capability`
    resolved from the descriptor's own `manifestTool.capabilities` (not a
    hardcoded map) — a regression test constructs a fake source whose
    descriptor declares a capability id and asserts the exact same id
    appears in the `ensure()` call.
  - a descriptor declaring zero or more-than-one S07 capability id throws
    at construction/registration time rather than silently picking one (the
    "single source of truth" invariant, enforced defensively).
  - **`listTools()` excludes a tool whose capability is declared in
    `uses[]` but absent from the `confirmed` set passed at construction**
    — the visibility-vs-grant regression; `invokeTool()` for that same
    fqName still routes through `ensure()` and is denied (defense in
    depth — `listTools()` filtering is a UX/budget optimization, not the
    security boundary; a stale/direct call must still be caught).
- **`plugin-host.test.ts`**: a background-agent dispatch for a trigger whose
  `uses[]` includes `memory:read`, granted and confirmed, successfully
  calls `memory_search`; a dispatch for a trigger whose `uses[]` does
  **not** declare `memory:read` gets a tool list from `governed.
  listTools()` that excludes it entirely (visibility filtering, matching
  today's `toolCapabilitiesAllowed` behavior for plugin tools); a dispatch
  for a trigger that **does** declare `memory:read` but has not been
  through the confirmation gate gets a tool list that *also* excludes it
  (the `confirmed`-set filter, not just a denied-on-invoke outcome) — three
  regression tests reusing this file's existing `writeHostPlugin()`/
  `hostOptions()` harness pattern. A companion test confirms budget
  exhaustion (fire past `uses[].budget.maxCalls`) denies the Nth call
  without denying the `maxToolCallsPerRun` cap's own independent
  accounting. A dispatch for a plugin entry whose `status` is
  `"disabled"`/`"crashed"` (registry mutated between fire and dispatch)
  throws before constructing an authorizer, never using a stale captured
  manifest. **A dedicated test constructs `hostOptions()` with a fake
  `executionTools: () => sharedExecutionSource` returning the same instance
  across two dispatches, mutates a fake `WorkspaceRootStore` and calls
  `sharedExecutionSource.refresh()` between them, and asserts the second
  dispatch's tool list reflects the change** — the shared-instance,
  refresh-lifecycle regression; a version of this test using two
  *independently constructed* `ExecutionToolHostSource` instances instead
  must be shown to fail first, to prove the test actually catches the bug
  the fix addresses.
- **`capabilities.test.ts`** (`packages/plugin-manifest`): `memory:read`/
  `execution:read` round-trip through `getCapability()`/
  `capabilityEntrySchema` like every other registry entry, both carrying
  `requiresExplicitTriggerConfirmation: true`; a manifest declaring
  `uses: [{capability: "memory:read", budget: {...}}]` with no top-level
  `capabilities` entry validates successfully (the
  `mergeDeclaredWithTriggerUses` regression this spec depends on).
- **`plugin-bridge.test.ts`**: `createBackgroundHostToolAuthorizer(pluginId,
  manifest).confirmedCapabilities(candidateIds)` returns only the subset
  actually granted for that plugin's identity (a pure read — asserted to
  write zero audit entries and debit zero budget, unlike `ensure()`).
- **`plugins.test.ts`** (or wherever `registerPluginIpc` lives — new IPC
  handler tests): `plugins:confirm-trigger-capabilities` rejects an
  untrusted sender; rejects a `pluginId` for a disabled/crashed/unknown
  plugin; **silently drops any `capabilityIds` entry that isn't currently
  pending** — a manifest-undeclared id, an id lacking
  `requiresExplicitTriggerConfirmation`, and an already-granted id are all
  submitted in one call and none of them end up newly granted (only a
  genuinely-pending id in the same payload is); the response reflects the
  freshly recomputed remaining-pending list, not an echo of the request.
  `plugins:list-pending-trigger-capabilities` returns the deduplicated,
  per-plugin pending list with no side effects.
- **`plugin-host.test.ts`** (host-method level, below the IPC layer):
  `confirmAndEnablePlugin(pluginId, capabilityIds)` grants first, then
  enables, in that order — a test asserts `setEnabled` is never called if
  the grant step throws; a companion test confirms a granted-but-not-yet-
  enabled state is inert (no dispatch can happen for a disabled plugin
  regardless of grant status), so there's nothing to roll back if enabling
  itself fails after a successful grant.
- **Renderer**: new `pending-capability-confirmation-banner.test.tsx`
  (modeled on `trigger-migration-notice-banner.test.tsx`'s existing shape)
  — the banner renders when `listPendingTriggerCapabilityConfirmations()`
  returns a non-empty result for any active plugin, is absent when empty,
  and clicking it opens a confirm dialog reusing `DeclaredTriggersPanel`
  scoped to just the pending entries, calling `confirmTriggerCapabilities()`
  on confirm. The existing Enable Confirm dialog's "Allow" button, when the
  plugin's manifest has pending explicit-confirmation capabilities, calls
  `confirmAndEnablePlugin()` instead of the bare `setPluginEnabled()` —
  asserted via a test on `plugins-page.tsx`'s existing enable-confirm flow.
  `declared-triggers-panel.test.tsx` gains a case asserting
  `permissions.items.memory:read`/`permissions.items.execution:read`
  render as translated copy, not the raw capability id (the
  `defaultValue: use.capability` fallback this spec's missing i18n keys
  would otherwise silently fall through to).
- **Lifecycle integration tests** (`plugin-host.test.ts`, exercising the
  real `PluginHost.init()`/`installFromMarketplace()`/`setEnabled()`
  sequence against a real `GrantStore`, not individually-mocked pieces —
  requested during review because the unit tests above only prove each
  piece works in isolation, not that the real startup/install/update
  sequence wires them together correctly):
  1. **Fresh install**: installing a plugin whose manifest declares
     `memory:read` on a trigger leaves it ungranted immediately after
     install (`grantTriggerUses()`'s skip, exercised through the real
     install path, not called directly).
  2. **Update adds a capability**: an already-active, already-granted-for-
     its-old-manifest plugin is updated to a new manifest version that adds
     `execution:read` to a trigger's `uses[]`; `execution:read` becomes
     pending again, `memory:read` (if unchanged and previously confirmed)
     stays granted.
  3. **Restart doesn't backfill**: a plugin with a pending (ungranted)
     `memory:read` declaration, when the app restarts (`init()`'s
     `syncTriggerRegistrations()` sweep runs again), still has it pending
     afterward — the auto-grant sweep must not silently catch up a
     previously-skipped capability on a later sync pass.
  4. **disabled→confirmed→enabled uses the current identity**: a disabled
     plugin's manifest is updated (changing its `capabilityDeclarationHash`
     or similar identity-affecting field) before the user re-enables it
     through `confirmAndEnablePlugin()`; the resulting grant is recorded
     against the *new* manifest's `GrantIdentity`, not a stale one captured
     before the update.

## Non-goals

- **No memory write/save/ingest/delete for background-agent instances.**
  `memory_save`/`memory_ingest`/`memory_delete` are never constructed into
  `MemoryReadOnlyToolSource` — there is no flag or override to enable them
  for a background-agent caller.
- **No `apply_patch`/`run_command` (shell exec) for background-agent
  instances.** Same — `ExecutionReadOnlyToolSource` never constructs them.
- **No new `scope` shape for `memory:read`/`execution:read`.** Unscoped;
  see Architecture above for why the workspace boundary doesn't need one.
- **No cross-workspace memory recall** beyond the existing
  global-visibility tier that's already visible everywhere by design. An
  instance bound to workspace A can never see workspace B's
  workspace-scoped memory or files.
- **No changes to the interactive chat path's tool surface.**
  `MemoryToolSource`/`ExecutionToolHostSource` (read+write) remain exactly
  as they are today for `cortex`/interactive agent runs — this spec adds
  two new, separate, read-only sources consumed only by the background-agent
  dispatch path.
- **No changes to `AgentTriggerBudget`/`maxToolCallsPerRun`'s existing
  per-run enforcement** — `uses[].budget` is an additional, independent
  cap layered on top, not a replacement.
- **No MCP-exposed equivalent.** This spec is scoped to Synapse's own
  background-agent trigger dispatch; whether external MCP clients should
  ever get a similar governed-read surface is out of scope here.
- **No general fix to trigger-capability consent for the other 14 existing
  capabilities.** Confirmed during review: every existing `consent`/
  `elevated` trigger capability is silently auto-granted on install/restart
  today (see "Explicit confirmation gate" above) — this is a real,
  pre-existing systemic gap, not introduced by this spec. S07 adds a narrow
  confirmation gate scoped to exactly `memory:read`/`execution:read` via
  `requiresExplicitTriggerConfirmation`, leaving the other 14's existing
  (weaker) auto-grant behavior completely untouched. Building a real
  confirmation state machine for every trigger capability generally is a
  separate, independently-scoped future spec.

## Completion criteria

- `memory:read`/`execution:read` exist in the central capability registry,
  `consent` tier, unscoped, `requiresExplicitTriggerConfirmation: true`,
  and validate correctly through `capabilityEntrySchema` and
  `mergeDeclaredWithTriggerUses()`.
- `grantTriggerUses()`'s automatic sync path never auto-grants either new
  capability; the other 14 existing capabilities' auto-grant behavior is
  unchanged (regression-tested).
- **The renderer never writes a grant directly.** `listPendingTriggerCapabilityConfirmations()`/
  `confirmTriggerCapabilities()`/`confirmAndEnablePlugin()` are the only
  host-owned entry points, each re-resolving the plugin from the live
  registry, re-deriving `GrantIdentity` from the current manifest, and
  intersecting the caller's requested capability ids against a freshly
  recomputed pending set before granting anything — an id that's
  undeclared, already granted, or lacking
  `requiresExplicitTriggerConfirmation` is silently dropped, never granted.
  `pendingCapabilityConfirmations()` deduplicates by capability id across
  multiple triggers declaring the same one.
- A new confirmation banner + dialog lets a user explicitly grant
  `memory:read`/`execution:read` per plugin through those host-owned
  methods, covering fresh install, plugin update adding either capability,
  and — via a new `confirmAndEnablePlugin()` that composes granting and
  `setEnabled()` atomically — the pre-existing disabled→enabled toggle,
  whose "Allow" button previously only called `setPluginEnabled()` with no
  grant step at all.
- `MemoryReadOnlyToolSource`/`ExecutionReadOnlyToolSource` exist, each
  wrapping (not reimplementing) its real read+write counterpart, exposing
  exactly the read-only subset, each descriptor tagged with exactly one of
  the two new capability ids. `ExecutionReadOnlyToolSource` inherits the
  wrapped `ExecutionToolHostSource`'s `isAllowed()` gating and
  `ExecutionLogStore` auditing unchanged — verified by tests that construct
  a real `ExecutionLogStore`, not a stub. Both wrap the **same singleton
  instances** the interactive path already builds and maintains (shared via
  lazy getters on `PluginHostOptions`, mirroring the existing
  `backgroundAgentProvider` pattern) — not independently-constructed
  duplicates that would silently lose `ExecutionToolHostSource.refresh()`'s
  workspace-root-change updates.
- `GovernedBackgroundToolHost` calls `PluginBridge.createBackgroundHostToolAuthorizer(...).ensure()`
  before every delegated invocation, resolving the capability id from the
  tool descriptor (not a hand-maintained map), denying without delegating
  on failure, debiting exactly once per call. Its `listTools()` additionally
  filters by a `confirmed` set resolved once per dispatch via
  `authorizer.confirmedCapabilities()` — a tool declared in `uses[]` but
  not yet confirmed is hidden from the model's tool list (not just denied
  on invoke), so a background-agent run never burns `maxToolCallsPerRun`/
  token budget on a call that can never succeed.
- `PluginHost.dispatchBackgroundAgent()` composes
  `CompositeToolHost([governed, asFallbackSource(this, (fqName) =>
  governed.ownsTool(fqName))])` in place of the old bare `tools: this`,
  re-resolving the plugin's live registry entry and checking `status ===
  "active"` + a present `manifest` (not a captured/stale one) at dispatch
  time.
- A background-agent instance whose trigger declares `memory:read`/
  `execution:read` in `uses[]` **and has been explicitly confirmed through
  the new banner/dialog flow** can call the corresponding read-only tools,
  scoped to its bound workspace (plus global memory), with per-period
  budget enforcement and a capability-audit entry for every call — verified
  by tests that exercise the real `CapabilityGate`/`BudgetBreakerPort`
  chain, not a stub. An instance whose trigger declares either capability
  but has *not* been confirmed sees neither the tool in its list nor a
  successful call if attempted anyway.
- An instance whose trigger does *not* declare these capabilities never
  sees the tools in its model-facing tool list.
- The four lifecycle integration tests (fresh install, manifest update
  adding a capability, app restart, disabled→confirmed→enabled) all pass
  against the real `PluginHost.init()`/install/`setEnabled()` sequence, not
  individually-mocked pieces.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.

## Parked questions

- Whether a background-agent instance should be able to see *its own*
  prior run's `RunTrace` (via some future read-only S06-adjacent capability)
  was not raised during brainstorming and is out of scope here — S07 is
  scoped strictly to `memory:read`/`execution:read`.
- Per-tool budget granularity (e.g. `memory_search` costs more than
  `memory_list`) was not raised — both tools under one capability id share
  one budget bucket, matching how every other multi-tool capability in this
  registry already works (no existing capability differentiates cost by
  tool name).
- Whether `execution:read`'s `read_file`/`search_files` byte/match caps
  (`MAX_READ_BYTES`, `MAX_SEARCH_MATCHES` in `file-tools.ts`) should be
  tightened specifically for the background-agent path (vs. the interactive
  path's existing values) was not raised; this spec inherits the existing
  constants unchanged.
- **A general fix for trigger-capability consent** (the systemic gap
  described in "Explicit confirmation gate" and Non-goals — all 14 existing
  capabilities are silently auto-granted on install/restart with no real
  confirmation) is explicitly not fixed generally by this spec, only
  worked around narrowly for `memory:read`/`execution:read`. Whether to
  retrofit `requiresExplicitTriggerConfirmation`-style confirmation onto
  some or all of the other 14 (`fs:watch`, `network:https`,
  `credentials:broker`, etc.) is a real, independently-scoped future spec
  candidate, not yet assigned a number.
