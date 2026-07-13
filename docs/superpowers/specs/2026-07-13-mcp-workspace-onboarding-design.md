# S08 — MCP Workspace Onboarding

> Date: 2026-07-13 · Status: draft, pending review
> Third spec of Phase 3 ("先可观察，再扩权") in the four-phase, ten-spec
> roadmap (S01-S10), depending on S05 (Workspace Lifecycle, merged —
> `archived`/`isActive()`) and building on the MCP resources surface added
> alongside S04-era work. Full roadmap status tracked in project memory
> `s01-s10-roadmap-status.md`.

## Why this is needed

Verified against the real repo, not assumed.

- **Nothing in the renderer's workspace *list* shows a workspace's id, and
  root status isn't summarized there either — corrected during review.**
  `workspace-settings.tsx` (the only workspace-related Settings UI,
  mounted at `settings-page.tsx:18`) renders `w.name` and archived/active
  status with rename/archive/unarchive controls — the workspace `id`
  itself is never displayed anywhere. Root status is a narrower gap than
  first drafted: `workspace-root-manager.tsx:90-106` is a real, existing
  per-workspace dialog that already lists each root's name, path, and
  primary badge — but nothing in `workspace-settings.tsx`'s row-per-
  workspace list *summarizes* that (a count, or an inline "no roots yet")
  without the user opening that separate dialog first. A user connecting
  an external MCP client has no way to look up the exact id
  `SYNAPSE_MCP_WORKSPACE` needs without leaving the app entirely.
