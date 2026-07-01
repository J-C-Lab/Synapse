# Agent Run Tracing — Foundation Design

> Date: 2026-07-01 · Status: approved, pending implementation plan
> Phase 1 of the agent-architecture backlog (capability call-chain tracing). The
> `runId` primitive introduced here is deliberately the same one the later
> todo/plan mechanism and subagent isolation phases will hang their state on —
> see the `agent-architecture-backlog` memory for the full sequencing rationale.

## Guiding principle

**A capability decision without a run context is a fact with no story.** Synapse
already records *what* was decided (allow/deny) for every capability call via
`capability-audit.ts`. What's missing is the thread that ties a sequence of
those decisions — plus the tool calls that didn't need a capability at all —
back to the single agent run that produced them. Without that thread, "what
did the agent do when I asked it to clean up my inbox" can only be answered by
manually correlating timestamps across `audit.log` and the conversation
history.

## Goal (this phase)

Introduce a `runId` that is generated once per agent run (one user message →
tool-use loop → `end_turn`, or one trigger-woken background execution), thread
it through the existing tool-invocation path into the capability audit trail,
and persist a small per-run summary that lists which tools ran, in what order,
and how the run ended.

## Non-goals (deferred to later phases/specs)

- Any UI to browse or visualize traces — this phase is data model + storage
  only. The viewer will be designed together with the todo/plan UI (phase 2),
  since both need to show "what is/did this run do" to the user.
- Persisting tool call arguments or results in the trace itself (that data
  already exists in `conversation-store` and, for capability calls, in the
  redacted `audit.log`; the trace only indexes by `runId`).
- Cross-run analytics/aggregation.
- Subagent-scoped sub-runs (phase 3 — this phase's `runId` is one level, not a
  tree).

---

## 1. What "a run" is

A run is the span from one `AgentRuntime.run()` invocation to its return:

- **Interactive**: one user message enters the loop, the loop makes zero or
  more tool-use rounds (today capped at `maxSteps`, default 10), and returns on
  `end_turn`, `max_steps`, `aborted`, or `budget_exceeded`. A conversation with
  N user messages produces N runs.
- **Background/trigger-driven**: `background-agent-runner.ts` already mints a
  `runId` via `AgentBudgetLedger.start()` for token-budget bookkeeping
  (`agent-budget.ts:37`, `randomUUID()`). This phase reuses that exact ID
  instead of introducing a parallel one — trigger-driven runs and interactive
  runs share one `RunTrace` schema.
- **Non-agent background triggers** (`trigger-registry.ts:158`, `actor:
  "background"` when `decl.agent` is false) call a tool directly without ever
  going through `AgentRuntime.run()` — there is no loop, so there is no run.
  Their capability calls still get an `invocationId`-tagged `audit.log` entry
  as today; they just never produce a `RunTrace`. Only `"interactive"` and
  `"background-agent"` origins apply.

## 2. Data model

```ts
export interface RunTrace {
  runId: string
  conversationId?: string   // present for interactive runs
  invocationId?: string     // present for trigger-driven runs (background-invoker.ts)
  origin: "interactive" | "background-agent"
  startedAt: number
  endedAt: number
  outcome: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
  toolCalls: Array<{
    name: string      // fully-qualified tool name, as seen by AiToolRegistry
    startedAt: number
    ms: number
    ok: boolean
    error?: string    // short category only ("denied" | "timeout" | error.message) — no payloads
  }>
}
```

No tool arguments, results, or message text are duplicated here — that data
already lives in `conversation-store` (full message history) and `audit.log`
(redacted capability decisions). `RunTrace` is purely an index keyed by
`runId`; readers that want full detail on a specific tool call cross-reference
by `runId` + tool name + timestamp in those two existing stores.

`capability-audit.ts`'s `CapabilityAuditEntry` (`capability-gate.ts:52`) gains
one new optional field:

```ts
export interface CapabilityAuditEntry {
  // ...existing fields unchanged...
  runId?: string   // new — undefined for capability decisions made outside a run
                    // (e.g. a manual grant/revoke from Settings)
}
```

This is purely additive — existing `audit.log` lines (written before this
change) simply lack the field, and readers must treat it as optional.

## 3. Threading `runId` through existing code

The plumbing follows the exact pattern already used for `invocationId`
(background/trigger calls), which is the precedent for "a call-context field
that rides along on `ToolCaller` and gets copied into the capability
request/audit entry":

1. **`packages/plugin-sdk/src/tools.ts`** — `ToolCaller` gains `runId?: string`
   alongside the existing `conversationId` / `invocationId`.
