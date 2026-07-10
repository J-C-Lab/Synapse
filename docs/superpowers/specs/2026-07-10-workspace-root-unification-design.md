# Workspace/WorkspaceRoot Data Model Unification

> Date: 2026-07-10 · Status: draft, pending review
> First of a three-part decomposition (spec ①) of the "two workspace axes
> need unifying" follow-up flagged since the 2026-07-07 P4 Slice 1 work
> (*"两个 workspace 轴仍分离(执行沙箱根 vs 会话 context workspace),统一留
> 后续"*), and the direct prerequisite the `workspace-instructions`
> resource spec has been parked on. Decided by user Q&A on 2026-07-10 (see
> the `synapse-platform-positioning` memory), same interactive-decision
> process used for the four items resolved earlier that day.
>
> Sibling specs, not covered here: **②** host-resource approval
> infrastructure (splits the headless-approval transport from its
> plugin-capability policy layer, adds a parallel host-resource gate) —
> depends on this spec's `Workspace`→root resolution. **③**
> `workspace-instructions` MCP resource itself — depends on both ① and ②.
> **④** trigger→workspace binding (lets a background-agent invocation carry
> a workspace context) — explicitly independent, no dependency either way;
> deferred because it requires inventing a per-trigger settings
> layer/store/UI from scratch (verified: none exists today at any layer —
> manifest, `TriggerRuntime`, `InvocationRecord`, or renderer).

## Why this is safe and necessary to do now

Verified against the real code, not assumed:

- **Execution root ids are not stable today.** `deriveExecutionWorkspaces()`
  (`src/main/index.ts:950-958`) derives `id` from `path.basename(root)` with
  a same-call collision counter, recomputed fresh on every call from
  `agentShellRoots`' current array order. Removing a root and adding a
  differently-located root with the same folder name silently reassigns its
  id to whatever's now first in the array — a real bug, not a hypothetical
  one.
- **`caller.workspaceId` already reaches the execution tool call site for
  the interactive path, but is completely unused for root scoping.**
  `AgentRuntime.runOneTool` (`agent-runtime.ts:299-307`) populates
  `caller.workspaceId` with the conversation's bound `Workspace.id`, and it
  flows unchanged into `ExecutionToolHostSource.invokeTool`
  (`execution-tool-host.ts`) — but `WorkspacePolicy.resolvePath`
  (`workspace-policy.ts:8-10`) only ever matches against the flat
  execution-root id from tool input, never cross-checking
  `caller.workspaceId`. **Any conversation can already request any
  globally-configured root today, regardless of which conversation-level
  Workspace it's bound to** — this spec closes that gap, it doesn't open a
  new one.
- **`run_command` is not reachable from external MCP callers by default**
  (`destructiveHint: true`, no `readOnlyHint` → excluded under the default
  `readOnlyOnly` exposure policy, and requires the just-shipped
  per-plugin `mcp-nonreadonly-exposure` opt-in otherwise) — so the missing
  binding check is a same-user-different-conversation isolation gap today,
  not an external-caller privilege-escalation path. Still worth closing on
  its own merits.

## Guiding principle

**`Workspace` becomes the stable, product-level context container;
`WorkspaceRoot` becomes a governed resource it owns — not a second,
parallel "workspace" concept.** A `Workspace` can own zero, one, or several
roots; exactly one (if any) is `primary`. `workspaceId`, root `id`, and the
filesystem path are three independent things with independent lifecycles —
moving a path, revoking a root, or having zero roots at all must never
affect the workspace's identity, its bound conversations, or its memory.

## Goal (this slice)

1. `WorkspaceRoot` becomes a persisted, host-generated-stable-id'd entity
   owned by a `Workspace` (`primary` or `additional`), replacing today's
   basename-derived, recomputed-every-call, globally-flat list.
2. `run_command`'s tool input is renamed `workspaceId` → `rootId`
   (eliminates a real naming collision with the conversation-bound
   `Workspace.id`), and the host enforces that the requested root actually
   belongs to the calling conversation's `Workspace` — closing the gap
   above.
3. `agentShellRoots` (global, flat) retires in favor of per-workspace root
   lists; `allowAgentShell` stays exactly as-is (global master switch,
   untouched by this spec).

## Non-goals (explicitly deferred)

- **Host-resource approval infrastructure and `workspace-instructions`
  itself** — specs ② and ③, depend on this one.
- **Trigger→workspace binding** — spec ④, fully independent, needs its own
  persistence layer + UI from scratch; not blocked by or blocking this spec.
- **Requiring a root at workspace-creation time.** Rootless workspaces stay
  fully supported (chat-only, memory-only use cases) — Synapse's positioning
  is broader than a coding-agent tool where every session implies a project
  directory. A root can be added to an existing workspace at any time.
- **Multiple roots being genuinely exercised in v1's UI/UX polish.** The
  data model supports `additional` roots from day one (per explicit
  instruction — building the primary-only version first and widening later
  was considered and rejected, since no evidence today suggests roots ever
  need re-keying once multi-root support exists), but nothing in the
  current codebase has an actual multi-root use case yet; this spec doesn't
  invent one, just doesn't block it.

## 1. Data model

```ts
// src/main/ai/workspace/workspace-store.ts
export interface Workspace {
  id: string
  name: string
  createdAt: number
  /** The default cwd / project-instructions discovery root, if any. */
  primaryRootId?: string
}
```

```ts
// src/main/ai/execution/types.ts
export interface WorkspaceRootRecord {
  /** Host-generated (crypto.randomUUID()), stable for the record's
   *  lifetime — never re-derived from the path. */
  id: string
  workspaceId: string
  /** User-facing label — defaults to the folder's basename at creation
   *  time but is NOT re-derived afterward (a renamed/moved folder doesn't
   *  silently rename the root). */
  name: string
  root: string
  role: "primary" | "additional"
  createdAt: number
}
```

New `WorkspaceRootStore` (`src/main/ai/workspace/workspace-root-store.ts`),
structurally similar to `WorkspaceStore` (own JSON file under
`userDataDir/ai/`), replacing `deriveExecutionWorkspaces()`'s on-the-fly
derivation entirely. Two query shapes, matching the two real consumer
patterns identified in §4:

```ts
async listAll(): Promise<WorkspaceRootRecord[]>
async listForWorkspace(workspaceId: string): Promise<WorkspaceRootRecord[]>
async create(workspaceId: string, name: string, root: string, role: "primary" | "additional"): Promise<WorkspaceRootRecord>
async remove(id: string): Promise<void>
```

`remove()` only deletes the root record — it never touches the owning
`Workspace`, its conversations, or its memory (independent lifecycles,
per the Guiding Principle). If the removed root was the workspace's
`primaryRootId`, that field is cleared (workspace becomes rootless or
falls back to having only `additional` roots — no automatic promotion of
another root to primary; the user picks explicitly if they want one).

## 2. Migration

On first load after upgrade: existing `agentShellRoots` (flat string
array, from the retiring global setting) are migrated into the `default`
workspace's roots — the first entry becomes `primary`, the rest become
`additional`, each assigned a fresh `WorkspaceRootRecord.id`. `default` is
the one workspace every pre-existing conversation is already bound to
(per F1's virtual-default design), so this migration is invisible to
existing users — nothing they can already do stops working.

`allowAgentShell` is untouched — it remains the single global switch
gating whether local execution is available at all, independent of how
many workspaces have roots configured.

`UserSettings.agentShellRoots` is removed from the settings schema
(`normalizeSettings` in `settings.ts` drops the field); the path data now
lives exclusively in `WorkspaceRootStore`.

**`mcp-client-roots`'s `McpServerConfig.exposedExecutionRootIds`** (shipped
in PR #38, merged the same day as this spec) references the *old*
basename-derived ids. Since that feature is brand new, the migration
simply clears this field rather than attempting an id remap — negligible
real-world impact, and safer than guessing a mapping.

## 3. Settings UI

The current global "allowed workspace roots" text list
(`settings.agentShell.rootsLabel`/`rootsEmpty` in the Settings page) is
retired. Root management moves to a new section within each workspace's
own management UI (wherever `WorkspaceStore` entries are currently
edited/created — the workspace-switcher's "manage" flow) — add/remove
roots, mark one `primary`.

Adding a root uses Electron's native folder picker
(`dialog.showOpenDialog({ properties: ["openDirectory"] })`) instead of
free-text path entry — there's no reason to make a user hand-type a
filesystem path when picking a folder is the native, error-proof
interaction.

## 4. Tool API — `run_command`

`execution-tool-host.ts`'s `run_command` input schema: `workspaceId` →
`rootId` (same type, `{type: "string"}`, required alongside `command`).
This is a breaking rename to the tool's own input contract — the model's
tool-calling convention changes, not a wire-compatible extension.

New enforcement in the tool handler, before `WorkspacePolicy.resolvePath`
runs:

```ts
const allowedRoots = await workspaceRoots.listForWorkspace(caller.workspaceId ?? "")
const root = allowedRoots.find((r) => r.id === (args.rootId ?? findPrimary(allowedRoots)?.id))
if (!root) deny("root not available to this workspace")
```

- `caller.workspaceId` **missing** (today: every `background-agent`
  invocation) → `listForWorkspace("")` resolves to an empty list by
  construction (no record has `workspaceId === ""`) → `run_command`
  becomes universally unusable for that caller. This isn't a new
  restriction in practice — `run_command` isn't reachable from a
  background-agent run today regardless (verified: `BackgroundAgentRunner`
  is constructed with `tools: this`, the plain `PluginHost`/
  `PluginRegistry`, which only ever contains manifest-declared plugin
  tools; `ExecutionToolHostSource` is composed only into the separate
  `CompositeToolHost` built in `index.ts` that feeds the interactive-agent
  path — a wiring separation today, not an enforced boundary). **This is
  exactly why the invariant matters going forward, not just today**: if a
  future change ever gives background-agent runs the full
  `CompositeToolHost` (e.g. to let triggers use read-only file tools),
  `run_command` would become reachable with **zero enforcement** as the
  code stands otherwise — neither `WorkspacePolicy` (doesn't check
  `caller.workspaceId`) nor `BackgroundAgentRunner`'s own capability filter
  (execution tool descriptors declare no `capabilities`, so the filter
  vacuously passes) would catch it. This spec's fail-closed-on-missing-
  `workspaceId` check is what would actually stand in the way at that
  point — worth having in place now, before it's load-bearing.
  Trigger→workspace binding (spec ④) is the only sanctioned way a
  background-agent caller ever gets a real `workspaceId` in the future.
- `rootId` omitted, `caller.workspaceId` present → defaults to that
  workspace's `primaryRootId`, if set; if the workspace is rootless, same
  "not available" denial.
- `rootId` present but not in `caller.workspaceId`'s owned roots → denied
  and audited, regardless of whether that root id is valid for some *other*
  workspace.

`WorkspacePolicy`/`resolvePath` (`workspace-policy.ts`) changes from
resolving against the full global root list to resolving against the
already-caller-scoped `allowedRoots` passed in above — no change to its
existing `fs.realpath`-based canonicalization logic, which was already
correct and is untouched by this spec.

## 5. Consumer updates

Two real, distinct consumers of "the root list" exist today
(`src/main/index.ts`), and they need different query shapes going forward
— this was a genuine point of confusion worth calling out explicitly:

- **`ExecutionToolHostSource`** (the agent's own tool call, §4 above) needs
  the **caller-scoped** view: `workspaceRoots.listForWorkspace(caller.workspaceId)`.
- **`McpClientManager`** (the `mcp-client-roots` feature from PR #38 —
  Synapse-as-client advertising roots *outward* to external servers it
  connects to) is deliberately **not** conversation-scoped — a user picks
  which execution roots to expose to a given external MCP server
  independent of any particular conversation. This consumer keeps using
  the **full, unscoped** view: `workspaceRoots.listAll()`. Nothing about
  its existing per-server `exposedExecutionRootIds` selection UI changes
  in shape, only the underlying id source (now stable, host-generated,
  instead of basename-derived).

`index.ts`'s current single global `executionWorkspaces()` function is
replaced by these two explicit, differently-scoped calls at their
respective call sites — not a single shared function anymore, since they
were never really the same query to begin with.

## 6. Testing strategy

- **`workspace-root-store.test.ts`**: create/list/remove round-trip;
  `listForWorkspace` returns only that workspace's records;
  `listAll` returns everything regardless of owner; removing the
  `primaryRootId` root clears the workspace's `primaryRootId` (no
  auto-promotion); ids are stable across repeated `listAll()` calls even
  when two roots share a folder basename (the bug this spec fixes).
- **Migration test**: given a legacy `agentShellRoots: [a, b, c]`, the
  `default` workspace ends up with `a` as `primary` and `b`/`c` as
  `additional`, each with a distinct generated id; `allowAgentShell`'s
  value is unchanged by the migration; a fixture with `exposedExecutionRootIds`
  set on an `McpServerConfig` ends up with that field cleared, not remapped.
- **`execution-tool-host.test.ts`**: extend for the `rootId` rename
  (existing `workspaceId`-named test cases update); new cases — a caller
  with no `workspaceId` is denied regardless of `allowAgentShell`/root
  state; a `rootId` belonging to a *different* workspace than
  `caller.workspaceId` is denied even though the id is valid globally; a
  request with no `rootId` resolves to the caller's workspace's
  `primaryRootId`; a rootless workspace's caller is denied with a clear
  "no root available" message, not a generic failure.
- **`mcp-client-manager.test.ts` / roots**: confirm `McpClientManager`'s
  roots-advertisement path is unaffected by the caller-scoping change
  (still sees the full `listAll()` set), since this is the one consumer
  that must *not* be scoped.

## 7. Parked questions (surfaced, not solved)

- **Exact settings-UI placement for per-workspace root management** — this
  spec fixes the data model and retires the old global page; the precise
  new UI location (which existing "manage workspace" surface it attaches
  to) is an implementation-plan-level UI decision, not re-litigated here.
- **Whether a moved/renamed root's `name` should ever re-sync from the
  filesystem** — decided to snapshot `name` at creation time and never
  auto-update it; revisit only if this proves confusing in practice.
