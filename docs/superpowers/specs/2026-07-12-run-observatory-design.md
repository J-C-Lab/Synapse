# S06 — Run Observatory

> Date: 2026-07-12 · Status: draft, pending review
> First spec of Phase 3 ("先可观察，再扩权") in the four-phase, ten-spec
> roadmap (S01-S10). Depends on S04 (RunProvenance Consolidation —
> complete, merged to `main`). Independent of S05 (Workspace Lifecycle —
> implementation in progress) for everything except one specific piece
> (workspace-name resolution for archived workspaces — flagged inline
> below, falls back gracefully until S05 lands).

## Why this is needed

Verified against the real repo on `main` (post-S04), not assumed.

- **`RunTrace` accumulates continuously with zero user-visible access.**
  `src/main/ai/run-trace-store.ts` exports `recordRun`/`getRunTrace`/
  `listRuns`/`getLatestPlan` (lines 54,68,79,99) — every one of them is
  called only from internal main-process modules (`agent-service.ts`,
  `agent-runtime.ts`, `background-agent-runner.ts`, `subagent-runner.ts`,
  `plugin-host.ts`, `synapse-mcp-server.ts`, `main/index.ts`,
  `mcp/stdio-entry.ts`). **No IPC channel exposes any of this today** —
  confirmed via a repo-wide search of `src/main/ipc/**`.
- **`listRuns()` can't answer the questions this spec needs to.** Its
  `opts` parameter (line 79-81) filters only by `conversationId` and
  `parentRunId`. No `origin`, `outcome`, `workspaceId`, or
  `triggerInstanceId` filter exists. `limit` is a post-sort truncation
  (line 91), not real pagination — no offset/cursor.
- **`RunTrace` is *not* purely metadata — this is the load-bearing
  correction from review.** The file's own header comment
  (`run-trace-store.ts:7-12`) claims it "does NOT duplicate tool
  arguments/results or message text," and `RunTraceToolCall.error`'s doc
  comment (line 20-21) promises "short category only... never a payload."
  Verified this promise is **already broken today**:
  `agent-runtime.ts:300-304`'s catch block does
  `const message = err instanceof Error ? err.message : String(err); record(false, message)`
  — the raw exception message is written straight into
  `RunTraceToolCall.error`. An exception message can contain file paths,
  URLs, provider response fragments, plugin-thrown free text, or in
  worst-case scenarios credential fragments. Today this is buried in
  per-run JSON files nobody browses; **the moment S06 ships a queryable
  IPC + UI, it turns a latent leak into a stable, browsable one.** This
  must be fixed as part of this spec, not deferred (see Architecture).
- **The correlation fields that make a "run trace" actually traceable are
  the ones easiest to leave out of a first UI pass.** `conversationId`,
  `invocationId`, and `parentRunId` are the fields that let one run be
  connected to its conversation, its trigger invocation, and its parent
  run — without surfacing and linking them, an "observatory" is just a
  flat table of JSON blobs, not a diagnostic tool.
- **Retention is real but simple**: `MAX_RUN_FILES = 500`
  (`run-trace-store.ts:42`), enforced by `prune()` (line 120-127) after
  every write — count-based (not age-based), global across the whole
  `runs/` directory (interactive/subagent/background-agent/mcp all share
  one cap). No per-origin or per-workspace retention exists or is being
  added.