2. **`agent-runtime.ts`** — `AgentRunOptions` gains an optional `runId?:
   string`. `AgentRuntime.run()` uses `options.runId ?? randomUUID()` once at
   the top of the method — background-agent-runner supplies its existing
   `AgentBudgetLedger.start()` id; interactive calls (which have none) get a
   freshly generated one. Either way it includes the resolved id in the default
   `caller` it builds at `agent-runtime.ts:152`. It also accumulates the
   `toolCalls` array from the existing `onEvent` callbacks (`tool_call` /
   `tool_result`, already emitted at lines 129/146/156/159) and, on return,
   hands the finished `RunTrace` to a new `recordRun(trace)` port (injected via
   `AgentRuntimeOptions`, defaulting to a no-op so existing tests/callers are
   unaffected).
3. **`background-agent-runner.ts`** — passes `runId: start.runId` through to
   `AgentRuntime.run()` instead of leaving it to generate its own, so the
   budget ledger's run and the trace's run are the same run.
4. **`plugin-bridge.ts`** — the `InvocationContext` gains `runId`, sourced from
   `options.caller.runId` in `createToolContext`. Two request-building paths
   must carry it:
   - the generic `ensure` wrapper in `createCapabilities` (~line 289) and the
     `createStorageAPI` wrapper (~line 649), which cover `storage`, `clipboard`,
     `system`, `fs`, etc.;
   - **the network path, which bypasses that wrapper.** `network.fetch` runs its
     own `gate.ensure` inside `createNetworkFetcher` (`network-fetcher.ts:403`),
     fed by the config object built at `plugin-bridge.ts:310`. `runId` must be
     added to `NetworkFetcherConfig` and threaded there too, or `network:https`
     would be the single capability whose audit entries silently lack `runId`.
5. **`capability-gate.ts`** — `CapabilityRequest` gains `runId?: string`
   (mirroring `invocationId?: string` at line 28); `ensure()`'s existing
   `this.options.audit({ ... })` call (line 207) copies it onto the
   `CapabilityAuditEntry` (only when present).

6. **`credential-broker.ts`** — the injection audit event (`auditEvent`,
   emitted from the closure returned by `createInjectCredential`) constructs its
   `CapabilityAuditEntry` directly rather than through `gate.ensure`, so it is
   the last capability-audit path that would otherwise miss `runId`.
   `createInjectCredential` gains a `runId?` arg (passed from `invocation.runId`
   at `plugin-bridge.ts:303`), and `auditEvent` forwards it. The connect /
   disconnect audit events are user-initiated, out-of-run actions and correctly
   leave `runId` undefined.

With (4)–(6), **every** capability-audit path carries `runId` during a run:
gate-driven (`storage`/`clipboard`/`system`/`fs`), network (`network:https`),
and credential injection (`credentials:broker`). There is no known
run-uncorrelated capability event after this phase.

No existing call site that doesn't have a `runId` (manual Settings actions,
tests) needs to change — the field is optional at every layer.

## 4. Storage & retention

- **`audit.log`**: unchanged file, unchanged sink (`capability-audit.ts`'s
  `createCapabilityAudit` + existing size-rotated `createFileSink`). Just one
  new optional field per line.
- **Run summaries**: new directory `{userDataDir}/logs/runs/`, one file per run
  named `{runId}.json`, written with a plain synchronous `fs.writeFileSync`
  (matching the sync-write, crash-safe philosophy of `file-sink.ts`) when
  `AgentRuntime.run()` returns — in a `try/catch`/`finally` so a disk error
  never fails the agent turn itself (log via the root `logger` and swallow).
- **runId as filename — validated at the store boundary**: `runId` becomes a
  filename, so `recordRun`/`getRunTrace` validate it against
  `^[A-Za-z0-9._-]+$` (and reject `.`, `..`, or anything containing `..`)
  before touching the filesystem. Real ids are UUIDs and always pass; a bogus
  or hostile id (path separators, traversal) is refused so it can never escape
  `logs/runs/`. This is a store-level invariant independent of who calls it —
  the store does not trust `AgentRunOptions.runId` to be well-formed just
  because today's callers pass UUIDs.
- **Retention**: unlike `audit.log`, per-run files don't self-rotate by size.
  `recordRun()` also does a cheap bounded prune: after writing, if the
  directory has more than `MAX_RUN_FILES` (500) entries, delete the oldest
  (by `startedAt` embedded in the filename-adjacent mtime, or by reading and
  sorting — directory is small enough that a full listing is fine at this
  scale). This mirrors the "keep N, drop oldest" spirit of log rotation
  without needing a single-file format.
