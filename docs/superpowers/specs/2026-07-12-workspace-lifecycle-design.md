# S05 — Workspace Lifecycle & Referential Integrity

> Date: 2026-07-12 · Status: draft, pending review
> Second spec of Phase 2 ("收束共享基座") in the four-phase, ten-spec roadmap
> (S01-S10), alongside S04 (RunProvenance Consolidation, spec/plan complete,
> implementation in progress by the user — no hard dependency between the
> two; this spec was brainstormed in parallel). Full roadmap status tracked
> in project memory `s01-s10-roadmap-status.md`.

## Why this is needed

Verified against the real repo, not assumed.

- **`Workspace.id` is not a stable identifier — it's a slug derived from
  `name` at creation time**, and nothing else ever changes it because
  nothing can: `WorkspaceStore` (`src/main/ai/workspace/workspace-store.ts`)
  exposes only `list()`, `get()`, `exists()`, `create()` (lines 18-42) —
  **no `rename`, `archive`, `delete`, or `remove` method exists, partial or
  otherwise.** `create()` (lines 30-42) generates `id` via `uniqueSlug()`
  (lines 65-75: lowercase, non-alphanumeric → `-`, collision-suffixed
  `-2`/`-3`...) and never touches it again. Six other modules already treat
  this `id` as a stable foreign key — `StoredConversation.workspaceId`
  (`conversation-store.ts:13`), `MemoryScope.workspaceId`
  (`memory-store.ts:21`, optional), `WorkspaceRootRecord.workspaceId`
  (`execution/types.ts`, required), `TriggerInstanceRecord.workspaceId`
  (`trigger-instance-store.ts:9`, required), `RunTrace.workspaceId`
  (`run-trace-store.ts:31`, optional), and the external-MCP env pipeline
  (`SYNAPSE_MCP_WORKSPACE` read at `stdio-entry.ts:113`) — but there is no
  path today to change a workspace's display name without inventing a new
  workspace and re-pointing all six by hand.
- **No archive/pause/hide lifecycle exists at all.** The only UI surface,
  `workspace-switcher.tsx`, exposes switch and create (lines 37-108) plus a
  "Manage roots" entry into `WorkspaceRootManager` (109-122) — which manages
  `WorkspaceRoot` folder mounts, a different entity, not the workspace
  itself. The IPC layer mirrors this exactly: `ai:list-workspaces` and
  `ai:create-workspace` (`src/main/ipc/ai.ts:131-137`) are the entire
  workspace-entity surface; everything else workspace-adjacent
  (`ai:list-workspace-roots`, `ai:remove-workspace-root`, etc., lines
  36-46, 139-158) is scoped to `WorkspaceRoot`. A workspace, once created,
  can only ever be switched to or left alone — never renamed, hidden, or
  removed.
- **A workspace with a bound background-agent trigger has no way to be
  taken offline without deleting the trigger itself.**
  `TriggerInstanceRecord` (`trigger-instance-store.ts:9`) already has a
  `paused` field, filtered on at `trigger-registry.ts:327-329`'s
  `liveInstances` computation (`!i.paused && identity && sameIdentity(...)`)
  — but that's a per-instance, user-set pause, unrelated to the workspace it
  belongs to. There is no mechanism today that stops a trigger from firing,
  spending AI budget, and creating new conversations in a workspace the
  user has stopped actively using but never explicitly paused every
  instance in.
- **Six independent persistence topologies, no cross-store transaction.**
  `workspace-store.ts` and `workspace-root-store.ts` are single JSON-array
  files; `memory-store.ts` is a single JSON-array file loaded in memory;
  `trigger-instance-store.ts` is a single JSON object with an in-process
  mutex (`runExclusive`, lines 143-150); `conversation-store.ts` and
  `run-trace-store.ts` are one-file-per-record directories. `atomic-json-
  store.ts` only guarantees atomicity of a *single* file's write. This
  repo-wide fact is why this spec deliberately does not attempt real
  deletion (see Non-goals) — a true cross-store cascade delete with partial-
  failure recovery is a separate, much larger problem than establishing a
  stable id and a reversible archive flag.

