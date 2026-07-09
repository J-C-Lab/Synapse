# MCP-Client-Side Roots

> Date: 2026-07-09 · Status: draft, pending review (revised after code review —
> see "Revision note" below)
> Follow-up to the roots non-goal parked by the mcp-resources-phase1 spec
> (§7: *"Roots (MCP-client side) — `mcp-client-manager.ts` declaring
> `executionWorkspaces()` as roots to external servers Synapse calls out to.
> Structurally separate from this spec (client vs. provider); own
> follow-up."*). Decided by user Q&A on 2026-07-09 (see the
> `synapse-platform-positioning` memory).

**Revision note:** the first draft said "workspace" throughout and assumed a
main-process "active workspace" concept exists. Code review caught both as
wrong: `Workspace` (`workspace-store.ts:4-8`) is `{id, name, createdAt}` —
**no path field at all**. The thing that actually has a filesystem path is
`WorkspaceRoot` (`execution/types.ts:1-4`, `{id, root}`), derived from the
`agentShellRoots` **setting** (off by default) via `deriveExecutionWorkspaces`
— a completely separate id space from `WorkspaceStore`, unrelated to
conversation-level "workspace" the chat UI shows. And "active workspace" is a
renderer-only `useState` in `chat-page.tsx`; there is no main-process
equivalent for `McpServerConfigStore` (a single global list, workspace-
agnostic) to read at config-creation time. Rewritten below to use
`WorkspaceRoot`/execution-root ids throughout, and to drop the "default on,
seeded from active workspace" behavior entirely (see §"Default policy").

## Why this exists

This is the opposite direction from Axis C's provider-side work
(`synapse-mcp-server.ts` exposing Synapse *to* external callers): this is
Synapse's own `mcp-client-manager.ts` — Synapse *consuming* external MCP
servers for its internal agent — declaring its own `roots` outward, per the
MCP spec's client-declared-capability (`roots/list`, confirmed absent from
`ServerCapabilitiesSchema`; it is a client thing). Concretely motivated: the
user has a specific external filesystem-flavored MCP server in mind that
uses `roots` to scope which directories it will operate on — without
`roots`, Synapse can't tell it.

## Goal (this slice)

For each configured external MCP server, Synapse's client optionally
advertises one or more `WorkspaceRoot.root` paths (i.e. **execution roots**,
the `agentShellRoots`-derived list — the only local directories Synapse's
own settings model already treats as "the assistant may touch these") as MCP
`roots`, and keeps them live via `roots/list_changed` whenever the
underlying `agentShellRoots` setting changes.

## Default policy: always off, always explicit

Both `stdio` and `http` servers default to **no roots advertised**. The
transport-based "stdio defaults on" idea from the first draft is dropped —
it depended on a main-process "active workspace" that doesn't exist, and
inventing one just to seed a default would be new state built solely to
serve this feature, not a real product need. The user explicitly selects
which execution root(s) (if any) a given server sees, per server, at
creation or edit time. This is simpler to reason about, requires zero new
cross-layer coupling, and matches how `agentShellRoots` itself already
works (off by default, explicit list, no smart default).

## Non-goals (explicitly deferred)

- **Reporting all execution roots unconditionally.** An external server
  should only see what a given connection was actually meant to touch, not
  every root the user has ever configured. Selection is per-server.
- **A generic "workspace visibility" concept shared with provider-side
  exposure** (memory resources). Client-side roots (this spec) and
  provider-side resource scoping solve different problems — what Synapse
  tells an outbound server vs. what Synapse lets an inbound caller read —
  and are kept as separate mechanisms. They now happen to share the same
  underlying `WorkspaceRoot` data source, but that's incidental, not a
  shared control surface.
- **Any coupling to `WorkspaceStore`/conversation-level workspace.** Fully
  decoupled after this revision — see "Revision note" above.

## 1. Data model

Extend `McpServerConfig` (`mcp-server-config-store.ts`):

```ts
export interface McpServerConfig {
  // ...existing fields unchanged...
  /** Execution root ids (WorkspaceRoot.id, from agentShellRoots — NOT
   *  WorkspaceStore ids) to advertise as MCP roots to this server.
   *  Omitted/empty = no roots capability advertised at all (default for
   *  every server, every transport — see "Default policy"). */
  exposedExecutionRootIds?: string[]
}
```

No default-population logic anywhere — the store persists exactly what it's
given, `undefined`/`[]` unless the user explicitly sets it.

## 2. Client-side wiring (`mcp-client-manager.ts`)

`McpClientPort` (currently a minimal hand-rolled slice of the real SDK
`Client`) needs two additions:

1. At `connect()` time, if `exposedExecutionRootIds` is non-empty, declare
   `capabilities: { roots: { listChanged: true } }` and register a
   `roots/list` request handler that returns
   `{ uri: "file://<root>", name: <executionRootId> }[]`, resolved against
   the live `executionWorkspaces()` output (not cached) for the configured
   ids. If `allowAgentShell` is off, `executionWorkspaces()` already returns
   `[]` (existing behavior in `index.ts`), so a configured-but-now-invalid
   root id simply resolves to nothing rather than erroring.
2. A `notifyRootsChanged(serverId)` method the connection layer calls
   whenever `agentShellRoots`/`allowAgentShell` changes (hook into the
   existing settings-change broadcast — the same one the title-bar theming
   work listens on for `settings:update`) — sends
   `notifications/roots/list_changed` to every **connected**, **roots-
   enabled** server. Servers not currently connected pick up the new roots
   naturally on their next `connect()`.

## 3. Settings/config UI surface

The per-server MCP config entry (wherever `McpServerConfig` is edited today)
gains, only when `agentShellRoots` is non-empty (nothing to select
otherwise):

- A roots on/off toggle, off by default for every server/transport.
- An execution-root multi-select, populated from `executionWorkspaces()`,
  no pre-selection.

No global kill switch — per-server configuration is the only control
surface.

## 4. Testing strategy

- **`mcp-client-manager.test.ts`**: extend the fake `McpClientPort` to
  capture what capabilities/roots-handler it was constructed with; assert
  no server (any transport) advertises roots unless explicitly configured;
  assert `roots/list` returns exactly the configured execution-root ids'
  paths, resolved live against `executionWorkspaces()` (not a stale
  snapshot); assert a configured id that no longer resolves (root removed
  from `agentShellRoots`, or `allowAgentShell` turned off) returns `[]` for
  that entry rather than throwing; assert `notifyRootsChanged` only reaches
  connected + roots-enabled servers.
- **`mcp-server-config-store.test.ts`**: extend for
  `exposedExecutionRootIds` persistence — no default-population test needed
  since there is no default-population logic to test.

## 5. Parked questions (surfaced, not solved)

- **Multiple simultaneous roots per server** — the data model supports a
  list; UX for selecting several wasn't walked through in detail, likely
  fine as a plain multi-select.
- **Live resolution semantics when a root id briefly doesn't resolve**
  (`allowAgentShell` toggled off and back on, or `agentShellRoots` edited)
  — returning `[]` for that id is the simplest rule and is what's specified
  above; revisit only if this proves confusing in practice.