- **No config generation, no user-visible example config exists
  anywhere — corrected during review.** `TESTING.md:110-114` has a
  checklist bullet ("Configure an external client ... to launch `Synapse
  --mcp-stdio`") with no JSON snippet, no documented executable path, no
  env-var example — that part of the original claim holds. But a broader
  search shows `SYNAPSE_MCP_WORKSPACE`/`--mcp-stdio` referenced across
  numerous internal `docs/superpowers/specs|plans/*.md` design documents —
  those aren't user-facing, but the original "found nothing but TESTING.md"
  framing overstated the gap. The accurate claim: no README, no docs-site
  page, and no in-app surface shows a real, copyable config example.
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

### Headless tool-serving mode — a real P0 found during review

**Confirmed during review, not assumed: both the real external-MCP path
and this spec's own connection tester would otherwise start a second full
background-trigger runtime as a side effect of just serving tools.**
`stdio-entry.ts:102`'s `await pluginHost.init()` runs the *entire* normal
`PluginHost.init()` (`plugin-host.ts:316-363`), which unconditionally:
- calls `this.syncTriggerRegistrations()` (line 349), registering every
  active plugin's timer/cron/fs-watch/hotkey/clipboard triggers into a
  live `TriggerRegistry` — real OS-level watchers and timers start firing;
- calls `this.credentialBroker.armOAuthTimers(...)` for every plugin with
  a manifest (lines 350-358) — real OAuth token-refresh timers start;
- calls `this.syncClipboardWatcher()` in a `finally` block (line 361).

None of this is needed to serve `tools/list`/`tools/call`/`resources/list`/
`resources/read` to an external MCP client — it's the *interactive-agent*
plugin lifecycle, pulled in incidentally because `stdio-entry.ts` reuses
the same `PluginHost.init()` the GUI uses. This is a real, pre-existing
gap for every long-lived external MCP connection today (each one silently
runs a second, redundant trigger engine for its entire lifetime) — but
this spec's "Test connection" button would make it acute: every click
would start-then-tear-down real timers/watchers/OAuth refresh cycles,
repeatedly, as a side effect of a read-only diagnostic action.

**Fix**: `PluginHost.init()` gains a mode parameter:

```ts
async init(options?: { mode?: "full" | "tools-only" }): Promise<void>
```

`"tools-only"` (the new default for headless MCP contexts) skips
`syncTriggerRegistrations()`, `armOAuthTimers()`, and
`syncClipboardWatcher()` entirely, while still doing everything tool
serving actually needs: `discoverPlugins()`, `registry.load()`, grant
migration. `"full"` (the existing behavior, unchanged) stays the default
for the GUI's own `PluginHost` construction — the interactive path still
needs triggers and OAuth timers.

Both real consumers switch to `"tools-only"`:
- `stdio-entry.ts:102` — every external MCP connection, not just the
  connection tester, since there's no legitimate reason a *tool-serving*
  stdio process should be running background triggers at all. This
  incidentally fixes the pre-existing duplicate-trigger-runtime issue
  above as a side effect of this spec, not just for the new test button.
- The connection tester (below) — for the same reason, doubly so, since
  it's specifically meant to be a fast, side-effect-free, repeatable check.

Whether `syncClipboardWatcher()` has any effect needed by an *on-demand*
clipboard-adjacent tool call (as opposed to a *clipboard-change trigger*,
which `"tools-only"` deliberately doesn't register) is an implementation-
plan-level question to verify against `PluginBridge`'s clipboard read path
before assuming it's safe to skip — flagged here, not resolved, since it
requires reading code this spec doesn't need to settle its own scope.

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

A new `assertWorkspaceAdmitted(binding, port)` is called **independently
at all four `SynapseMcpToolService` entry points** — `listTools()`,
`callTool()`, `listResources()`, `readResource()`
(`synapse-mcp-server.ts:106,141,194,227`) — not layered only onto the
resource handlers, and not skipped for `tools/list` on the theory that
`tools/call` will catch it: a client may cache its tool list before a
workspace is archived mid-session, so `tools/call` must re-check
independently even if `tools/list` already did.

**`port` is `Pick<WorkspaceStore, "get">`, not `isActive()`/`exists()`**
— corrected during review: `WorkspaceStore.isActive(id): Promise<boolean>`
alone can't distinguish "unknown" from "archived" (both resolve `false`),
which this spec needs to produce two different error messages. `get(id):
Promise<Workspace | undefined>` (`workspace-store.ts:31-33`, already
resolves archived workspaces, confirmed in "Why this is needed") is the
right shape — one call per entry-point invocation, no second read, no
TOCTOU window between an existence check and an active check:

```ts
async function assertWorkspaceAdmitted(
  binding: McpWorkspaceBinding,
  workspaces: Pick<WorkspaceStore, "get">
): Promise<void> {
  if (binding.kind === "unbound") throw new McpUnboundError()
  const workspace = await workspaces.get(binding.workspaceId)
  if (!workspace) throw new McpWorkspaceNotFoundError(binding.workspaceId)
  if (workspace.archived) throw new McpWorkspaceArchivedError(binding.workspaceId)
}
```

| Binding state | Behavior |
|---|---|
| `unbound` | `initialize` completes; `tools/list`/`tools/call`/`resources/list`/`resources/read` all reject with a migration error (below) |
| `bound`, workspace unknown | Reject: `Workspace "<id>" was not found. Re-copy the configuration from Synapse → Settings → Workspaces.` |
| `bound`, workspace archived | Reject: `Workspace "<id>" is archived. Unarchive it in Synapse, or update SYNAPSE_MCP_WORKSPACE to a different workspace.` |
| `bound`, workspace active | Proceed normally — unchanged from today |

The `unbound` migration error is also written to stderr **at most once
per process**, not on every rejected request — an MCP client that polls
`tools/list` on an unbound connection would otherwise flood its own log
with an identical message on every poll:

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

**Serialization is its own pure function**, unit-testable independent of
IPC/clipboard plumbing (see the `synapse-<workspace-name-slug>` fix below
for why a stable key matters here too):

```ts
export function serializeClaudeDesktopConfig(
  descriptor: McpLaunchDescriptor,
  serverKey: string
): string {
  return JSON.stringify(
    { mcpServers: { [serverKey]: descriptor } },
    null,
    2
  )
}
```

`JSON.stringify` on a Windows path (e.g. `C:\Program Files\Synapse\
Synapse.exe`) already produces correctly-escaped `\\` sequences inside the
resulting string — no manual escaping needed, only a test asserting that
property explicitly (see Testing), since a naive future refactor to
template-string interpolation could silently reintroduce broken escaping.

### Process-tree teardown — a real gap found during review

**Confirmed during review**: launching `command: resolveMcpExecutablePath()`
(the packaged app binary) with `args: ["--mcp-stdio"]` does not directly
start the MCP server — it starts a *second* level of indirection.
`index.ts:1158-1169`'s `reExecMcpStdioAsNode()` (triggered by the packaged
binary detecting its own `--mcp-stdio` flag) `spawn()`s a **grandchild**
Node process running `mcp-stdio.js`, with `stdio: "inherit"` — the
grandchild inherits the *outer* process's stdin/stdout, and only the outer
process's `exit` event (line 1164) triggers `app.exit()`. The SDK's
`StdioClientTransport`/`Client.close()` (used by both `mcp-stdio-client.ts`
today and this spec's connection tester) only ever holds a handle on the
**outer** process — it spawned that one, not the grandchild.

In the common case (clean shutdown: the transport closes stdin, the
grandchild's MCP `server.onclose` fires, `stdio-entry.ts:128-136`'s
`shutdown()` runs, the grandchild exits, the outer process's `exit`
handler relays that into `app.exit()`) this already works correctly
end-to-end. **The gap is the forced-kill path**: if the connection test's
overall timeout expires and the SDK sends a termination signal to the
*outer* process directly (bypassing the clean-shutdown handshake), nothing
today guarantees the **grandchild** also terminates — Windows processes
have no implicit parent-child kill propagation without an explicit Job
Object, which nothing here sets up.

**Fix, required for this spec's "always kills the child" claim to be
true, not just usually true**: `reExecMcpStdioAsNode()` gains explicit
signal-forwarding — the outer process relays `SIGTERM`/`SIGKILL` (or the
Windows-equivalent forced termination the Node `child_process` API maps
these to) to the grandchild's PID before exiting, rather than relying
solely on the inherited-stdio EOF path. A new integration test exercises
the **real, public `--mcp-stdio` path** (not the SDK's abstraction over
it) end-to-end: launch it, forcibly terminate the outer process, assert
the grandchild's PID is no longer running shortly after — this is the
only way to actually prove the fix, since a unit test against
`reExecMcpStdioAsNode()` in isolation can't observe a real OS process tree.

### Renderer — workspace id/root visibility

`workspace-settings.tsx`'s per-workspace row gains: the `id` (monospace,
copyable), and a **root summary** — count plus root names and which one is
primary (restoring the original brainstorming intent; an earlier draft of
this spec narrowed this to a bare count without saying so, which
undersold `workspace-root-manager.tsx`'s existing per-root detail without
actually reusing it). `0 roots` renders plainly — rootless is a
first-class, tested, intentional state per
`docs/superpowers/specs/2026-07-10-workspace-root-unification-design.md:85-88`
and `workspace-instructions-resource.test.ts:77-85`, not an error state to
warn about. The existing `workspace-root-manager.tsx` dialog remains the
place to actually add/remove/reprioritize roots — this summary is a
read-only preview in the list row, not a replacement for it.

### Renderer — "Connect an MCP client" panel

A new per-workspace panel (new component, composed into `workspace-
settings.tsx`'s row or a details expansion — exact placement is an
implementation-plan decision, not a spec-level one) with two actions,
gated by an explicit state matrix rather than one branch per action —
**corrected during review**, since the first draft's "dev mode still
generates something, with a caveat" and the Completion criteria's "don't
present an unstable path as usable" were pulling in different directions:

| Build / workspace state | Generate config | Test connection |
|---|---|---|
| Packaged, workspace active | Enabled | Enabled |
| Packaged, workspace archived | Disabled — row shows id/roots, with a prompt to unarchive first | Disabled, same prompt |
| Unpackaged dev build | Disabled entirely — informational note only ("config generation and connection testing require a packaged build") | Disabled entirely, same note |

A dev build's `resolveMcpExecutablePath()` would resolve the dev Electron
binary's path, which is neither stable across runs nor what launching
`--mcp-stdio` against it actually does in a dev harness (`--mcp-stdio`
alone, without the dev server's own argv conventions, isn't guaranteed to
behave like the packaged entrypoint) — so dev mode shows *nothing*
copyable rather than a snippet that looks legitimate but likely isn't.

1. **Generate config** — calls a new IPC method that runs
   `buildMcpLaunchDescriptor(workspaceId, userDataDir)` in the main
   process and serializes it via `serializeClaudeDesktopConfig()`:
   ```json
   {
     "mcpServers": {
       "synapse-<workspace id>": {
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
   **The server key is `synapse-<workspace id>`, not a name-derived
   slug** — corrected during review: `Workspace.rename()` (S05) means a
   name-based slug isn't stable, and two differently-named workspaces
   could collide on the same slugified string; `id` is already the one
   value this codebase guarantees unique per workspace. Rendered in a
   read-only code block with a copy-to-clipboard button. **Never written
   to any file on disk** — Claude Desktop's own config file is a
   different application's data; reading or writing it is out of scope
   (see Non-goals).
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
   the child on expiry (see "Process-tree teardown" above for why this
   requires a fix to `reExecMcpStdioAsNode()`, not just calling
   `client.close()`). **Success means the three protocol steps completed
   without throwing — not that tool/resource counts are non-zero.** A
   legitimate, active, rootless workspace with no enabled plugins can have
   zero tools and zero resources; that must report success, not failure.
   Failure surfaces the real thrown error (including this spec's new
   `unbound`/unknown/archived admission errors verbatim, so "test
   connection" doubles as the fastest way to see *why* a config doesn't
   work).

### IPC security contract for the two new channels

**Corrected during review — the first draft only said "a new IPC
method," which isn't precise enough for a feature that spawns real
processes on the renderer's request.** Both channels live in a new
`src/main/ipc/mcp-onboarding.ts`, following this codebase's established
`guard(event, channel)` + typed-argument-validation pattern:

- **The renderer sends only `{ workspaceId: string }`.** `command`,
  `args`, `env`, and the connection-test timeout are never accepted from
  the renderer — both handlers call `buildMcpLaunchDescriptor()`
  server-side using the main process's own resolved `userDataDir`, so a
  compromised or buggy renderer cannot redirect either action into
  spawning an arbitrary command.
- Both handlers sit behind the existing trusted-sender guard, and reject
  a non-string/empty `workspaceId` the same way every other `ai:*`/
  `plugin:*` handler in this codebase does (`requireString`-equivalent).
- The main process re-resolves the workspace from `WorkspaceStore` itself
  (not trusting any workspace metadata the renderer might pass) before
  building the descriptor — the same freshness discipline S05/S07 already
  established for other host-owned mutating/spawning operations.
- **At most one connection test may be in flight at a time**, tracked by
  a main-process module-level flag (or a small in-memory registry keyed
  by workspaceId, if testing two different workspaces concurrently is
  judged worth allowing — an implementation-plan decision); a second
  `plugin:test-mcp-connection`-equivalent call while one is running
  rejects immediately rather than spawning a second process. The renderer
  additionally disables the "Test connection" button while a request is
  in flight, so this is defense in depth, not the only guard.
- Preload (`index.ts`/`index.d.ts`) exposes both channels with the exact
  `{ workspaceId: string }` argument shape; `lib/electron.ts` wraps them
  following the established `unwrapIpcResult()` pattern.

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
  the migration message; an unknown workspace id (fake `get()` resolving
  `undefined`) rejects with the not-found message; an archived workspace
  id (fake `get()` resolving `{id, archived: true}`) rejects with the
  archived message; an active workspace id (fake `get()` resolving
  `{id, archived: undefined}`) behaves exactly as it does today —
  regression, the existing pre-S08 tests for these four methods must keep
  passing unchanged once a `Pick<WorkspaceStore, "get">` fake is threaded
  through (not an `isActive` fake — corrected during review, see
  Architecture). **The cached-tool-list regression, precise sequence**
  (corrected during review — the first draft's wording contradicted the
  four-independent-checks design it was supposed to test): (1) the fake
  store resolves the workspace as active; (2) `listTools()` is called and
  succeeds; (3) the *same fake store* is mutated to resolve the workspace
  as archived; (4) `callTool()` targeting `memory_search` is called next
  and is rejected — proving the check re-reads live state on every call
  rather than trusting whatever `listTools()` observed earlier.
- **`headless-tools-only mode` regression** (new, `plugin-host.test.ts` or
  a sibling): `PluginHost.init({ mode: "tools-only" })` never calls
  `triggerRegistry.register`/an equivalent trigger-registration seam, and
  never arms an OAuth refresh timer, for a plugin manifest that declares
  both — asserted via spies on the relevant seams, not by waiting to see
  if a timer fires. `PluginHost.init()` (no options, or `{mode: "full"}`)
  continues to do both — regression proving the GUI's own interactive path
  is unaffected.
- **Process-tree teardown integration test** (new, real process spawn —
  not mocked): launch the real public `--mcp-stdio` path via
  `reExecMcpStdioAsNode()`'s actual mechanism, forcibly terminate the
  outer process, assert the grandchild `mcp-stdio.js` process is no longer
  running shortly after. This is the only way to prove the signal-
  forwarding fix actually closes the gap — a unit test mocking
  `child_process.spawn` cannot observe a real OS process tree.
- **`mcp-onboarding.ts` IPC handler tests** (new): rejects an untrusted
  sender for both channels; rejects a non-string/empty `workspaceId`;
  **the renderer cannot influence `command`/`args`/`env`** — a test
  submits a payload with extra fields (`{workspaceId, command: "evil"}`)
  and asserts the resulting `McpLaunchDescriptor` used to spawn the test
  process is built purely from `buildMcpLaunchDescriptor(workspaceId,
  realUserDataDir)`, never reading the injected `command` field; a second
  connection-test call while one is already in flight for any workspace
  is rejected without spawning a second process (asserted via a spy on
  the spawn seam counting exactly one invocation).
- **`serializeClaudeDesktopConfig()` test** (new): a descriptor whose
  `command` contains a Windows-style path with backslashes
  (`C:\Program Files\Synapse\Synapse.exe`) round-trips through
  `JSON.parse(serializeClaudeDesktopConfig(...))` back to the exact
  original string — the explicit regression for "don't reintroduce broken
  escaping via a future template-string refactor." The server key is
  asserted to be exactly `synapse-<workspace id>`, not derived from
  `name`.
- **Renderer state-matrix test** (`workspace-settings.test.tsx` or the new
  panel's own test file): all three rows of the Build/workspace-state
  table above are exercised — packaged+active enables both buttons,
  packaged+archived disables both with the unarchive prompt, dev-mode
  (mocked via whatever seam the renderer already uses to detect packaged
  vs. dev, e.g. an existing `isElectron()`/environment flag) disables both
  with the informational note, never rendering a copyable snippet in that
  state.
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
  `id` and a root summary (count + names/primary indicator, not a bare
  count) render per row (neither does today); a companion asserts the
  archive button now opens a confirmation dialog before calling
  `archiveAiWorkspace` (today it's a bare, unconfirmed click).

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
- `PluginHost.init()` accepts `{ mode?: "full" | "tools-only" }`;
  `"tools-only"` skips trigger registration, OAuth timer arming, and
  clipboard watching, verified by spy-based regression tests; both
  `stdio-entry.ts` and the new connection tester use `"tools-only"`; the
  GUI's own construction is unaffected and keeps using `"full"`.
- All four `SynapseMcpToolService` entry points (`listTools`, `callTool`,
  `listResources`, `readResource`) independently reject `unbound`/unknown/
  archived workspace bindings with the three distinct, actionable
  messages in Architecture, using a single `Pick<WorkspaceStore, "get">`
  read per call (not `isActive()`/`exists()`) — verified by tests that
  exercise each method directly, including the cached-tool-list-then-
  archived regression's exact four-step sequence.
- `buildMcpLaunchDescriptor()` is the single function both the config-
  generation IPC handler and the connection-test IPC handler call —
  verified by there being exactly one call site for `resolveMcpExecutablePath()`
  in the codebase. `serializeClaudeDesktopConfig()` produces a
  `synapse-<workspace id>` server key and correctly escapes Windows paths
  through a real `JSON.parse` round-trip test.
- The Build/workspace-state matrix (packaged+active, packaged+archived,
  dev) gates both "Generate config" and "Test connection" exactly as
  specified — never showing a copyable snippet in dev mode, never enabling
  either action for an archived workspace.
- The generated Claude Desktop config snippet is copyable from a new
  Settings panel, never auto-written to any file; a packaged build
  resolves a real, stable executable path (including the AppImage case on
  Linux).
- "Test connection" uses the real `@modelcontextprotocol/sdk` `Client`/
  `StdioClientTransport`, reports success purely on protocol completion
  (never on tool/resource count), and genuinely always terminates the
  full process tree it started — success, failure, or timeout — verified
  by a real-process integration test against the public `--mcp-stdio`
  path, not just a unit test of the SDK call.
- The new `src/main/ipc/mcp-onboarding.ts` channels accept only
  `{ workspaceId }` from the renderer, re-resolve the workspace server-
  side, sit behind the trusted-sender guard, and reject a second
  concurrent connection test rather than spawning a second process.
- `workspace-settings.tsx` shows each workspace's id and a root summary
  (count plus names/primary indicator); the archive action requires
  confirmation, whose copy states the guaranteed post-S08 consequence for
  MCP access.
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