## Architecture

### `id`/`name` decoupling — `id` becomes permanent

`Workspace.id`, once assigned at `create()` time via the existing
`uniqueSlug()` logic, never changes again. `name` becomes independently
mutable via a new `rename()` method. This is the same split every
comparable system uses (a GitHub repo's id vs. its name, a Slack channel's
id vs. its name) — the six existing foreign-key holders never need to learn
about a rename, because the value they store never changes.

```ts
// src/main/ai/workspace/workspace-store.ts
export interface Workspace {
  id: string
  name: string
  createdAt: number
  /** Absent (not `false`) for every workspace archived before this field
   *  existed and every currently-active workspace — keeps the on-disk
   *  shape backward compatible; only ever written `true`. */
  archived?: boolean
}
```

`isWorkspace()`'s type guard (lines 55-63) gains a check that `archived`,
when present, is a `boolean` — same defensive-read posture the rest of the
guard already has for `id`/`name`/`createdAt`.

### Lifecycle methods

**A real, confirmed correctness bug in an earlier revision of this spec,
caught during review**: `get()` and `exists()` are *not* independent of
`list()` today — `src/main/ai/workspace/workspace-store.ts:22-28` implements
both as `(await this.list()).find/some(...)`. If `list()`'s default
excludes archived workspaces (as this spec requires), leaving `get()`/
`exists()` "unchanged" would silently make them do the same — breaking
every real caller that relies on `exists()` meaning "is this a known
workspace id" rather than "is this an *active* workspace id". Confirmed two
such callers on `main`: `agent-service.ts:392`
(`createConversation`'s `workspaces?.exists(workspaceId)` gate) and
`plugin-host.ts:564` (`workspaceExists()`, exposed for referential-integrity
checks elsewhere). Both would start throwing/denying on a merely-archived
(not deleted) workspace — exactly the referential-integrity regression this
spec exists to prevent.

The fix: `get()`/`exists()` keep resolving archived workspaces (they answer
"does this id represent a real workspace," which archiving never changes);
two new methods answer the *active* question explicitly.

```ts
export class WorkspaceStore {
  // existing signatures unchanged in shape, but their semantics are now
  // explicit: both resolve archived workspaces too (an archived workspace
  // is still a real workspace with a real id).
  async get(id: string): Promise<Workspace | undefined>
  async exists(id: string): Promise<boolean>
  async create(name: string): Promise<Workspace>

  async list(options?: { includeArchived?: boolean }): Promise<Workspace[]>
  async rename(id: string, name: string): Promise<Workspace>
  async archive(id: string): Promise<Workspace>
  async unarchive(id: string): Promise<Workspace>

  /** True only for a real, non-archived workspace. False for archived,
   *  false for unknown — the "can this be used right now" question. */
  async isActive(id: string): Promise<boolean>
  /** True only for a real, archived workspace. False for active, false
   *  for unknown. */
  async isArchived(id: string): Promise<boolean>
}
```

- **`get()`/`exists()` internally call `list({ includeArchived: true })`**
  — a real behavior change from the current implementation (which
  transitively calls the plain `list()`), needed precisely because `list()`
  itself is changing default behavior underneath them. Every other existing
  caller of `get`/`exists` keeps working exactly as before, because
  archived workspaces didn't exist before this spec — there is nothing to
  regress for pre-S05 callers, only a latent trap for post-S05 archived
  ones that this fix closes.
- **`list({ includeArchived: true })`** — default `false`, matching
  today's implicit behavior for direct `list()` callers (e.g. the
  workspace switcher). `includeArchived: true` is opt-in for the new
  Settings surface (below) and internally by `get()`/`exists()`.
- **`isActive(id)`/`isArchived(id)`** — thin wrappers over `get()`,
  returning `false` (not throwing) for an unknown id in both cases. These
  are what callers that specifically care about "is this usable right now"
  migrate to: `agent-service.ts:392`'s `createConversation` gate moves from
  `exists()` to `isActive()` (an archived workspace should not silently
  gain new conversations — that *is* the intended effect of archiving);
  `TriggerRegistry`'s archived check (below) uses `isArchived()` directly
  rather than reading `.archived` off a `Workspace` object.