- **No pagination/multi-field-filter IPC precedent exists anywhere in this
  app.** Every existing list-shaped channel (`ai:list-conversations`,
  `memory` list, `triggers:list-instances`) is zero-arg or identity-scoped,
  returning the full collection. S06 is the first channel of this shape —
  this spec sets the precedent (see Architecture's `normalizeRunListQuery`).

## Architecture

### Fix the error field before exposing it (must ship with this spec)

`agent-runtime.ts:300-304`'s catch block stops writing `err.message`.
Replace:

```ts
    } catch (err) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      const message = err instanceof Error ? err.message : String(err)
      record(false, message)
      return toolResult(call.id, message, true)
    }
```

with:

```ts
    } catch (err) {
      options.onEvent?.({ type: "tool_result", id: call.id, isError: true })
      const message = err instanceof Error ? err.message : String(err)
      record(false, options.signal?.aborted ? "aborted" : "exception")
      return toolResult(call.id, message, true)
    }
```

(`return toolResult(...)` still carries the real `message` back to the
*model* — that path is unrelated to persistence and untouched. Only what
gets written into `RunTraceToolCall.error` changes.) Combined with the two
existing call sites (`record(false, "denied")` at the approval-denied
branch, `record(!isError, isError ? "tool-error" : undefined)` at the
normal-result branch), `RunTraceToolCall.error` now has exactly four
possible values: `"denied" | "tool-error" | "aborted" | "exception"` —
genuinely "short category only," matching its doc comment for the first
time. `"timeout"` is deliberately not added as a category: nothing at this
generic catch site can reliably distinguish a timeout from any other
thrown error without deeper changes to the tool-invocation layer this spec
doesn't otherwise touch — inventing an always-empty category would be
worse than not having one.

**Historical trace files already on disk keep whatever free text was
written before this fix ships.** The IPC projection layer (below) maps any
`error` value outside the four-item allowlist to `"legacy-error"` before
it ever reaches the renderer — old files are never rewritten, but old
free text never leaves the main process either.

### `RunListFilter` and `listRuns()`'s extended signature

```ts
// run-trace-store.ts
export interface RunListFilter {
  conversationId?: string
  parentRunId?: string
  origin?: RunTrace["origin"]
  outcome?: RunTrace["outcome"]
  workspaceId?: string
  triggerInstanceId?: string
  limit?: number
}

export function listRuns(dir: string, opts: RunListFilter = {}): RunTrace[]
```

Same `readAll()`-then-filter-then-sort-then-slice implementation as today,
extended to check the three new fields alongside the existing two. This
stays a store-level capability used for two different purposes — the
Observatory's own child-run lookup (`{ parentRunId }`, see below) and any
future internal reuse — **not** the mechanism the renderer's filter
dropdowns use directly (see IPC section for why).

### `RunSummary` — the list projection, not the full trace

Returning full `RunTrace[]` (complete `toolCalls` and `plan` arrays) for
up to 500 records on every list call is real, avoidable overhead — most of
it never rendered until a specific run is opened. A summary projection:

```ts
// src/main/ipc/runs.ts
export interface RunSummary {
  runId: string
  origin: RunTrace["origin"]
  outcome: RunTrace["outcome"]
  conversationId?: string
  invocationId?: string
  parentRunId?: string
  workspaceId?: string
  triggerInstanceId?: string
  principal?: ToolPrincipal
  startedAt: number
  endedAt: number
  toolCallCount: number
  failedToolCallCount: number
  hasPlan: boolean
}

export function toRunSummary(trace: RunTrace): RunSummary {
  return {
    runId: trace.runId,
    origin: trace.origin,
    outcome: trace.outcome,
    conversationId: trace.conversationId,
    invocationId: trace.invocationId,
    parentRunId: trace.parentRunId,
    workspaceId: trace.workspaceId,
    triggerInstanceId: trace.triggerInstanceId,
    principal: trace.principal,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    toolCallCount: trace.toolCalls.length,
    failedToolCallCount: trace.toolCalls.filter((c) => !c.ok).length,
    hasPlan: Boolean(trace.plan && trace.plan.length > 0),
  }
}

const ALLOWED_ERROR_CATEGORIES = new Set(["denied", "tool-error", "aborted", "exception"])

export function toSafeRunTrace(trace: RunTrace): RunTrace {
  return {
    ...trace,
    toolCalls: trace.toolCalls.map((c) => ({
      ...c,
      error: c.error === undefined || ALLOWED_ERROR_CATEGORIES.has(c.error) ? c.error : "legacy-error",
    })),
  }
}
```

`runs:list` returns `RunSummary[]`; `runs:get` returns
`toSafeRunTrace(trace) | undefined` — the only place the legacy-error
allowlist is enforced, so every renderer-visible path (list *and* detail)
is covered by one projection.

### `runs.ts` IPC module — new file, not folded into `ai.ts`

```ts
// src/main/ipc/runs.ts
export interface RunListQuery {
  parentRunId?: string
}

export function normalizeRunListQuery(input: unknown): RunListQuery {
  if (input === undefined) return {}
  if (!input || typeof input !== "object") throw new Error("payload must be an object")
  const v = input as Record<string, unknown>
  if (v.parentRunId === undefined) return {}
  if (typeof v.parentRunId !== "string" || v.parentRunId.length === 0 || v.parentRunId.length > 200) {
    throw new Error("parentRunId must be a non-empty string")
  }
  return { parentRunId: v.parentRunId }
}
```

Two channels, both read-only, both behind the existing trusted-sender
`guard()` pattern every other `register*Ipc` function in this codebase
uses:

- **`runs:list(query?)`** — `query` is either omitted (returns the newest
  ≤500 `RunSummary[]`, no filter — see "Filtering happens client-side"
  below for why) or `{ parentRunId }` (returns every direct child of that
  run, for the Observatory's own parent/child correlation view).
  `normalizeRunListQuery()` validates the payload before it reaches
  `listRuns()`; an omitted/malformed `parentRunId` never reaches the
  store layer with a `.trim()`-free free-form string.
- **`runs:get(runId)`** — `requireString(runId, "runId")` (the same
  helper `ai.ts` already uses) validates the argument is a non-empty
  string before it's handed to `getRunTrace()`, which independently
  enforces its own `isSafeRunId()` filename-safety check
  (`run-trace-store.ts:48-52`) — two layers, matching this codebase's
  existing "IPC coerces the shape, the store re-validates independently"
  convention rather than trusting the IPC layer alone.

**Filtering happens client-side, not via repeated IPC calls.** The
dataset is capped at 500 records by `MAX_RUN_FILES`, and every call to
`listRuns()` is a full `readdirSync` + parse of the entire `runs/`
directory (`readAll()`, `run-trace-store.ts:106-118`) regardless of
filter — there is no per-filter shortcut, so firing a fresh IPC call on
every dropdown change would re-scan up to 500 files per keystroke-adjacent
interaction for no benefit. The renderer calls `runs:list()` once on page
load (and on an explicit refresh action), caches the `RunSummary[]`
result, and filters `origin`/`outcome`/`workspaceId` locally in memory.
`RunListFilter`'s `origin`/`outcome`/`workspaceId` fields exist on the
*store* for internal/future reuse (and because a filtered store call is
the right primitive to have even if this spec's own UI doesn't fire one
per keystroke) — the `runs:list` IPC channel itself only ever receives
`undefined` or `{ parentRunId }` from this spec's UI.

### Renderer: new top-level nav item, master-detail layout

`app-shell.tsx`'s `NavId` (line 82) gains `"runs"`, alongside a new nav
button following the existing `plugins`/`marketplace` pattern (lines
227-238). New page `src/renderer/src/components/pages/run-observatory-page.tsx`
follows `conversation-sidebar.tsx` + `chat-page.tsx`'s existing
master-detail structure (plain list, `onClick` selection, no
virtualization — consistent with every other list in this renderer, and
the dataset is capped at 500 rows):

- **List pane**: fetches `RunSummary[]` via `runs:list()` once, renders it
  as a scrollable list (runId prefix, origin badge, outcome badge,
  duration, tool-call count/failed-count). Three filter controls above the
  list (origin, outcome, workspace) apply client-side over the cached
  array — no additional IPC calls.
- **Detail pane**: `runs:get(runId)` on selection, renders the full safe
  `RunTrace` — `origin`/`principal`/`workspaceId`/`triggerInstanceId`,
  start/end time, outcome, every `toolCalls[]` entry (name, duration,
  ok/error category), `plan` steps if present, **and the three
  correlation fields**:
  - `conversationId` — a link that switches the app to the `cortex` (chat)
    nav and opens that conversation, if it still exists (a conversation
    can be deleted independently — `ai:delete-conversation` already
    exists — so this link degrades to plain text with a "conversation no
    longer exists" note when `ai:get-conversation` resolves nothing,
    rather than a dead link).
  - `parentRunId` — a link that calls `runs:get(parentRunId)` and switches
    the detail pane to that run. **If it resolves nothing, the pane shows
    "This run's history has aged out of the 500-run retention window,"
    not a generic not-found state** — the distinction is derivable
    without any new backend capability: the *current* run's own
    `parentRunId` field is proof the parent run existed at some point (the
    child could only have recorded that id if the parent run really ran),
    so a failed lookup for a value we already know was real is safely
    attributable to retention, not "never existed."
  - **Child runs** — a `runs:list({ parentRunId: currentRunId })` call
    lists every run whose `parentRunId` equals the currently-viewed run
    (subagent runs spawned by this one), each entry linking to switch the
    detail pane to that child.
- **Workspace filter/name display**: resolves workspace names via
  `listAiWorkspaces()`. **Dependency on S05, noted explicitly**: today (S05
  not yet merged) `list()` takes no arguments and already returns every
  workspace that exists, so no code changes are blocked. Once S05 lands
  (`list({ includeArchived: true })`), this call updates to pass that
  option so a trace referencing a since-archived workspace still resolves
  a real name instead of falling back to the raw id — until then, an
  unresolvable `workspaceId` (traces referencing a workspace that was
  never tracked, or whose record is gone) falls back to displaying the raw
  id string, which already works correctly with either signature.
- A static hint string near the list header: *"Run history retains the
  latest 500 runs."*

## Testing

- **`agent-runtime.test.ts`**: the catch-block fix — a thrown error with a
  message containing something sensitive-shaped (e.g. a fake path/token
  string) results in `RunTrace.toolCalls[0].error` being exactly
  `"exception"` (or `"aborted"` when `options.signal.aborted` is true at
  catch time), never the original message; the message returned to the
  *model* via `toolResult(...)` is unchanged (still the real text) — two
  separate assertions on the same call, since only the persisted field
  changes.
- **`run-trace-store.test.ts`**: `listRuns()` — new `origin`/`outcome`/
  `workspaceId`/`triggerInstanceId` filters, individually and combined
  with the existing `conversationId`/`parentRunId`; a filter matching zero
  records returns `[]`, not undefined/throw.
- **`runs.test.ts`** (new): `toRunSummary()` — exact field mapping,
  `toolCallCount`/`failedToolCallCount` computed correctly from a
  `toolCalls` array with a mix of `ok`/not-`ok` entries, `hasPlan` false
  for an absent or empty `plan`. `toSafeRunTrace()` — an `error` value
  outside the four-item allowlist (simulating a legacy file) is mapped to
  `"legacy-error"`; an allowed value passes through unchanged;
  `undefined` stays `undefined`. `normalizeRunListQuery()` — accepts
  `undefined` and `{}`; accepts a well-formed `parentRunId`; rejects a
  non-string, empty, or over-200-char `parentRunId`; rejects a non-object
  payload.
- **IPC registration tests**: both channels reject an untrusted sender via
  the existing `guard()` pattern (matching how other `register*Ipc` tests
  in this codebase already assert this); `runs:get` with a
  path-traversal-shaped runId (`"../escape"`) resolves `undefined`, not a
  thrown error or a read outside the runs directory — proving the
  IPC-level `requireString` and the store's own `isSafeRunId` both apply
  independently.
- **`run-observatory-page.test.tsx`** (new): renders a list from a mocked
  `runs:list()` response; client-side origin/outcome/workspace filtering
  narrows the visible list without triggering a second `runs:list` call;
  selecting a run calls `runs:get` and renders its detail; a `parentRunId`
  that fails to resolve renders the retention-aged-out message, not a
  generic not-found state; a `conversationId` link for a conversation that
  no longer exists renders as plain text with the "no longer exists" note.

## Non-goals

- **No capability-audit or host-resource-audit correlation.**
  `capability-audit.ts`'s `CapabilityAuditEntry` does carry `runId?`
  (`capability-gate.ts:71`), but it's written to a rotating log file
  (`audit.log`) with no index — joining it to a `RunTrace` today means
  parsing log text, not a store lookup. `host-resource-audit.ts`'s entry
  types have no `runId` field at all — that would need an upstream schema
  change before any join is even possible. Both are real, separate
  infrastructure projects (a queryable audit store/index, and a
  host-resource-audit schema change), deliberately deferred rather than
  folded into this spec.
- **No real pagination.** The dataset is hard-capped at 500 records by
  existing retention; `runs:list()` returns "the newest ≤500, optionally
  scoped to one run's children" with no offset/cursor.
- **No change to retention policy.** `MAX_RUN_FILES` stays global and
  count-based; no per-origin or per-workspace retention is added.
- **No general redaction framework.** The one real leak found during
  review (raw exception text in `toolCalls[].error`) is fixed at its
  source (the writer) plus a legacy-value allowlist at the IPC projection
  layer — this is not a general-purpose redaction/scrubbing system for
  arbitrary future fields, and no other field needed one (every other
  `RunTrace` field is already structured metadata: ids, timestamps, an
  outcome enum, tool names).
- **No index/cache layer for `RunTraceStore`.** `readAll()`'s full
  directory scan on every call is unchanged — the dataset is small enough
  (≤500 small JSON files) that this is not a real performance concern at
  this spec's scope, and adding one would be solving a problem that
  doesn't exist yet.

## Completion criteria

- `agent-runtime.ts`'s catch-block no longer writes raw exception text
  into a persisted `RunTrace` — `RunTraceToolCall.error` is one of exactly
  four values (`"denied" | "tool-error" | "aborted" | "exception"`) for
  every newly-recorded trace, with a regression test proving the model
  still receives the real error text via the return value.
- `listRuns()` filters on `origin`/`outcome`/`workspaceId`/
  `triggerInstanceId` in addition to the existing `conversationId`/
  `parentRunId`.
- `runs:list`/`runs:get` exist end-to-end (pure functions in
  `src/main/ipc/runs.ts` → registration → preload → `lib/electron.ts`),
  both behind the existing trusted-sender guard, both read-only.
  `runs:list` returns `RunSummary[]` (never a full `RunTrace[]`);
  `runs:get` returns a `toSafeRunTrace()`-projected single trace or
  `undefined`.
- `normalizeRunListQuery()` validates `runs:list`'s optional
  `{ parentRunId }` payload; `runs:get`'s `runId` argument goes through
  `requireString` before reaching the store's own independent
  `isSafeRunId()` check.
- A new "Runs" top-level nav item renders a master-detail Run Observatory:
  list with client-side origin/outcome/workspace filtering (single
  `runs:list()` call, no per-filter-change IPC traffic), detail pane
  showing every `RunTrace` field including `conversationId`/
  `invocationId`/`parentRunId`, a working parent-run link with a
  retention-aware empty state, and a child-runs list via
  `runs:list({ parentRunId })`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.

## Parked questions

- Capability/host-resource audit correlation (see Non-goals) — not yet
  assigned a spec number; would need a queryable audit index (for
  capability-audit) and a `runId` schema addition (for host-resource-audit)
  as prerequisites.
- Once S05 (Workspace Lifecycle) merges, `listAiWorkspaces()` in the
  workspace-filter dropdown should switch to
  `{ includeArchived: true }` so historical traces referencing a
  since-archived workspace resolve a real name — tracked here rather than
  as a blocking dependency, since the current no-argument call already
  degrades gracefully (returns every workspace that exists today; archived
  is not yet a concept on `main`).
