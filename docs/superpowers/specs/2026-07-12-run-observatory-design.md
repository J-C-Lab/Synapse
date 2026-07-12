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

**The writer's type is tightened too, not just its behavior — corrected
during review.** `RunTraceToolCall.error` stays a plain `error?: string`
today; nothing stops a future call site from writing arbitrary text again,
since the type itself doesn't forbid it. It becomes:

```ts
// run-trace-store.ts
export type RunTraceErrorCategory = "denied" | "tool-error" | "aborted" | "exception"

export interface RunTraceToolCall {
  name: string
  startedAt: number
  ms: number
  ok: boolean
  error?: RunTraceErrorCategory
}
```

`agent-runtime.ts`'s three `record(ok, error?)` call sites already only
ever pass one of these four literals after the fix above — this change
makes that invariant a compile-time guarantee, not just current behavior.
The renderer-facing type (below) is a separate, wider type
(`RunTraceErrorCategory | "legacy-error"`) so the persisted-data contract
and the renderer-display contract aren't silently coupled — a future fifth
write-side category doesn't require touching the renderer type, and
`"legacy-error"` can never accidentally leak into what gets persisted.

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

### `RunTrace` on disk is untrusted input, not a typed value — a real gap found during review

`getRunTrace()`/`readAll()` (`run-trace-store.ts:73,112`) do
`JSON.parse(...) as RunTrace` — a compile-time assertion, not a runtime
check. Any structurally-valid-but-wrong-shaped JSON on disk (a corrupted
write, a manually-edited file, a future format change) passes straight
through as if it were a real `RunTrace`. This spec's own first-draft
`toRunSummary()`/`toSafeRunTrace()` inherited that false trust: `trace
.toolCalls.length`/`.filter(...)` throws outright on a record with
`toolCalls: null`, which would fail the *entire* `runs:list` call for one
bad file among up to 500 good ones; `{ ...trace, toolCalls: ... }` spreads
every field on disk into the renderer-bound object, including anything
that isn't part of the real `RunTrace` shape at all.

The fix: a real normalizer at the IPC boundary that validates and
reconstructs field-by-field — never spreads — and treats a single
malformed file as "skip this one," not "fail the whole list":

