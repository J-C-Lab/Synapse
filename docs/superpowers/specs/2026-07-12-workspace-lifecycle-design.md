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

```ts
export class WorkspaceStore {
  // existing: list(), get(), exists(), create() — unchanged signatures
  // except list() gains an option (see below).

  async list(options?: { includeArchived?: boolean }): Promise<Workspace[]>
  async rename(id: string, name: string): Promise<Workspace>
  async archive(id: string): Promise<Workspace>
  async unarchive(id: string): Promise<Workspace>
}
```

- **`list({ includeArchived: true })`** — default `false`, matching
  today's implicit behavior (every existing caller of `list()` keeps
  seeing only active workspaces with no code change). `includeArchived:
  true` is opt-in for the new Settings surface (below).
- **`rename(id, name)`** — validates non-empty `name` (same trim-and-
  reject-empty rule as `create()`, line 31-32); rejects `id === "default"`
  (`DEFAULT_WORKSPACE`'s name is fixed, matching its already-fixed identity)
  and unknown `id`. Does **not** re-derive or touch `id`.
- **`archive(id)` / `unarchive(id)`** — flips `archived` and persists.
  Both reject `id === "default"`: `DEFAULT_WORKSPACE` is not part of the
  persisted array at all (`readStored()` filters it out, line 51) and is
  always prepended by `list()` (line 19) — it has no lifecycle to enter or
  leave. Both reject an unknown `id`. `archive()` on an already-archived
  workspace and `unarchive()` on an already-active one are no-ops that
  succeed (idempotent, matching the rest of this store's forgiving style).

None of the six foreign-key-holding stores are touched by `archive()`/
`unarchive()` — no cascade write, no cross-store transaction, because no
data referenced by `workspaceId` is deleted, moved, or invalidated. This is
the direct consequence of scoping this spec to archive only (see
Non-goals): the six-store, three-topology coordination problem the original
gap described only exists for *deletion*, not for a reversible visibility
flag.

### Archiving pauses bound triggers — read-time check, no instance data written

`archive()` does not touch `TriggerInstanceRecord`. Instead,
`trigger-registry.ts:327-329`'s `liveInstances` filter — the single real
dispatch gate for every workspace-bound background-agent trigger instance
— gains one more condition:

```ts
// trigger-registry.ts, liveInstances computation (currently line 327-329)
const liveInstances = allInstances.filter(
  (i) =>
    !i.paused &&
    identity &&
    sameIdentity(i.identity, identity) &&
    !(await this.deps.isWorkspaceArchived(i.workspaceId))
)
```

(`deps.isWorkspaceArchived: (workspaceId: string) => Promise<boolean>` is a
new, narrow dependency injected into `TriggerRegistry` — backed by
`WorkspaceStore.get(id)?.archived === true` in production — rather than
handing the registry a full `WorkspaceStore` it doesn't otherwise need,
keeping the existing dependency-injection surface minimal and testable.)

This is independent of `i.paused` (an existing, per-instance, user-set
flag) — both must pass. Un-archiving takes effect on the very next fire
check with zero state to reconcile, because nothing was ever written to
`TriggerInstanceRecord` in the first place. A skipped fire due to an
archived workspace is logged (matching the existing `admission`/`fault`
logging style in `onFire`) but does not count as a handler fault and does
not debit any budget.

### IPC + renderer wrapper

Four new/changed channels, following the exact existing pattern
`ai:list-workspaces`/`ai:create-workspace` already use — no new file. The
"pure business function" layer of this repo's IPC pattern is
`WorkspaceStore`'s own methods themselves (`rename`/`archive`/`unarchive`,
already Electron-import-free and independently unit-tested, same as
today's `list`/`create`); `ai.ts`'s `ipcMain.handle` bindings
(`ai.ts:131-137` today) grow by three more handlers calling into the same
service layer `ai:list-workspaces`/`ai:create-workspace` already go
through, translating thrown errors (empty name, default-workspace
rejection, unknown id) the same way that layer already does:

- `ai:list-workspaces` gains an optional `includeArchived` argument
  (backward compatible — omitted means today's behavior).
- `ai:rename-workspace(id, name)` (new)
- `ai:archive-workspace(id)` (new)
- `ai:unarchive-workspace(id)` (new)

Mirrored in `src/preload/index.ts` and `src/renderer/src/lib/electron.ts`
(the sole `window.electronAPI` touchpoint), per this repo's standard
4-touchpoint IPC pattern.

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

- **`workspace-store.test.ts`**: `rename()` — updates `name`, leaves `id`
  untouched, rejects empty name, rejects `id === "default"`, rejects
  unknown id. `archive()`/`unarchive()` — flips `archived`, is idempotent
  on repeated calls, both reject `id === "default"` and unknown id.
  `list()` — default excludes archived; `includeArchived: true` includes
  them; `DEFAULT_WORKSPACE` is present in both cases (unaffected, since it
  can never be archived).
- **`isWorkspace()` type-guard test**: a stored record with
  `archived: "yes"` (wrong type) is rejected the same way a malformed `id`
  already is today; a record with `archived` entirely absent (pre-S05 data)
  is accepted and treated as not archived.
- **`trigger-registry.test.ts`**: a `liveInstances` case where
  `isWorkspaceArchived` resolves `true` for one instance's `workspaceId`
  and `false` for another's, in the same fire — the archived one's
  `dispatchAgent` is never called, the other's is; the skip does not call
  `admission.recordFault` and does not debit budget. A companion case
  confirms `i.paused` and workspace-archived are independent gates: an
  unpaused instance in an archived workspace is skipped, and a paused
  instance in a non-archived workspace is still skipped by the pre-existing
  `!i.paused` condition — neither masks the other's test coverage.
- **`workspace-store.test.ts` covers the pure-function layer directly**
  (as already listed above) — `rename`/`archive`/`unarchive` against a real
  temp-dir-backed `WorkspaceStore`, success and every rejection path (empty
  name, default-workspace target, unknown id). Whatever thin service-layer
  method `ai.ts`'s new bindings call into gets the same treatment its
  existing `ai:list-workspaces`/`ai:create-workspace` siblings already have
  in that layer's own test file — no new test file needed for this, per the
  "no new file" decision above.
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
- **No conversation-level archive/delete.** Explored and confirmed during
  brainstorming: `conversation-store.ts` has no per-conversation
  archive/delete lifecycle either — only create/read. This is a real,
  separate gap, orthogonal to workspace-entity lifecycle, and is
  deliberately out of scope here (recorded in project memory
  `s01-s10-roadmap-status.md` so it isn't lost, not assigned a spec number
  yet).
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
- `archive()`/`unarchive()` exist, are idempotent, both reject
  `id === "default"` and unknown ids, and touch only `workspaces.json` —
  no other store's data is written as a side effect.
- `trigger-registry.ts`'s `liveInstances` gate skips any instance whose
  workspace is archived, independently of the pre-existing `i.paused`
  check, with a regression test proving both gates are exercised
  independently.
- `ai:rename-workspace`/`ai:archive-workspace`/`ai:unarchive-workspace` IPC
  channels exist end-to-end (pure handler → `ai.ts` registration → preload
  → `lib/electron.ts`), matching this repo's 4-touchpoint IPC pattern.
- `workspace-switcher.tsx` requires zero code changes and continues hiding
  archived workspaces by construction (unit test confirms `listAiWorkspaces`
  is still called with no `includeArchived` argument there).
- `workspace-settings.tsx` exists, composed into `settings-page.tsx`, lists
  all workspaces including archived, supports rename and archive/unarchive.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.

## Parked questions

- Conversation-level archive/delete (see Non-goals) — not yet assigned a
  spec number; tracked in project memory for future evaluation.
- Whether `unique(name)` should be enforced across active (non-archived)
  workspaces at `rename()`/`create()` time was not raised during
  brainstorming and is left as-is: today's `create()` does not enforce
  unique *names*, only unique *ids* (via `uniqueSlug()`'s collision
  suffixing) — `rename()` inherits that same lack of a name-uniqueness
  constraint, consistent with current behavior rather than introducing a
  new rule unprompted.