- **`rename(id, name)`** — validates non-empty `name` (same trim-and-
  reject-empty rule as `create()`, line 31-32); rejects `id === "default"`
  (`DEFAULT_WORKSPACE`'s name is fixed, matching its already-fixed identity)
  and unknown `id`. Does **not** re-derive or touch `id`.
- **`archive(id)` / `unarchive(id)`** — persist the state change. **Made
  explicit during review**, resolving a self-contradiction in an earlier
  revision (the type comment said `archived` is "only ever written `true`"
  while the prose said `unarchive()` "flips" it — flipping a boolean
  naturally means writing `false`, which contradicts "only ever `true`"):
  `archive()` sets `archived: true`; `unarchive()` **deletes the `archived`
  property entirely** (`{ ...workspace, archived: undefined }` is not the
  same thing — the property must be actually absent, e.g. via destructuring
  it out, not present-with-value-`undefined`, since `JSON.stringify` drops
  the latter automatically but a naive implementation could still leave an
  explicit `false` if written carelessly). A dedicated test asserts that
  after `unarchive()`, the record round-tripped through `writeJsonFile()`
  contains no `"archived"` key at all — not `false`. Both `archive`/
  `unarchive` reject `id === "default"`: `DEFAULT_WORKSPACE` is not part of
  the persisted array at all (`readStored()` filters it out, line 51) and
  is always prepended by `list()` (line 19) — it has no lifecycle to enter
  or leave. Both reject an unknown `id`. `archive()` on an already-archived
  workspace and `unarchive()` on an already-active one are no-ops that
  succeed (idempotent, matching the rest of this store's forgiving style).

None of the six foreign-key-holding stores are touched by `archive()`/
`unarchive()` — no cascade write, no cross-store transaction, because no
data referenced by `workspaceId` is deleted, moved, or invalidated. This is
the direct consequence of scoping this spec to archive only (see
Non-goals): the six-store, three-topology coordination problem the original
gap described only exists for *deletion*, not for a reversible visibility
flag.

### Concurrent mutations can silently lose an update — needs a mutex

**A second confirmed bug caught during review.** `writeJsonFile()`
(`src/main/lan/atomic-json-store.ts:16-31`) serializes only the *write*
call itself via a per-path promise chain (`writeChains`) — the *read* that
happens before it (`readStored()`, called at the top of `create()`/
`rename()`/`archive()`/`unarchive()`) is not part of that chain. Two
concurrent calls — e.g. a `rename()` and an `archive()` racing on the same
workspace — can both read the same pre-mutation array, each compute their
own modified copy, and then both call `writeJsonFile()`; the writes
themselves don't corrupt each other (the chain prevents a torn file), but
the second write's result silently overwrites the first mutation's effect.
This already exists as a latent risk for `create()` alone today, but S05
adding three more mutation entry points on the *same* records makes a real
lost-update a realistic outcome, not a theoretical one.

Fix: `WorkspaceStore` gets an instance-level mutex — the same pattern
`trigger-instance-store.ts:143-150`'s `runExclusive` already establishes in
this codebase — wrapping the full read-modify-write cycle of `create()`,
`rename()`, `archive()`, and `unarchive()`:

```ts
export class WorkspaceStore {
  private readonly mutex = runExclusive() // same helper trigger-instance-store.ts uses

  async create(name: string): Promise<Workspace> {
    return this.mutex(async () => {
      /* existing read-modify-write body */
    })
  }
  // rename/archive/unarchive wrapped identically
}
```

`list()`/`get()`/`exists()`/`isActive()`/`isArchived()` stay outside the
mutex — they're pure reads and don't need to serialize against each other,
only against the mutation methods' writes (which `writeJsonFile()`'s own
chain already handles for the final write step; the mutex's job is
protecting the read-then-decide step in between).

### Archiving takes a trigger fully offline — read-time check, no instance data written

**A third confirmed bug caught during review, both parts real.**

**Part 1 — the async filter was outright broken.** `Array.prototype
.filter()`'s callback cannot meaningfully `await`: written as a plain
arrow function, `await` inside a non-`async` callback is a syntax error;
written as `async`, the callback returns a `Promise`, and `!aPromise` is
always `false` (a `Promise` object is truthy) — every element gets
filtered *out*, unconditionally. Verified empirically (`node -e` reproducing
exactly this pattern returns `[]` for every input). The fix resolves every
distinct `workspaceId` among the candidate instances once, up front, into a
plain `Map<string, boolean>`, then filters synchronously against that map:

```ts
// trigger-registry.ts, before the liveInstances computation
const archivedByWorkspace = new Map(
  await Promise.all(
    [...new Set(allInstances.map((i) => i.workspaceId))].map(
      async (id) => [id, await this.deps.isWorkspaceArchived(id)] as const
    )
  )
)

const liveInstances = allInstances.filter(
  (i) =>
    !i.paused &&
    identity &&
    sameIdentity(i.identity, identity) &&
    !archivedByWorkspace.get(i.workspaceId)
)
```

(`deps.isWorkspaceArchived: (workspaceId: string) => Promise<boolean>` is a
new, narrow dependency injected into `TriggerRegistry` — backed by
`WorkspaceStore.isArchived(id)` in production — rather than handing the
registry a full `WorkspaceStore` it doesn't otherwise need, keeping the
existing dependency-injection surface minimal and testable.) A regression
test asserts a fire with multiple instances sharing one `workspaceId`
resolves `isWorkspaceArchived` for that id exactly once, not once per
instance.

**Part 2 — this alone does not "take the workspace offline."** Verified
against `trigger-registry.ts`'s real `onFire()` (lines 269-370): the
trigger's own plugin handler (`this.deps.dispatchHandler(...)`, dispatched
around lines 293-304, well before the `liveInstances` computation at
327-329) runs unconditionally on every fire — admission check, minting a
background invocation, and executing the plugin's handler function (which
can itself perform capability/network/other side effects) all happen
*before* any workspace-archived check. The `liveInstances` filter above
only gates the second phase, `dispatchAgent()` fan-out — so archiving a
workspace, as originally drafted, would still let the plugin handler run
and side-effect on every fire; only the *agent* dispatch for that
workspace's instances would be skipped. That is a real, useful
protection (it's the piece that actually spends AI budget and creates
conversations) but it does not match this spec's "taken offline" framing,
and needs to be either delivered for real or the claim narrowed. This spec
takes the former:

