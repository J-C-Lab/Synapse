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
   `requiresExplicitTriggerConfirmation` capabilities, and returns the ones
   not yet granted for that identity. No new persisted state — "pending" is
   always computed live from the manifest + `GrantStore`, unlike
   `TriggerMigrationNotice`'s file-backed dismissal state (that mechanism
   solves a different problem, remembering an already-handled one-time
   migration; there's nothing to "dismiss" here — an ungranted capability
   stays pending until the user acts, indefinitely, by design).
5. Renderer: a new banner (modeled on the existing shape of
   `trigger-migration-notice-banner.tsx`, not its file-backed persistence)
   surfaces on the Plugins page whenever any active plugin has pending
   confirmations, computed by polling/refreshing
   `pendingCapabilityConfirmations()` over IPC. Clicking it opens the
   existing `DeclaredTriggersPanel`-based confirm dialog (already used for
   the disabled→enabled toggle), scoped to just the pending capabilities;
   confirming calls `GrantStore.grant()` directly for each — the same store,
   same shape `ensureTriggerUseGrants()` already writes to, just from an
   explicit user-initiated call site instead of the automatic sweep. The
   copy must state exactly what's being granted per the earlier
   Architecture decision — "can read this workspace's memory and global
   memory" / "can read this workspace's files" — not a bare capability id.
6. This banner path also covers the "plugin update newly adds `memory:read`/
   `execution:read` to an already-installed, already-active plugin" case —
   `pendingCapabilityConfirmations()` is computed from the *current*
   manifest on every check, so a manifest update that adds either capability
   makes it pending again automatically, with no separate migration-detection
   logic needed.

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
): { ensure(request: CapabilityRequest): Promise<void> } {
  return this.gateFor(pluginId, manifest)
}
```

New `GovernedBackgroundToolHost` (`src/main/ai/background-host-tool-gate.ts`):

```ts
export interface GovernedBackgroundToolHostOptions {
  authorizer: { ensure(request: CapabilityRequest): Promise<void> }
  sources: ToolHostSource[]  // MemoryReadOnlyToolSource, ExecutionReadOnlyToolSource
}

