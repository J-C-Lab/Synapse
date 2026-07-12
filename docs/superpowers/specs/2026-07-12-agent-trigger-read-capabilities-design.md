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
  use** — the user approves once when the plugin declares the `uses[]`
  entry (at install/enable time, the existing grant flow every other
  `consent`/`elevated` capability already uses for trigger declarations),
  and every subsequent fire debits budget silently, no runtime prompt.
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

### Read-only tool sources

Two new files, narrowly read-only by construction (no write/patch/shell path
exists to disable — it's simply never built):

- **`src/main/ai/memory/memory-read-tools.ts`** — `MemoryReadOnlyToolSource`,
  exposing only `memory_search`/`memory_list` (the two tools
  `memory-tools.ts`'s existing `TOOLS` array already marks
  `readOnlyHint: true`, lines 61-93). Reuses `memory-scope.ts`'s
  `queryScopeForCaller`/`entryMatchesQuery` unchanged. Each descriptor's
  `manifestTool.capabilities` is `[{ id: "memory:read" }]`.
- **`src/main/ai/execution/execution-read-tools.ts`** —
  `ExecutionReadOnlyToolSource`, exposing only `list_files`/`read_file`/
  `search_files` (`execution-tool-host.ts`'s three `readOnlyHint: true`
  descriptors, lines 36-87). Reuses `file-tools.ts`/`WorkspacePolicy`
  unchanged — `apply_patch`/`run_command` (the `destructiveHint: true`
  pair) are never constructed into this source at all. Each descriptor's
  `manifestTool.capabilities` is `[{ id: "execution:read" }]`.

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
  const entry = this.registry.get(request.pluginId)  // re-resolved now, not a captured/stale manifest
  if (!entry) throw new Error(`Unknown plugin: ${request.pluginId}`)

  const authorizer = this.bridge.createBackgroundHostToolAuthorizer(request.pluginId, entry.manifest)
  const governed = new GovernedBackgroundToolHost({
    authorizer,
    sources: [this.memoryReadSource, this.executionReadSource],  // constructed once in the constructor
  })
  const tools = new CompositeToolHost([governed, asFallbackSource(this, governed.ownsTool)])

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

`governed` is claimed first in the `CompositeToolHost`'s source list; it
only ever claims the 5 fqNames its two sources produce
(`memory:core/memory_search`, `memory:core/memory_list`,
`execution:core/list_files`, `execution:core/read_file`,
`execution:core/search_files` — never a whole-namespace prefix claim, so a
future *write* tool added under the same `memory:`/`execution:` prefix is
never accidentally routed into the unrestricted background path).
`asFallbackSource(this, governed.ownsTool)` claims everything else,
preserving today's plugin-tool behavior unchanged.

`PluginHostOptions` gains one new optional constructor dependency to build
`this.memoryReadSource`/`this.executionReadSource` once — `workspaceRoots`
(already required, unchanged) is reused as-is for `executionReadSource`:

```ts
memory?: MemoryService  // absent when the AI memory feature itself is unconfigured
```

(Mirrors `src/main/index.ts`'s own existing `if (memoryService) { ... }`
conditional gating for the interactive path — when memory is unconfigured,
`this.memoryReadSource` still constructs but its `listTools()` returns
nothing, exactly like `ExecutionToolHostSource`'s own
`anyRootsExist`-gated `listTools()` already does when no `WorkspaceRoot`
exists for the calling workspace.)

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
  (the `includeGlobal: true` regression test).
- **`execution-read-tools.test.ts`** (new): `ExecutionReadOnlyToolSource.listTools()`
  returns exactly `list_files`/`read_file`/`search_files`, each tagged
  `capabilities: [{id: "execution:read"}]`; a path-escape attempt through
  `read_file`/`search_files` is rejected by the same `WorkspacePolicy`
  fencing the interactive path already relies on (reusing
  `workspace-policy.test.ts`'s existing attack-path fixtures, not
  reinventing them).
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
  `toolCapabilitiesAllowed` behavior for plugin tools) — both regression
  tests reuse this file's existing `writeHostPlugin()`/`hostOptions()`
  harness pattern. A companion test confirms budget exhaustion (fire past
  `uses[].budget.maxCalls`) denies the Nth call without denying the
  `maxToolCallsPerRun` cap's own independent accounting.
- **`capabilities.test.ts`** (`packages/plugin-manifest`): `memory:read`/
  `execution:read` round-trip through `getCapability()`/
  `capabilityEntrySchema` like every other registry entry; a manifest
  declaring `uses: [{capability: "memory:read", budget: {...}}]` with no
  top-level `capabilities` entry validates successfully (the
  `mergeDeclaredWithTriggerUses` regression this spec depends on).
- **No renderer changes** in this spec — nothing here is user-facing beyond
  the existing consent-grant UI already used for every other `consent`-tier
  capability (unchanged; this spec adds two new ids to an existing flow, not
  a new flow).

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

## Completion criteria

- `memory:read`/`execution:read` exist in the central capability registry,
  `consent` tier, unscoped, and validate correctly through
  `capabilityEntrySchema` and `mergeDeclaredWithTriggerUses()`.
- `MemoryReadOnlyToolSource`/`ExecutionReadOnlyToolSource` exist, each
  exposing exactly the read-only subset of their existing counterpart's
  tools, each descriptor tagged with exactly one of the two new
  capability ids.
- `GovernedBackgroundToolHost` calls `PluginBridge.createBackgroundHostToolAuthorizer(...).ensure()`
  before every delegated invocation, resolving the capability id from the
  tool descriptor (not a hand-maintained map), denying without delegating
  on failure, debiting exactly once per call.
- `PluginHost.dispatchBackgroundAgent()` composes
  `CompositeToolHost([governed, asFallbackSource(this, governed.ownsTool)])`
  in place of the old bare `tools: this`, re-resolving the plugin's live
  registry entry (not a captured/stale manifest) at dispatch time.
- A background-agent instance whose trigger declares `memory:read`/
  `execution:read` in `uses[]` can call the corresponding read-only tools,
  scoped to its bound workspace (plus global memory), with per-period
  budget enforcement and a capability-audit entry for every call — verified
  by tests that exercise the real `CapabilityGate`/`BudgetBreakerPort`
  chain, not a stub.
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