`onFire()` computes `allInstances`/`archivedByWorkspace`/`liveInstances`
*before* dispatching the base handler, not after. If `decl.agent` is
configured (this trigger has agent instances at all) and every one of
`allInstances` resolves archived (`liveInstances` is empty purely because
of archiving, not because `allInstances` was already empty for unrelated
reasons like no instances existing yet), `onFire()` returns immediately —
no admission debit, no minted invocation, no handler dispatch, no agent
fan-out. If at least one instance's workspace is still active, the handler
runs exactly as it does today (unconditionally, shared across every
instance of that trigger declaration — the handler is plugin-scoped, not
per-workspace, so it cannot be skipped for one workspace while running for
another), and only the archived instances are excluded from the
subsequent agent fan-out via `liveInstances`, as before. A trigger with no
`decl.agent` configured (no agent instances ever exist for it) is
completely unaffected by this spec — there is no workspace concept to gate
on.

This is independent of `i.paused` (an existing, per-instance, user-set
flag) — both must pass for an instance's agent dispatch, and the new
early-return only fires when *every* bound instance is archived, never
when some are merely paused. Un-archiving takes effect on the very next
fire check with zero state to reconcile, because nothing was ever written
to `TriggerInstanceRecord` in the first place. A skipped fire due to every
bound workspace being archived is logged (matching the existing
`admission`/`fault` logging style in `onFire`) but does not count as a
handler fault and does not debit any budget.

### IPC + renderer wrapper — full touchpoint list