```ts
// src/main/ipc/runs.ts
import type { PlanStep } from "../ai/plan/plan-types"
import type { RunTrace, RunTraceErrorCategory, RunTraceToolCall } from "../ai/run-trace-store"
import type { ToolPrincipal } from "@synapse/plugin-sdk"

const ORIGINS = new Set<string>(["interactive", "background-agent", "subagent", "mcp"])
const OUTCOMES = new Set<string>(["end_turn", "max_steps", "aborted", "budget_exceeded", "error"])
const ERROR_CATEGORIES = new Set<string>(["denied", "tool-error", "aborted", "exception"])
const PLAN_STATUSES = new Set<string>(["pending", "in_progress", "completed"])

export type RendererRunTraceError = RunTraceErrorCategory | "legacy-error"

export interface RendererToolCall {
  name: string
  startedAt: number
  ms: number
  ok: boolean
  error?: RendererRunTraceError
}

export interface RendererRunTrace {
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
  toolCalls: RendererToolCall[]
  plan?: PlanStep[]
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function normalizeToolCall(value: unknown): RendererToolCall | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (
    typeof v.name !== "string" ||
    typeof v.startedAt !== "number" ||
    typeof v.ms !== "number" ||
    typeof v.ok !== "boolean"
  ) {
    return undefined
  }
  const rawError = optionalString(v.error)
  const error: RendererRunTraceError | undefined =
    rawError === undefined ? undefined : ERROR_CATEGORIES.has(rawError) ? (rawError as RunTraceErrorCategory) : "legacy-error"
  return { name: v.name, startedAt: v.startedAt, ms: v.ms, ok: v.ok, ...(error !== undefined ? { error } : {}) }
}

function normalizePlanStep(value: unknown): PlanStep | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.title !== "string" || typeof v.status !== "string" || !PLAN_STATUSES.has(v.status)) {
    return undefined
  }
  return { title: v.title.slice(0, 500), status: v.status as PlanStep["status"] }
}

/** Validates and reconstructs a value read off disk into a renderer-safe
 *  shape, field by field — never `{ ...value }`. Returns undefined for a
 *  structurally invalid record (caller skips it, doesn't fail the whole
 *  list) rather than throwing. */
export function normalizeRunTraceForRenderer(value: unknown): RendererRunTrace | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.runId !== "string") return undefined
  if (typeof v.origin !== "string" || !ORIGINS.has(v.origin)) return undefined
  if (typeof v.outcome !== "string" || !OUTCOMES.has(v.outcome)) return undefined
  if (typeof v.startedAt !== "number" || typeof v.endedAt !== "number") return undefined

  const toolCalls = Array.isArray(v.toolCalls)
    ? v.toolCalls.map(normalizeToolCall).filter((c): c is RendererToolCall => c !== undefined)
    : []
  const plan = Array.isArray(v.plan)
    ? v.plan.map(normalizePlanStep).filter((s): s is PlanStep => s !== undefined)
    : undefined

  return {
    runId: v.runId,
    origin: v.origin as RunTrace["origin"],
    outcome: v.outcome as RunTrace["outcome"],
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    conversationId: optionalString(v.conversationId),
    invocationId: optionalString(v.invocationId),
    parentRunId: optionalString(v.parentRunId),
    workspaceId: optionalString(v.workspaceId),
    triggerInstanceId: optionalString(v.triggerInstanceId),
    principal: v.principal as ToolPrincipal | undefined, // ToolPrincipal is a
    // plugin-sdk discriminated union already; a full recursive validator for
    // it is out of scope here — an unrecognized shape just won't match any
    // renderer switch-case and renders as "unknown", it can't inject markup
    // (see the plan[].title rendering note below) or crash the page.
    toolCalls,
    ...(plan && plan.length > 0 ? { plan } : {}),
  }
}
```

### `RunSummary` — the list projection, built from the normalized value

```ts
// src/main/ipc/runs.ts (continued)
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

export function toRunSummary(trace: RendererRunTrace): RunSummary {
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
```

`runs:list` calls `listRuns()`, runs every result through
`normalizeRunTraceForRenderer()`, drops anything that normalizes to
`undefined` (logging a warning with the filename, not the content), and
maps the rest through `toRunSummary()`. `runs:get` calls `getRunTrace()`
then `normalizeRunTraceForRenderer()` directly — a single malformed file
here just resolves `undefined` (the same "not found" shape `getRunTrace`
already returns for a missing file, so the renderer doesn't need a third
state to handle). Both paths go through the same normalizer — there's only
one place that decides what's safe to send to the renderer.

### Shared IPC validation helper — `requireString` isn't reusable today

**Corrected during review**: `requireString` (`ai.ts:398`) has no `export`
keyword — private to that file. `runs.ts` can't import it as drafted. It
moves to a new, small, shared module:

```ts
// src/main/ipc/validation.ts (new file)
export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string.`)
  return value
}
```

`ai.ts`'s own private copy is deleted; it imports `requireString` from
`./validation` instead — one definition, not two copies drifting apart.
`runs.ts` imports the same one.

### `runTraceDir()` — the one place the runs directory path is computed

**Also corrected during review**: `runsDir` (`main/index.ts:882`) is a
`const` local to the function that wires up `AgentService`, and
`registerAiIpc(...)` (`main/index.ts:434`) is called from a different
place in the same file, in a different scope — the spec as first drafted
never said how a future `registerRunsIpc(...)` call would get a directory
path at all. Rather than threading `runsDir` across scopes, the path
becomes a pure, deterministic function of `userDataDir` (which is already
available everywhere `main/index.ts` wires up IPC):

```ts
// run-trace-store.ts
export function runTraceDir(userDataDir: string): string {
  return path.join(userDataDir, "logs", "runs")
}
```

`main/index.ts`'s existing `const runsDir = path.join(userDataDir, "logs", "runs")`
(line 882) becomes `const runsDir = runTraceDir(userDataDir)` — same
value, now defined once. The new `registerRunsIpc(ipcMain, runTraceDir(userDataDir), { isTrustedSender: isTrustedIpcSender })`
call is added next to the existing `registerAiIpc(...)` call (line 434),
computing the same path independently from the same `userDataDir` — no
cross-scope variable threading needed.

### `runs.ts` IPC module — new file, not folded into `ai.ts`

```ts
// src/main/ipc/runs.ts (continued)
export interface RunListQuery {
  parentRunId?: string
}