export class GovernedBackgroundToolHost implements ToolHostSource {
  // listTools(): flat-maps sources.listTools(), unchanged from CompositeToolHost's pattern
  // ownsTool(fqName): true iff some source.ownsTool(fqName)
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
  const governed = new GovernedBackgroundToolHost({
    authorizer,
    sources: [this.memoryReadSource, this.executionReadSource],
  })
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

`governed` is claimed first in the `CompositeToolHost`'s source list; it
only ever claims the 5 fqNames its two sources produce
(`memory:core/memory_search`, `memory:core/memory_list`,
`execution:core/list_files`, `execution:core/read_file`,
`execution:core/search_files` — never a whole-namespace prefix claim, so a
future *write* tool added under the same `memory:`/`execution:` prefix is
never accidentally routed into the unrestricted background path). The
fallback claims everything else, preserving today's plugin-tool behavior
unchanged.

**Constructor wiring — confirmed and corrected during review.** The first
draft assumed `PluginHostOptions` could receive an already-constructed
`memory?: MemoryService` and build `this.memoryReadSource` once in the
constructor. Tracing the real startup order in `src/main/index.ts`
disproves this: `initPluginHost()` runs at line 1209, but `MemoryService`
(line 857) and `ExecutionLogStore` (line 877) are both constructed *inside*
`createAgentService()`, called afterward at line 1239 — `PluginHost`'s
constructor genuinely cannot receive either as a direct value. Constructing
a second, independent `MemoryStore`/`ExecutionLogStore` instance inside
`PluginHost` instead is not an option either — both cache their full
contents in memory (confirmed: `MemoryStore`'s in-memory array, `
ExecutionLogStore`'s own cached array), so two instances would see stale
data and could silently drop each other's writes.

The fix mirrors a pattern this exact file already uses for the identical
problem: `backgroundAgentProvider` (already on `PluginHostOptions`) is
wired as `backgroundAgentProvider: () => agent.createBackgroundAgentProvider()`
(`main/index.ts:786`) — a closure over a module-level `let agent:
AgentService` (line 253) declared *before* `initPluginHost()` runs and
assigned *after* `createAgentService()` resolves (`agent = await
createAgentService()`, inside the same startup function, after line 1239).
`memory`/`executionLog` get the identical treatment:

```ts
// main/index.ts, alongside the existing `let agent`/`let runTraceRecorder`
let memoryService: MemoryService | undefined
let executionLogStore: ExecutionLogStore | undefined

// inside initPluginHost()'s options, alongside backgroundAgentProvider:
memory: () => memoryService,
executionLog: () => executionLogStore,

// inside createAgentService(), right after each is constructed
// (mirroring the existing `runTraceRecorder = recordRun` assignment):
memoryService = memory
executionLogStore = executionLog
```

`PluginHostOptions` gains, alongside the already-required `workspaceRoots`:

```ts
memory?: () => MemoryService | undefined
executionLog?: () => ExecutionLogStore | undefined
```

Both are read once, lazily, the first time a background-agent dispatch
actually needs them (constructing `this.memoryReadSource`/
`this.executionReadSource` on first use inside `dispatchBackgroundAgent()`,
memoized after that point rather than in the constructor) — by then
`createAgentService()` has always already run, since `agent` (consumed by
the pre-existing `backgroundAgentProvider` getter on the very same dispatch
path) already depends on that same ordering guarantee today. When `memory`
resolves `undefined` (the AI memory feature itself unconfigured),
`memoryReadSource` still constructs but its `listTools()` returns nothing —
exactly like `ExecutionToolHostSource`'s own `anyRootsExist`-gated
`listTools()` already does when no `WorkspaceRoot` exists for the calling
workspace.

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
- **`plugin-host.test.ts`**: a background-agent dispatch for a trigger whose
  `uses[]` includes `memory:read` (granted) successfully calls
  `memory_search`; a dispatch for a trigger whose `uses[]` does **not**
  declare `memory:read` gets a tool list from `governed.listTools()` that
  excludes it entirely (visibility filtering, matching today's
  `toolCapabilitiesAllowed` behavior for plugin tools); a dispatch for a
  trigger that declares `memory:read` but has **not** been through the new
  confirmation gate is denied at the `authorizer.ensure()` step (not merely
  hidden from the tool list) — both regression tests reuse this file's
  existing `writeHostPlugin()`/`hostOptions()` harness pattern. A companion
  test confirms budget exhaustion (fire past `uses[].budget.maxCalls`)
  denies the Nth call without denying the `maxToolCallsPerRun` cap's own
  independent accounting. A dispatch for a plugin entry whose `status` is
  `"disabled"`/`"crashed"` (registry mutated between fire and dispatch)
  throws before constructing an authorizer, never using a stale captured
  manifest.
- **`capabilities.test.ts`** (`packages/plugin-manifest`): `memory:read`/
  `execution:read` round-trip through `getCapability()`/
  `capabilityEntrySchema` like every other registry entry, both carrying
  `requiresExplicitTriggerConfirmation: true`; a manifest declaring
  `uses: [{capability: "memory:read", budget: {...}}]` with no top-level
  `capabilities` entry validates successfully (the
  `mergeDeclaredWithTriggerUses` regression this spec depends on).
- **Renderer**: new `pending-capability-confirmation-banner.test.tsx`
  (modeled on `trigger-migration-notice-banner.test.tsx`'s existing shape)
  — the banner renders when `pendingCapabilityConfirmations()` returns a
  non-empty result for any active plugin, is absent when empty, and
  clicking it opens a confirm dialog reusing `DeclaredTriggersPanel` scoped
  to just the pending entries. `declared-triggers-panel.test.tsx` gains a
  case asserting `permissions.items.memory:read`/`permissions.items.execution:read`
  render as translated copy, not the raw capability id (the
  `defaultValue: use.capability` fallback this spec's missing i18n keys
  would otherwise silently fall through to).

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
- A new confirmation banner + dialog lets a user explicitly grant
  `memory:read`/`execution:read` per plugin, covering fresh install,
  plugin update adding either capability, and the pre-existing
  disabled→enabled toggle — writing through the same `GrantStore.grant()`
  every other capability grant already uses.
- `MemoryReadOnlyToolSource`/`ExecutionReadOnlyToolSource` exist, each
  wrapping (not reimplementing) its real read+write counterpart, exposing
  exactly the read-only subset, each descriptor tagged with exactly one of
  the two new capability ids. `ExecutionReadOnlyToolSource` inherits the
  wrapped `ExecutionToolHostSource`'s `isAllowed()` gating and
  `ExecutionLogStore` auditing unchanged — verified by tests that construct
  a real `ExecutionLogStore`, not a stub.
- `GovernedBackgroundToolHost` calls `PluginBridge.createBackgroundHostToolAuthorizer(...).ensure()`
  before every delegated invocation, resolving the capability id from the
  tool descriptor (not a hand-maintained map), denying without delegating
  on failure, debiting exactly once per call.
- `PluginHost.dispatchBackgroundAgent()` composes
  `CompositeToolHost([governed, asFallbackSource(this, (fqName) =>
  governed.ownsTool(fqName))])` in place of the old bare `tools: this`,
  re-resolving the plugin's live registry entry and checking `status ===
  "active"` + a present `manifest` (not a captured/stale one) at dispatch
  time. `memory`/`executionLog` are threaded into `PluginHostOptions` as
  lazy getters over module-level references assigned after
  `createAgentService()` resolves, mirroring the existing
  `backgroundAgentProvider` pattern — not constructed a second time inside
  `PluginHost`.
- A background-agent instance whose trigger declares `memory:read`/
  `execution:read` in `uses[]` **and has been explicitly confirmed through
  the new banner/dialog flow** can call the corresponding read-only tools,
  scoped to its bound workspace (plus global memory), with per-period
  budget enforcement and a capability-audit entry for every call — verified
  by tests that exercise the real `CapabilityGate`/`BudgetBreakerPort`
  chain, not a stub. An instance whose trigger declares either capability
  but has *not* been confirmed is denied, not silently granted.
- An instance whose trigger does *not* declare these capabilities never
  sees the tools in its model-facing tool list.
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