**Corrected during review**: this is not simply "add three channels to
`ai.ts`" — the existing `ai:list-workspaces`/`ai:create-workspace` path
already involves more layers than that, verified against the real chain
(`ai.ts:131-137` → `AiIpcService.listWorkspaces`/`createWorkspace`,
`ai.ts:20-35` → `AgentService.listWorkspaces`/`createWorkspace`,
`agent-service.ts:344-357`), and the new work must touch every one of
them, not just `ai.ts`:

1. **`WorkspaceStore`** (`src/main/ai/workspace/workspace-store.ts`) — the
   pure business layer: `rename`/`archive`/`unarchive`/`isActive`/
   `isArchived`, already Electron-import-free and independently tested
   (see Testing).
2. **`AgentService`** (`src/main/ai/agent-service.ts`) — gains
   `renameWorkspace(id, name)`, `archiveWorkspace(id)`,
   `unarchiveWorkspace(id)` thin wrappers alongside its existing
   `listWorkspaces()`/`createWorkspace(name)` (lines 344-357); `listWorkspaces`
   gains the same `{ includeArchived?: boolean }` option and passes it
   through to `WorkspaceStore.list()`.
3. **`AiIpcService` interface** (`ai.ts:20-35`) — gains the three new method
   signatures; `listWorkspaces` signature gains the options parameter.
