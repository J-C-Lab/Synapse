# S08 — MCP Workspace Onboarding

> Date: 2026-07-13 · Status: draft, pending review
> Third spec of Phase 3 ("先可观察，再扩权") in the four-phase, ten-spec
> roadmap (S01-S10), depending on S05 (Workspace Lifecycle, merged —
> `archived`/`isActive()`) and building on the MCP resources surface added
> alongside S04-era work. Full roadmap status tracked in project memory
> `s01-s10-roadmap-status.md`.

## Why this is needed

Verified against the real repo, not assumed.

- **Nothing in the renderer shows a workspace's id, or its root count/
  status.** `workspace-settings.tsx` (the only workspace-related Settings
  UI, mounted at `settings-page.tsx:18`) renders `w.name` and archived/
  active status with rename/archive/unarchive controls — the workspace
  `id` itself, and `WorkspaceRootRecord`s bound to it, are never displayed
  anywhere. A user connecting an external MCP client has no way to look up
  the exact id `SYNAPSE_MCP_WORKSPACE` needs.
- **No config generation, no example config exists anywhere.** Repo-wide
  search for `Claude Desktop`/`claude_desktop_config`/`SYNAPSE_MCP_
  WORKSPACE` across `src/renderer`, `docs/`, and both READMEs turns up
  nothing but a checklist bullet in `TESTING.md:110-114` ("Configure an
  external client ... to launch `Synapse --mcp-stdio`") — no JSON snippet,
  no documented executable path, no env-var example. A user must currently
  discover all of this by reading source.
- **The stdio entrypoint performs zero workspace validation, ever.**
  `src/main/mcp/stdio-entry.ts:113`:
  ```ts
  workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim() || "external",
  ```
  `"external"` is a bare string, not a real `Workspace.id` — nothing calls
  `WorkspaceStore.get()`/`.isActive()` on it, at startup or per-request.
- **This is a real, currently-exploitable-by-accident gap, not merely a
  UX one — confirmed by reading the request-handler wiring directly.**
  `src/main/mcp/synapse-mcp-server.ts:348-357` wires four *independent*
  handlers — `ListToolsRequestSchema` → `listTools()`,
  `CallToolRequestSchema` → `callTool()`, `ListResourcesRequestSchema` →
  `listResources()`, `ReadResourceRequestSchema` → `readResource()` — each
  with its own code path. `callTool()` (lines 141-192) routes through
  `this.host.invokeTool(...)`, and `stdio-entry.ts:104-107`'s
  `CompositeToolHost` includes a `MemoryToolSource` directly and the
  `PluginHost` as a fallback — meaning `tools/call` can reach
  `memory_search`/`memory_list` and any plugin tool today, with **zero
  workspace-existence or workspace-archived check anywhere in that path**.
  A design that only checked `resources/list`/`resources/read` (an earlier
  draft of this spec) would leave `tools/list`/`tools/call` completely
  unguarded — archiving a workspace would not actually stop an external
  client from calling `memory_search` against it.
- **Archiving a workspace today has no user-facing consequence for MCP
  access at all**, silently or otherwise. `WorkspaceStore.get()`
  (`workspace-store.ts:31-33`) resolves via `list({includeArchived: true})`
  — an archived workspace is found exactly like an active one everywhere
  it's looked up, including `workspace-instructions-resource.ts:84-98`'s
  `list()`. Concretely: `memory-scope.ts:41-51`'s `entryMatchesQuery` is
  pure string equality against `scope.workspaceId`, with no existence or
  archived check — an unknown or archived workspace id just silently
  returns zero memory entries/resources today (not an error), and this
  silence is identical whether the workspace never existed, was archived
  five minutes ago, or is perfectly active with genuinely no data yet.
  There is nothing to build a "diagnosis" UI on top of without first making
  archived-ness actually change behavior.
- **The env var this spec's config generator most needs to set correctly
  already has a doc comment explaining exactly why**, confirming the
  design rather than inventing it: `stdio-paths.ts:3-9` — *"An explicit
  `SYNAPSE_USER_DATA_DIR` always wins, so a launcher (e.g. the Claude
  Desktop MCP config) can pin the directory unambiguously."* This wasn't
  built for S08, but it was built for exactly S08's use case.
- **The connection tester's exact mechanism already exists in this repo**,
  for the opposite direction (Synapse connecting *out* to an external MCP
  server): `src/main/ai/mcp-stdio-client.ts` constructs a real SDK
  `Client` + `StdioClientTransport` from a `{command, args, env, cwd}`
  descriptor, calls `client.connect(transport)`, then `client.listTools()`,
  then `client.close()`. `@modelcontextprotocol/sdk` is already a
  dependency (`package.json:49`). This spec's connection test reuses this
  exact pattern instead of hand-rolling JSON-RPC framing.
- **Auto-falling-back an unbound connection to the `default` workspace
  would silently expand its capabilities, not narrow them — confirmed by
  reading the actual default.** `memory-scope.ts:30-38`'s
  `queryScopeForCaller(caller, includeGlobal = true)` already returns
  `includeGlobal: true` when `caller.workspaceId` is empty — meaning an
  unbound/legacy MCP connection **already** sees global-visibility memory
  today via `tools/call` → `memory_search`. If S08 auto-bound an unbound
  connection to `"default"` instead of surfacing a diagnostic, it would
  *additionally* gain every `default`-workspace-scoped memory and
  instructions resource — a real, silent capability increase for exactly
  the callers this spec is trying to make *more* legible, not less.

## Architecture

### Workspace-bound MCP admission enforcement

A new, explicit binding type, computed once at stdio-entry startup:

```ts
// src/main/mcp/mcp-workspace-binding.ts
export type McpWorkspaceBinding =
  | { kind: "bound"; workspaceId: string }
  | { kind: "unbound" }

export function resolveMcpWorkspaceBinding(env: NodeJS.ProcessEnv): McpWorkspaceBinding {
  const workspaceId = env.SYNAPSE_MCP_WORKSPACE?.trim()
  return workspaceId ? { kind: "bound", workspaceId } : { kind: "unbound" }
}
```

`stdio-entry.ts:113`'s `workspaceId: process.env.SYNAPSE_MCP_WORKSPACE?.trim()
|| "external"` is replaced by a call to `resolveMcpWorkspaceBinding(process.env)`.
**The `"external"` sentinel is removed entirely** — it was never a real
`Workspace.id`, and keeping it as a permanent bypass branch would mean
every future feature that reasons about workspace identity (audit,
authorization, resource scoping, RunTrace) has to know about a
carved-out exception forever. This is a deliberate breaking change (see
Non-goals) for the narrow population of pre-S08 configs that omit
`SYNAPSE_MCP_WORKSPACE` — there is no officially-documented config example
before this spec, so that population should be small.

A new `assertWorkspaceAdmitted(binding, workspaceStore)` is called
**independently at all four `SynapseMcpToolService` entry points** —
`listTools()`, `callTool()`, `listResources()`, `readResource()`
(`synapse-mcp-server.ts:106,141,194,227`) — not layered only onto the
resource handlers, and not skipped for `tools/list` on the theory that
`tools/call` will catch it: a client may cache its tool list before a
workspace is archived mid-session, so `tools/call` must re-check
independently even if `tools/list` already did.

| Binding state | Behavior |
|---|---|
| `unbound` | `initialize` completes; `tools/list`/`tools/call`/`resources/list`/`resources/read` all reject with a migration error (below) |
| `bound`, workspace unknown | Reject: `Workspace "<id>" was not found. Re-copy the configuration from Synapse → Settings → Workspaces.` |
| `bound`, workspace archived | Reject: `Workspace "<id>" is archived. Unarchive it in Synapse, or update SYNAPSE_MCP_WORKSPACE to a different workspace.` |
| `bound`, workspace active | Proceed normally — unchanged from today |

The `unbound` migration error (also written to stderr, since Claude
Desktop surfaces child-process stderr in its own MCP connection logs for
exactly this kind of diagnosis):

```
This Synapse MCP configuration is missing SYNAPSE_MCP_WORKSPACE.
Open Synapse → Settings → Workspaces → Connect an MCP client,
copy the generated configuration, then restart your MCP client.
```

`assertWorkspaceAdmitted` needs read access to `WorkspaceStore` inside the
headless stdio process — `stdio-entry.ts` already constructs one
(`workspaceRootStore`'s sibling `WorkspaceStore`, confirmed constructed at
the same point workspace roots are, for `workspaceInstructions`) — reused,
not duplicated.

### Shared `McpLaunchDescriptor`

One pure function in the main process is the single source of truth for
"how do you launch Synapse's MCP server for workspace X" — consumed by
both the config-snippet generator and the connection tester, so they can
never drift apart:

```ts
// src/main/mcp/mcp-launch-descriptor.ts
export interface McpLaunchDescriptor {
  command: string
  args: string[]
  env: Record<string, string>
}

export function buildMcpLaunchDescriptor(
  workspaceId: string,
  userDataDir: string
): McpLaunchDescriptor {
  return {
    command: resolveMcpExecutablePath(),
    args: ["--mcp-stdio"],
    env: {
      SYNAPSE_MCP_WORKSPACE: workspaceId,
      SYNAPSE_USER_DATA_DIR: userDataDir,
    },
  }
}

function resolveMcpExecutablePath(): string {
  // Linux AppImage: process.execPath at runtime is a temporary
  // /tmp/.mount_XXXXXX/... path unique to this running instance — writing
  // it into a persistent client config breaks on the next app restart.
  // process.env.APPIMAGE is the stable path electron-builder's AppImage
  // target sets to the outer .AppImage file itself.
  if (process.platform === "linux" && process.env.APPIMAGE) {
    return process.env.APPIMAGE
  }
  return process.execPath
}
```

`SYNAPSE_USER_DATA_DIR` is always set explicitly (never left to
`stdio-paths.ts`'s platform-guessing fallback) — this pins the generated
config to the *exact* `app.getPath("userData")` the currently-running GUI
instance resolved, immune to app-name or custom-data-dir drift between the
GUI and a headless child process invoked days later by an external client.

### Renderer — workspace id/root visibility

`workspace-settings.tsx`'s per-workspace row gains: the `id` (monospace,
copyable), and root count (`0 roots` renders plainly — rootless is a
first-class, tested, intentional state per
`docs/superpowers/specs/2026-07-10-workspace-root-unification-design.md:85-88`
and `workspace-instructions-resource.test.ts:77-85`, not an error state to
warn about).

### Renderer — "Connect an MCP client" panel

A new per-workspace panel (new component, composed into `workspace-
settings.tsx`'s row or a details expansion — exact placement is an
implementation-plan decision, not a spec-level one) with two actions:

1. **Generate config** — calls a new IPC method that runs
   `buildMcpLaunchDescriptor(workspaceId, userDataDir)` in the main
   process and serializes it into a `claude_desktop_config.json`
   `mcpServers` snippet:
   ```json
   {
     "mcpServers": {
       "synapse-<workspace-name-slug>": {
         "command": "<resolved executable path>",
         "args": ["--mcp-stdio"],
         "env": {
           "SYNAPSE_MCP_WORKSPACE": "<workspace id>",
           "SYNAPSE_USER_DATA_DIR": "<resolved userData path>"
         }
       }
     }
   }
   ```
   Rendered in a read-only code block with a copy-to-clipboard button.
   **Never written to any file on disk** — Claude Desktop's own config
   file is a different application's data; reading or writing it is out of
   scope (see Non-goals). In an unpackaged dev build, `resolveMcpExecutablePath()`
   still resolves *something* (the dev Electron binary), but the panel
   shows an informational note that the generated command is only valid
   for a packaged install, since a dev-mode path is neither stable nor
   what an end user would actually configure.
2. **Test connection** — calls a new IPC method that builds the same
   `McpLaunchDescriptor`, spawns it via the real SDK
   (`Client` + `StdioClientTransport`, mirroring `mcp-stdio-client.ts`'s
   construction exactly), and runs:
   ```ts
   await client.connect(transport)   // does initialize + initialized notification
   await client.listTools()
   await client.listResources()
   await client.close()              // always, in a finally
   ```
   wrapped in an overall timeout (e.g. 10s) that also closes the client/kills
   the child on expiry. **Success means the three protocol steps completed
   without throwing — not that tool/resource counts are non-zero.** A
   legitimate, active, rootless workspace with no enabled plugins can have
   zero tools and zero resources; that must report success, not failure.
   Failure surfaces the real thrown error (including this spec's new
   `unbound`/unknown/archived admission errors verbatim, so "test
   connection" doubles as the fastest way to see *why* a config doesn't
   work).

### Archive confirmation — deterministic consequence, not a guess

`WorkspaceSettings`'s archive action is currently a bare click with **no
confirmation dialog at all** — confirmed by reading the component; this
spec adds one. Because the admission enforcement above makes archiving
*actually* cut off MCP access (not merely "might have, we can't tell"),
the confirmation copy can state a guaranteed fact instead of a probabilistic
guess:

> Archiving this workspace will stop external MCP clients using this
> workspace ID from reading its resources or calling its tools. They'll
> need a different workspace ID, or you can unarchive this one later.

**Deliberately not built**: scanning `host-resource-audit.ts` (confirmed
during review: it only logs `workspace-instructions` resource access, not
`memory` resource/tool access, and is an unindexed rotating log file — see
Non-goals) or reading any external client's own config file to detect
"is this workspace currently referenced." Both would produce a
false-confidence signal dressed up as a product decision. The archive
warning states what *will happen going forward*, which is unconditionally
true once admission enforcement lands — it needs no evidence about the
past.

## Testing

- **`mcp-workspace-binding.test.ts`** (new): `resolveMcpWorkspaceBinding()`
  returns `{kind: "unbound"}` for an absent, empty, or whitespace-only
  `SYNAPSE_MCP_WORKSPACE`; `{kind: "bound", workspaceId}` (trimmed)
  otherwise.
- **`mcp-launch-descriptor.test.ts`** (new): `buildMcpLaunchDescriptor()`
  always includes `SYNAPSE_MCP_WORKSPACE` and `SYNAPSE_USER_DATA_DIR` in
  `env`; `resolveMcpExecutablePath()` returns `process.env.APPIMAGE` when
  set and `process.platform === "linux"`, and `process.execPath` in every
  other case (parameterize `process.platform`/`process.env` as injectable
  for the test, not read live).
- **`synapse-mcp-server.test.ts`**: for each of `listTools`, `callTool`,
  `listResources`, `readResource` independently — `unbound` rejects with
  the migration message; an unknown workspace id rejects with the
  not-found message; an archived workspace id rejects with the archived
  message; an active workspace id behaves exactly as it does today
  (regression — the existing pre-S08 tests for these four methods must
  keep passing unchanged once a `workspaceStore` fake resolving `isActive:
  true` is threaded through). A dedicated test asserts `callTool()`
  targeting `memory_search` is rejected for an archived workspace **even
  when `listTools()` was called first and returned successfully** — the
  cached-tool-list regression the "re-check independently at every entry
  point" design exists to close.
- **`stdio-entry` integration** (if this file has a test harness; if not,
  covered at the `synapse-mcp-server.ts` unit level and via manual
  verification — see Completion criteria): a headless server constructed
  with `SYNAPSE_MCP_WORKSPACE` unset behaves as `unbound` end-to-end.
- **Renderer**: the new "Connect an MCP client" panel's generate-config
  action renders the exact JSON shape above with a copy button (test
  asserts clipboard write, not that the browser actually receives it —
  matching this codebase's existing copy-button test convention); the
  test-connection action shows success/failure states from a mocked IPC
  response, including the "zero tools, zero resources still counts as
  success" case explicitly (a regression test for the "count > 0" pitfall
  called out in Architecture).
- **`workspace-settings.test.tsx`**: gains a case asserting the workspace
  `id` renders per row (it doesn't today); a companion asserts the archive
  button now opens a confirmation dialog before calling `archiveAiWorkspace`
  (today it's a bare, unconfirmed click).

## Non-goals

- **No reading or writing of any external application's config file.**
  Claude Desktop's `claude_desktop_config.json` (or Codex's config) is
  never read to detect existing references, and never written to inject a
  new entry — both directions are out of scope. Detecting "does a saved
  config reference this workspace" would only ever cover Claude Desktop
  specifically (not other MCP clients), "config exists" doesn't mean
  "currently in use," and reading another application's config file
  crosses a privacy boundary this spec doesn't need to cross to solve the
  real problem (see Architecture's admission enforcement).
- **No Codex CLI config generation.** Claude Desktop's `mcpServers` JSON
  shape is the only one this spec generates. `McpLaunchDescriptor` is
  generic enough that a second serializer could consume it later without
  re-deriving the launch mechanics, but writing that serializer is
  deferred.
- **No scanning of `host-resource-audit.ts` or any other log to infer past
  MCP access**, for the archive-time warning or anything else. Confirmed
  during review: that log only covers `workspace-instructions` resource
  reads, not `memory` resource/tool access, and has no index — a scan
  would produce evidence that's neither complete (memory access is
  invisible to it) nor conclusive (finding nothing doesn't mean nothing
  happened; old entries may have rotated out).
- **No Synapse-owned "connection profile" / `lastSeenAt` telemetry.** A
  real, defensible future feature (a small state store recording when a
  generated config was created and, ideally, updated by an actual MCP
  handshake reaching the workspace — not by guessing from logs or external
  files) but independently scoped, not required to make the four pieces
  above work.
- **No change to `memory-scope.ts`'s existing `includeGlobal` default**
  or to how `bound`-and-active connections behave — this spec only adds a
  gate in front of the existing behavior for `unbound`/unknown/archived
  states; a normally-bound, active-workspace MCP connection's actual tool/
  resource results are completely unchanged.
- **No `credentials:broker`-style capability/consent model for MCP
  workspace binding.** Binding is determined entirely by the
  `SYNAPSE_MCP_WORKSPACE` env var an external process sets for itself —
  there's no plugin, no trigger, no grant to request; this is the host's
  own boundary enforcement, not a capability a third party declares.

## Completion criteria

- `resolveMcpWorkspaceBinding()` replaces the `"external"` sentinel;
  `stdio-entry.ts` and every caller of the workspace id it used to produce
  are updated to the new `McpWorkspaceBinding` type — no remaining
  reference to the literal string `"external"` as a workspace id anywhere
  in `src/main/mcp`.
- All four `SynapseMcpToolService` entry points (`listTools`, `callTool`,
  `listResources`, `readResource`) independently reject `unbound`/unknown/
  archived workspace bindings with the three distinct, actionable
  messages in Architecture — verified by tests that exercise each method
  directly, including the cached-tool-list-then-archived regression.
- `buildMcpLaunchDescriptor()` is the single function both the config-
  generation IPC handler and the connection-test IPC handler call —
  verified by there being exactly one call site for `resolveMcpExecutablePath()`
  in the codebase.
- The generated Claude Desktop config snippet is copyable from a new
  Settings panel, never auto-written to any file; a packaged build
  resolves a real, stable executable path (including the AppImage case on
  Linux); a dev build shows the informational "packaged install only"
  note instead of presenting an unstable path as usable.
- "Test connection" uses the real `@modelcontextprotocol/sdk` `Client`/
  `StdioClientTransport`, always closes the client/kills the child
  process (success, failure, or timeout), and reports success purely on
  protocol completion, never on tool/resource count.
- `workspace-settings.tsx` shows each workspace's id and root count; the
  archive action requires confirmation, whose copy states the guaranteed
  post-S08 consequence for MCP access.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.
- Manual verification: a real Claude Desktop (or another real MCP client)
  configured via the generated snippet against a real active workspace
  successfully lists tools/resources; the same config against a workspace
  archived afterward gets the archived-workspace error on the next
  request; a config with `SYNAPSE_MCP_WORKSPACE` deliberately unset gets
  the unbound migration error.

## Parked questions

- Codex CLI config generation — deferred (Non-goals); revisit once Codex's
  MCP config schema is confirmed stable enough to commit to a serializer.
- Synapse-owned connection-profile tracking with real `lastSeenAt`
  telemetry (updated by an actual MCP handshake touching the workspace,
  not by inference) — a genuinely good idea raised during review, not
  required for S08, not yet assigned a spec number.
- Extending `host-resource-audit.ts` (or a sibling log) to also cover
  `memory` resource/tool access from external MCP clients — valuable for
  forensics/future Observatory-style tooling, explicitly *not* a
  prerequisite for anything in this spec (the archive warning no longer
  depends on audit evidence at all, per Architecture).
- Whether the "Connect an MCP client" panel should also surface *other*
  workspaces' generated configs in one place (a dedicated "MCP" settings
  page) rather than per-workspace-row was not raised during brainstorming;
  this spec assumes per-workspace placement inside `workspace-settings.tsx`,
  final layout is an implementation-plan decision.