- **Crash safety**: if the process crashes mid-run, no `runs/{runId}.json` is
  written — acceptable; the `audit.log` entries tagged with that `runId` are
  still directly queryable by grepping/filtering the log, they just won't show
  up in a `listRuns()` summary listing.

## 5. Query surface

Two new pure functions (no Electron imports, unit-testable), living alongside
the store:

```ts
// src/main/ai/run-trace-store.ts
function recordRun(dir: string, trace: RunTrace): void
function getRunTrace(dir: string, runId: string): RunTrace | undefined
function listRuns(dir: string, opts?: { conversationId?: string; limit?: number }): RunTrace[]
```

No IPC/renderer surface this phase (non-goal — no UI yet). These are called
from `AgentRuntime`/`background-agent-runner` (write side) only. The read side
(`getRunTrace`/`listRuns`) is unused by product code this phase but is unit
tested directly — it's the seam the phase-2 UI will call through an IPC
handler later, following the standard 4-touchpoint IPC pattern.

## 6. Error handling

- `recordRun` failures (disk full, permission error): caught inside the store,
  logged at `warn`, never thrown — must not break the agent loop or the
  user-visible turn.
- **Injected-recorder failures**: the `recordRun` port passed into
  `AgentRuntime` is arbitrary (a test double, or the background runner's
  outcome-rewriting wrapper), so it could throw even though the concrete store
  never does. `AgentRuntime.recordTrace()` therefore wraps its `record(trace)`
  call in its own `try/catch` (warn + swallow) — the "trace write never breaks
  the turn" guarantee holds regardless of what recorder is injected.
- **Background token-budget outcome**: `BackgroundAgentRunner` maps a
  token-budget abort to `stopReason: "budget_exceeded"` *after* `run()`
  returns, but the runtime records the trace *inside* `run()` (seeing only an
  abort). The runner wraps the injected `recordRun` to override the trace
  `outcome` to `"budget_exceeded"` when its `tokenBudgetExceeded` flag is set,
  so the persisted trace agrees with the reported stop reason. Timing is safe:
  the flag is set synchronously by `onExceeded()` before the abort propagates,
  so it is already correct when the runtime calls the recorder.
- `audit.log` lines without `runId` (pre-migration entries): `getRunTrace`
  filters by exact `runId` match, so old lines simply never match any new
  trace — no special-casing needed.
- Aborted runs (`signal` fired mid-loop): still produce a `RunTrace` with
  `outcome: "aborted"` and whatever `toolCalls` completed before the abort.

## 7. Testing

- `run-trace-store.test.ts`: round-trip `recordRun` → `getRunTrace`;
  `listRuns` filtering by `conversationId` and `limit`; prune behavior once
  `MAX_RUN_FILES` is exceeded; a best-effort write to an unwritable dir does
  not throw; a `runId` with path separators or `..` is refused (nothing written,
  no escape from `logs/runs/`).
- `agent-runtime.test.ts` (existing file, extend): a run accumulates a
  `toolCalls` array matching the `tool_call`/`tool_result` events already
  asserted in existing tests; two sequential `run()` calls on the same
  `conversationId` produce two distinct `runId`s; a supplied `options.runId`
  (background-agent path) is used verbatim instead of generating a new one; a
  `recordRun` port that throws does not break the turn (it still resolves
  `end_turn`).
- `plugin-bridge-runid.test.ts` (new): `caller.runId` reaches the
  `CapabilityRequest` for a storage-path tool call.
- `network-fetcher-runid.test.ts` (new): a `network:https` `gate.ensure`
  request carries the `runId` from `NetworkFetcherConfig`.
- `credential-broker.test.ts` (existing file, extend): the injection audit
  event (`trigger: "network:fetch"`) is tagged with the `runId` passed to
  `createInjectCredential`; connect/disconnect events leave it undefined.
- `background-agent-runner.test.ts` (existing file, extend): a background run's
  trace `runId` matches the ledger run and `origin` is `"background-agent"`; a
  token-budget abort records `outcome: "budget_exceeded"`, not `"aborted"`.
- `capability-audit.test.ts` (existing file, extend): an entry with `runId`
  set round-trips through `sanitizeAuditEntry` unchanged (it's not
  free-text, so no scrubbing needed on it); an entry without `runId` still
  serializes fine (back-compat).
- `capability-gate.test.ts` (existing file, extend): `ensure()` copies
  `request.runId` onto the audited entry.