export function normalizeRunListQuery(input: unknown): RunListQuery {
  if (input === undefined) return {}
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("payload must be an object")
  }
  const v = input as Record<string, unknown>
  const keys = Object.keys(v)
  if (keys.length === 0) return {}
  if (keys.some((key) => key !== "parentRunId")) {
    throw new Error("unexpected field in payload")
  }
  const parentRunId = requireString(v.parentRunId, "parentRunId").trim()
  if (!parentRunId) throw new Error("parentRunId must be a non-empty string")
  if (parentRunId.length > 200) throw new Error("parentRunId is too long")
  return { parentRunId }
}
```

**Tightened during review**: the first draft accepted an array (`[]` is
`typeof "object"` in JS), silently ignored a typo'd key like
`parentRunID` (falling through to `{}`, returning all 500 records instead
of erroring), and accepted a whitespace-only `parentRunId`. The version
above rejects arrays explicitly, rejects any key other than
`parentRunId`, and rejects blank/whitespace-only values after
`requireString` — a typo or malformed payload now fails loudly instead of
silently widening the query.

Two channels, both read-only, both behind the existing trusted-sender
`guard()` pattern every other `register*Ipc` function in this codebase
uses:

- **`runs:list(query?)`** — `query` is either omitted (returns the newest
  ≤500 `RunSummary[]`, no filter — see "Filtering happens client-side"
  below for why) or `{ parentRunId }` (returns every direct child of that
  run, for the Observatory's own parent/child correlation view).
  `normalizeRunListQuery()` validates the payload before it reaches
  `listRuns()`.
- **`runs:get(runId)`** — `requireString(runId, "runId")` (now imported
  from the shared `validation.ts`) validates the argument is a non-empty
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
    "Parent run trace is unavailable. It may have aged out of retention or
    failed to persist," not a bare "not found."** **Softened during
    review**: the first draft claimed a missing parent could be confidently
    attributed to retention, reasoning that the current run's own
    `parentRunId` field proves the parent run existed. That's true — but it
    doesn't prove the parent's *trace file* was ever successfully written.
    `recordRun()` is deliberately best-effort (`run-trace-store.ts:54-66`'s
    own comment: "a disk error must never fail the agent turn") — a parent
    trace can be missing because it aged out of the 500-run cap, *or*
    because the write failed, the JSON was corrupted and silently dropped
    by `readAll()`'s catch-and-skip (`run-trace-store.ts:113-115`), the
    file was deleted outside the app, or the process crashed before the
    parent's `recordRun()` call ran at all. None of these are
    distinguishable from a missing-file lookup today — the message says
    "unavailable, possibly one of several reasons," not a specific,
    unverifiable claim. (A future spec could add a prune tombstone to make
    "aged out of retention" a real, checkable fact — out of scope here.)
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
- **`runs.test.ts`** (new):
  - `normalizeRunTraceForRenderer()` — a well-formed value round-trips
    with every field intact; a value with `toolCalls: null` normalizes to
    `toolCalls: []` rather than throwing (**the malformed-but-valid-JSON
    regression test called out in review** — `{"runId":"x","toolCalls":null}`
    is syntactically valid JSON that would have crashed the first draft's
    `.length` access); an unrecognized `origin`/`outcome` value resolves
    `undefined` for the whole trace; an extra unrecognized top-level field
    (e.g. `{"runId":"x", "origin":"interactive", ..., "secretField":"leak"}`)
    is silently dropped, not present anywhere on the returned object —
    proving the field-by-field reconstruction, not a spread, is what's
    actually running; one malformed `toolCalls[]` entry among several valid
    ones is dropped individually, the rest still normalize.
  - `toRunSummary()` — exact field mapping, `toolCallCount`/
    `failedToolCallCount` computed correctly from a `toolCalls` array with
    a mix of `ok`/not-`ok` entries, `hasPlan` false for an absent or empty
    `plan`.
  - `normalizeRunListQuery()` — accepts `undefined` and `{}`; accepts a
    well-formed `parentRunId`; rejects a non-string, empty-after-trim, or
    over-200-char `parentRunId`; rejects a non-object payload; **rejects an
    array** (`[]`); **rejects a payload with an unrecognized key**
    (`{ parentRunID: "x" }`, the typo case — must throw, not silently
    return `{}`).
- **IPC registration tests**: both channels reject an untrusted sender via
  the existing `guard()` pattern (matching how other `register*Ipc` tests
  in this codebase already assert this); `runs:get` with a
  path-traversal-shaped runId (`"../escape"`) resolves `undefined`, not a
  thrown error or a read outside the runs directory — proving the
  IPC-level `requireString` and the store's own `isSafeRunId` both apply
  independently; `runs:list` against a `runs/` directory containing one
  malformed-but-parseable JSON file among several valid ones returns every
  valid `RunSummary` and silently omits only the bad one — the call itself
  never throws.
- **`run-observatory-page.test.tsx`** (new): renders a list from a mocked
  `runs:list()` response; client-side origin/outcome/workspace filtering
  narrows the visible list without triggering a second `runs:list` call;
  selecting a run calls `runs:get` and renders its detail; a `parentRunId`
  that fails to resolve renders the "Parent run trace is unavailable..."
  message, not a bare not-found state; a `conversationId` link for a
  conversation that no longer exists renders as plain text with the "no
  longer exists" note.

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
  arbitrary future fields. **Precision added during review**: this is not
  the same claim as "every other field is inert." `plan[].title`
  (`PlanStep.title`) is model-generated free text, not a closed enum like
  `origin`/`outcome` — it can legitimately be arbitrary content, and
  `normalizeRunTraceForRenderer()` caps it at 500 characters as a sanity
  bound, not a redaction. It's safe to *display* precisely because the
  renderer only ever renders it as plain, React-escaped text — no
  `dangerouslySetInnerHTML`, no Markdown rendering of trace content — so
  it can't inject markup regardless of what a plugin or the model put in
  it. That's a display-safety guarantee (markup-injection-proof by
  construction), not a content-redaction one; the two are being
  deliberately kept distinct rather than conflated as "safe" in one
  blanket sense.
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
  `runs:get` returns a `normalizeRunTraceForRenderer()`-projected
  `RendererRunTrace` or `undefined`.
- `normalizeRunListQuery()` validates `runs:list`'s optional
  `{ parentRunId }` payload; `runs:get`'s `runId` argument goes through
  `requireString` before reaching the store's own independent
  `isSafeRunId()` check.
- A new "Runs" top-level nav item renders a master-detail Run Observatory:
  list with client-side origin/outcome/workspace filtering (single
  `runs:list()` call, no per-filter-change IPC traffic), detail pane
  showing every `RunTrace` field including `conversationId`/
  `invocationId`/`parentRunId`, a working parent-run link with an
  "unavailable" empty state that doesn't overclaim a specific cause, and a
  child-runs list via `runs:list({ parentRunId })`.
- `normalizeRunTraceForRenderer()` validates every field of a value read
  off disk before any of it reaches the renderer — never `{ ...value }` —
  and a single malformed trace file is skipped (list) or resolves
  `undefined` (get), never fails the whole call. `RunTraceToolCall.error`
  is typed as a closed `RunTraceErrorCategory` union at the write side, not
  a plain `string`.
- `requireString` lives in one place (`src/main/ipc/validation.ts`),
  imported by both `ai.ts` and `runs.ts`; `runTraceDir(userDataDir)` is the
  one function that computes the runs directory path, used by both
  `main/index.ts`'s existing `AgentService` wiring and the new
  `registerRunsIpc(...)` call.
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