4. **`registerAiIpc()`**'s `ipcMain.handle` bindings (`ai.ts:131-137` today)
   — three new handlers following the file's existing `guard(event,
   channel)` + typed-argument-validation pattern (e.g. `requireString(id,
   "id")`, already used by `ai:delete-conversation` at `ai.ts:127-130`) —
   not a bare pass-through; invalid/missing arguments are rejected before
   reaching the service layer, matching every other handler in this file.
5. **`src/preload/index.ts`** — `contextBridge` exposure of the three new
   methods on `electronAPI`.
6. **`src/preload/index.d.ts`** — `SynapseAiWorkspace` (currently `{ id:
   string; name: string; createdAt: number }`, lines 366-370) gains
   `archived?: boolean`; the `electronAPI` type surface gains the three new
   method signatures and `listAiWorkspaces`'s signature gains the options
   parameter.
7. **`src/renderer/src/lib/electron.ts`** — the sole `window.electronAPI`
   touchpoint in the renderer — wraps the three new IPC calls and the
   updated `listAiWorkspaces`.
8. **`workspace-settings.tsx`** (renderer) — the actual UI consumer (see
   below).

Channel names: `ai:list-workspaces` (gains optional `includeArchived`
argument, backward compatible — omitted means today's behavior),
`ai:rename-workspace(id, name)`, `ai:archive-workspace(id)`,
`ai:unarchive-workspace(id)` (all three new).

### UI

`workspace-switcher.tsx`'s dropdown is unchanged — it calls
`listAiWorkspaces()` with no `includeArchived` argument, so archived
workspaces simply stop appearing there once any exist, with zero changes to
that component's own code.

A new `src/renderer/src/components/workspace-settings.tsx`, composed into
`settings-page.tsx` alongside its existing sibling sections
(`AppearanceSettings`, `TrustedSourceSettings`, `FloatingBallSettings`,
`LauncherSettings`, `AgentShellSettings` — `settings-page.tsx:16-20`),
lists every workspace including archived ones (`includeArchived: true`),
with inline rename, and an archive/unarchive toggle per row. `DEFAULT_WORKSPACE`
appears in this list read-only (name/archive controls disabled) since
`rename`/`archive` both reject it — the UI reflects that constraint rather
than silently failing on click.

## Testing

- **`workspace-store.test.ts`**:
  - `rename()` — updates `name`, leaves `id` untouched, rejects empty name,
    rejects `id === "default"`, rejects unknown id.
  - `archive()` — sets `archived: true`; `unarchive()` — **the serialized
    JSON contains no `"archived"` key at all afterward** (not `false`) —
    read the raw file, not just the parsed `Workspace` object, to catch a
    naive `archived: false` implementation. Both idempotent on repeated
    calls; both reject `id === "default"` and unknown id.
  - `list()` — default excludes archived; `includeArchived: true` includes
    them; `DEFAULT_WORKSPACE` is present in both cases (unaffected, since
    it can never be archived).
  - **`get()`/`exists()` resolve an archived workspace** — this is the
    regression test for the P0 bug above: archive a workspace, then assert
    `get(id)` still returns it and `exists(id)` still returns `true`.
  - `isActive()`/`isArchived()` — `true`/`false` pairs for an active
    workspace, flipped for an archived one, both `false` for an unknown id
    (neither throws).
  - **Concurrency regression**: fire a `rename()` and an `archive()` on the
    same workspace concurrently (`Promise.all`), then assert the final
    persisted record reflects *both* mutations (new name AND archived) —
    proving the mutex actually serializes the read-modify-write cycle, not
    just the final write.
- **`isWorkspace()` type-guard test**: a stored record with
  `archived: "yes"` (wrong type) is rejected the same way a malformed `id`
  already is today; a record with `archived` entirely absent (pre-S05 data)
  is accepted and treated as not archived.
- **`trigger-registry.test.ts`**:
  - A `liveInstances` case where `isWorkspaceArchived` resolves `true` for
    one instance's `workspaceId` and `false` for another's, in the same
    fire, with at least one *other* instance sharing the first
    `workspaceId` — asserts `isWorkspaceArchived` is called exactly once
    per distinct `workspaceId`, not once per instance (the P0 async-filter
    fix's own regression test). The archived instances' `dispatchAgent` is
    never called; the active one's is; the skip does not call
    `admission.recordFault` and does not debit budget.
  - **A separate case where *every* bound instance's workspace is
    archived**: asserts the base handler (`dispatchHandler`) is never
    called either, no invocation is minted, and `admission.admit`/
    `recordSuccess` are not invoked — the "actually offline" behavior from
    Part 2 above, distinct from the partial-archive case where the handler
    still runs.
  - A companion case confirms `i.paused` and workspace-archived are
    independent gates for the *fan-out* filter specifically: an unpaused
    instance in an archived workspace (among otherwise-active instances) is
    excluded from `liveInstances`, and a paused instance in a non-archived
    workspace is still excluded by the pre-existing `!i.paused` condition —
    neither masks the other's coverage, and this case must have at least
    one other active instance so the handler still runs and the two
    exclusions are actually observable in `liveInstances` rather than
    short-circuited by the all-archived early return above.
- **`agent-service.test.ts`**: new `renameWorkspace`/`archiveWorkspace`/
  `unarchiveWorkspace` wrapper methods delegate to the matching
  `WorkspaceStore` method and propagate its rejections; `createConversation`
  against an archived workspace is rejected (the `isActive()` migration's
  own regression test — this is a real, deliberate behavior change from
  today, where `exists()` would have allowed it).
- **`ai.test.ts`** (or wherever `registerAiIpc` is tested): the three new
  handlers reject missing/wrong-typed arguments the same way
  `ai:delete-conversation` does today, before reaching the service.
- **No renderer test changes required** for `workspace-switcher.tsx` — its
  behavior is unchanged by construction (see Architecture). New
  `workspace-settings.test.tsx` covers list-with-archived rendering, rename
  submit, and the archive/unarchive toggle, following this repo's existing
  `*-settings.test.tsx` pattern (e.g. `launcher-settings.test.tsx`).

## Non-goals

- **No hard delete.** Deleting a workspace and resolving what happens to
  the six referencing stores (cascade-delete their records? orphan them
  with a sentinel? block deletion while references exist?) is a
  substantially larger problem — six stores across three file topologies
  with no cross-store transaction mechanism (see "Why this is needed") —
  and is deliberately deferred to a future, independently-scoped spec, not
  folded into this one.
- **No conversation-level archive.** **Corrected during review — the
  original claim here was factually wrong.** `conversation-store.ts:44-49`
  already has a full, irrecoverable `delete(id)` (unlinks the conversation's
  file), wired end-to-end today: `agent-service.ts:406-409`
  `deleteConversation()` → `ai:delete-conversation` (`ai.ts:127-130`) →
  preload → renderer. What's actually missing is a *recoverable, filterable*
  archive state for conversations, analogous to what this spec adds for
  workspaces — not "any lifecycle at all." This distinction matters because
  it changes the shape of the eventual gap: it's "add archive alongside an
  existing hard delete," not "build delete from scratch." Still explicitly
  out of scope for S05 (recorded in project memory `s01-s10-roadmap-status.md`
  with the corrected framing, not assigned a spec number yet).
- **No MCP stale-workspace diagnosis.** Detecting and surfacing to the user
  that an external MCP client is pointed at an archived (or nonexistent)
  workspace is explicitly S08's job ("MCP Workspace Onboarding" — "失效
  workspace 诊断" in the roadmap), not this spec's. S05 only makes
  `archived` a queryable fact; S08 decides how MCP-facing tooling reacts to
  it.
- **No `WorkspaceRoot` lifecycle changes.** `removeWorkspaceRoot` already
  exists and is untouched — this spec is scoped to the `Workspace` entity
  itself, not the folder mounts within one.
- **No migration of existing data.** `archived` is optional and absent on
  every workspace that predates this spec; no backfill, no rewrite of
  `workspaces.json`.

## Completion criteria

- `Workspace.id` is permanent from creation; `rename()` changes only
  `name`.
- `archive()` sets `archived: true`; `unarchive()` removes the `archived`
  key entirely (verified against the raw serialized JSON, not just the
  parsed object). Both idempotent, both reject `id === "default"` and
  unknown ids, and touch only `workspaces.json` — no other store's data is
  written as a side effect.
- `get()`/`exists()` continue to resolve archived workspaces (unchanged
  semantics — "is this a real workspace id"); `isActive()`/`isArchived()`
  are the new "is this usable right now" / "is this archived" queries, and
  every real caller identified during review that needs the *active*
  question (`agent-service.ts`'s `createConversation` gate) has migrated
  from `exists()` to `isActive()`.
- `create()`/`rename()`/`archive()`/`unarchive()` share a mutex around
  their full read-modify-write cycle, with a regression test proving a
  concurrent `rename()` + `archive()` on the same workspace doesn't lose
  either mutation.
- `trigger-registry.ts`'s archived check resolves each distinct
  `workspaceId` at most once per fire (not once per instance), gates the
  `liveInstances` fan-out filter independently of the pre-existing
  `i.paused` check, **and** short-circuits the entire `onFire()` — no base
  handler dispatch, no minted invocation — when every bound instance's
  workspace is archived. Regression tests cover both the partial-archive
  case (handler still runs, only some instances fan out) and the
  all-archived case (handler never runs).
- The full IPC chain from the "IPC + renderer wrapper" section's numbered
  list (`WorkspaceStore` → `AgentService` → `AiIpcService` interface →
  `registerAiIpc` validated handlers → preload `index.ts` → preload
  `index.d.ts` → `lib/electron.ts` → `workspace-settings.tsx`) exists
  end-to-end for `rename`/`archive`/`unarchive`, and `list`'s
  `includeArchived` option threads through every layer of that same chain.
- `workspace-switcher.tsx` requires zero code changes and continues hiding
  archived workspaces by construction (unit test confirms `listAiWorkspaces`
  is still called with no `includeArchived` argument there).
- `workspace-settings.tsx` exists, composed into `settings-page.tsx`, lists
  all workspaces including archived, supports rename and archive/unarchive.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.

## Parked questions

- Conversation-level archive (delete already exists — see Non-goals) — not
  yet assigned a spec number; tracked in project memory for future
  evaluation.
- Whether `unique(name)` should be enforced across active (non-archived)
  workspaces at `rename()`/`create()` time was not raised during
  brainstorming and is left as-is: today's `create()` does not enforce
  unique *names*, only unique *ids* (via `uniqueSlug()`'s collision
  suffixing) — `rename()` inherits that same lack of a name-uniqueness
  constraint, consistent with current behavior rather than introducing a
  new rule unprompted.
